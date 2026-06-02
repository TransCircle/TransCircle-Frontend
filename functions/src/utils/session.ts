import { queryOne, exec } from '../Database';
import { ulid } from './ulid';
import { conf } from '../Config';

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_TOKEN_BYTES = 32;
const SESSION_SECRET = ((conf.SESSION as Record<string, string | undefined>)?.SESS_SECRET) || 'default-secret-change-me';

function randomToken(): string {
  const buf = crypto.getRandomValues(new Uint8Array(REFRESH_TOKEN_BYTES));
  return Array.from(buf).map(b => b.toString(36).padStart(2, '0')).join('');
}

/** HMAC-SHA256 for security-sensitive token hashing (per api.md §1). */
async function hmacToken(data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** SHA-256 for non-security fingerprinting (IP/UA). */
async function sha256(data: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export interface SessionInfo {
  id: string;
  userId: string;
  tokenVersion: number;
  isAdmin: boolean;
  loginMethod: string;
}

/**
 * Create a new session with refresh token for a user.
 * Returns the session record info and the raw refresh token string.
 */
export async function createSession(
  userId: string,
  isAdmin: boolean,
  loginMethod: string,
  ip: string,
  ua: string,
  _tokenVersion: number,
): Promise<{ sessionId: string; refreshToken: string }> {
  const sessionId = ulid();
  const refreshToken = randomToken();
  const tokenPrefix = refreshToken.slice(0, 8);
  const [tokenHash, ipHash, uaHash] = await Promise.all([
    hmacToken(refreshToken),
    sha256(ip || 'unknown'),
    sha256(ua || 'unknown'),
  ]);
  const ipPrefix = (ip || 'unknown').split('.').slice(0, 3).join('.') + '.0';
  const now = Date.now();

  void _tokenVersion;

  await exec(
    `INSERT INTO sessions (id, userId, createdAt, lastUsedAt, expiresAt, ipHash, ipPrefix, userAgentHash, loginMethod)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, userId, now, now, now + SESSION_MAX_AGE, ipHash, ipPrefix, uaHash, loginMethod],
  );

  await exec(
    `INSERT INTO refresh_token_events (id, sessionId, tokenHash, tokenPrefix, status, createdAt)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    [ulid(), sessionId, tokenHash, tokenPrefix, now],
  );

  return { sessionId, refreshToken };
}

/**
 * Verify and rotate a refresh token.
 * Returns null on invalid/reused token.
 *
 * Atomic rotation: UPDATE ... WHERE status='active' eliminates the
 * TOCTOU race between checking status and marking as rotated.
 */
export async function rotateRefreshToken(
  rawToken: string,
): Promise<SessionInfo | null> {
  const [tokenHash] = await Promise.all([hmacToken(rawToken)]);
  const prefix = rawToken.slice(0, 8);

  const event = await queryOne(
    `SELECT id, sessionId, status, rotatedToHash
     FROM refresh_token_events
     WHERE tokenHash = ? AND tokenPrefix = ?`,
    [tokenHash, prefix],
  );

  if (!event) return null;

  const now = Date.now();
  const newToken = randomToken();
  const [newHash] = await Promise.all([hmacToken(newToken)]);
  const newPrefix = newToken.slice(0, 8);

  // ── Atomic claim: only 'active' tokens can be rotated ──────
  // If two requests race, the first UPDATE wins (affectedRows === 1).
  // The loser falls through to the reuse/theft-detection path.
  const claimed = await exec(
    `UPDATE refresh_token_events
     SET status = 'rotated', rotatedToHash = ?, usedAt = ?
     WHERE id = ? AND status = 'active'`,
    [newHash, now, event.id],
  );

  if (claimed.affectedRows === 1) {
    // This request won the race — token is atomically ours.
    const session = await queryOne(
      `SELECT s.id, s.userId, s.expiresAt, s.revokedAt, u.tokenVersion, u.isAdmin
       FROM sessions s
       JOIN users u ON u.id = s.userId
       WHERE s.id = ?`,
      [event.sessionId],
    );

    if (!session || session.revokedAt || session.expiresAt < now) {
      // Session already gone — revoke the rotated token
      await exec(
        `UPDATE refresh_token_events SET status = 'revoked' WHERE tokenHash = ?`,
        [newHash],
      );
      return null;
    }

    // Insert new active token event
    await exec(
      `INSERT INTO refresh_token_events (id, sessionId, tokenHash, tokenPrefix, status, createdAt)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [ulid(), event.sessionId, newHash, newPrefix, now],
    );

    await exec(
      `UPDATE sessions SET lastUsedAt = ? WHERE id = ?`,
      [now, event.sessionId],
    );

    return {
      id: session.id,
      userId: session.userId,
      tokenVersion: session.tokenVersion,
      isAdmin: !!session.isAdmin,
      loginMethod: 'refresh',
    };
  }

  // ── Token already consumed — potential token theft ──────────
  if (event.status === 'active') {
    // Was active at read time but someone else rotated it first — replay.
    await exec(
      `UPDATE sessions SET revokedAt = ?, revokedReason = 'refresh_reuse_detected' WHERE id = ?`,
      [now, event.sessionId],
    );
  } else if (event.status === 'rotated' && event.rotatedToHash) {
    // Reuse of an already-rotated token — chase the chain.
    const rotatedEvent = await queryOne(
      `SELECT sessionId FROM refresh_token_events WHERE tokenHash = ?`,
      [event.rotatedToHash],
    );
    if (rotatedEvent) {
      await exec(
        `UPDATE sessions SET revokedAt = ?, revokedReason = 'refresh_reuse_detected' WHERE id = ?`,
        [now, rotatedEvent.sessionId],
      );
    }
  }

  await exec(
    `UPDATE refresh_token_events SET status = 'reused', usedAt = ? WHERE id = ?`,
    [now, event.id],
  );

  return null;
}

/**
 * Revoke all sessions for a user.
 */
export async function revokeUserSessions(
  userId: string,
  reason: string,
  exceptSessionId?: string,
): Promise<void> {
  if (exceptSessionId) {
    await exec(
      `UPDATE sessions SET revokedAt = ?, revokedReason = ? WHERE userId = ? AND id != ? AND revokedAt IS NULL`,
      [Date.now(), reason, userId, exceptSessionId],
    );
  } else {
    await exec(
      `UPDATE sessions SET revokedAt = ?, revokedReason = ? WHERE userId = ? AND revokedAt IS NULL`,
      [Date.now(), reason, userId],
    );
  }
}

/**
 * Revoke a specific session.
 */
export async function revokeSession(
  sessionId: string,
  reason: string,
): Promise<void> {
  await exec(
    `UPDATE sessions SET revokedAt = ?, revokedReason = ? WHERE id = ? AND revokedAt IS NULL`,
    [Date.now(), reason, sessionId],
  );
}

/**
 * Check if a session is still valid.
 */
export async function getValidSession(
  sessionId: string,
  userId: string,
  expectedTokenVersion: number,
): Promise<boolean> {
  const session = await queryOne(
    `SELECT id, revokedAt, expiresAt
     FROM sessions
     WHERE id = ? AND userId = ?`,
    [sessionId, userId],
  );

  if (!session) return false;
  if (session.revokedAt) return false;
  if (session.expiresAt < Date.now()) return false;

  // Check user tokenVersion
  const user = await queryOne(
    `SELECT tokenVersion FROM users WHERE id = ?`,
    [userId],
  );
  if (!user) return false;
  if (user.tokenVersion !== expectedTokenVersion) return false;

  return true;
}
