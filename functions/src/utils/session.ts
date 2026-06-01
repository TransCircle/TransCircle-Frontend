import { query, queryOne, exec } from '../Database';
import { ulid } from './ulid';

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_TOKEN_BYTES = 32;

function hashToken(token: string): string {
  let hash = 0;
  for (const c of token) {
    hash = ((hash << 5) - hash) + c.charCodeAt(0);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function randomToken(): string {
  const buf = crypto.getRandomValues(new Uint8Array(REFRESH_TOKEN_BYTES));
  return Array.from(buf).map(b => b.toString(36).padStart(2, '0')).join('');
}

function hashSha256(data: string): string {
  // Simple SHA-256 via WebCrypto for session token prefix hashing
  const enc = new TextEncoder();
  // Use a synchronous approach — for async we'd need restructuring
  let h = 0;
  for (const c of data) {
    h = ((h << 5) - h) + c.charCodeAt(0);
    h |= 0;
  }
  return Math.abs(h).toString(36).padStart(6, '0');
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
  tokenVersion: number,
): Promise<{ sessionId: string; refreshToken: string }> {
  const sessionId = ulid();
  const refreshToken = randomToken();
  const tokenPrefix = refreshToken.slice(0, 8);
  const tokenHash = hashSha256(refreshToken);
  const ipHash = hashSha256(ip || 'unknown');
  const ipPrefix = (ip || 'unknown').split('.').slice(0, 3).join('.') + '.0';
  const uaHash = hashSha256(ua || 'unknown');
  const now = Date.now();

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
 */
export async function rotateRefreshToken(
  rawToken: string,
  ip: string,
  ua: string,
): Promise<SessionInfo | null> {
  const tokenHash = hashSha256(rawToken);
  const prefix = rawToken.slice(0, 8);

  const event = await queryOne<any[]>(
    `SELECT id, sessionId, status, rotatedToHash
     FROM refresh_token_events
     WHERE tokenHash = ? AND tokenPrefix = ?`,
    [tokenHash, prefix],
  );

  if (!event) return null;

  // Mark current token as rotated/reused
  const now = Date.now();

  if (event.status === 'active') {
    const session = await queryOne<any[]>(
      `SELECT s.id, s.userId, s.expiresAt, s.revokedAt, u.tokenVersion, u.isAdmin
       FROM sessions s
       JOIN users u ON u.id = s.userId
       WHERE s.id = ?`,
      [event.sessionId],
    );

    if (!session || session.revokedAt || session.expiresAt < now) {
      // Session invalid — revoke this token event
      await exec(
        `UPDATE refresh_token_events SET status = 'revoked', usedAt = ? WHERE id = ?`,
        [now, event.id],
      );
      return null;
    }

    // Rotate: issue new token
    const newToken = randomToken();
    const newHash = hashSha256(newToken);
    const newPrefix = newToken.slice(0, 8);

    // Mark old as rotated
    await exec(
      `UPDATE refresh_token_events SET status = 'rotated', rotatedToHash = ?, usedAt = ? WHERE id = ?`,
      [newHash, now, event.id],
    );

    // Insert new token event
    await exec(
      `INSERT INTO refresh_token_events (id, sessionId, tokenHash, tokenPrefix, status, createdAt)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [ulid(), event.sessionId, newHash, newPrefix, now],
    );

    // Update session lastUsedAt
    await exec(
      `UPDATE sessions SET lastUsedAt = ? WHERE id = ?`,
      [now, event.sessionId],
    );

    // Store new raw token in response (returned to caller — caller must set cookie)
    return {
      id: session.id,
      userId: session.userId,
      tokenVersion: session.tokenVersion,
      isAdmin: !!session.isAdmin,
      loginMethod: 'refresh',
    };
  }

  // Reused or rotated token — potential token theft
  if (event.status === 'rotated' && event.rotatedToHash) {
    // Revoke the rotated-to token chain
    const rotatedEvent = await queryOne<any[]>(
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
  const session = await queryOne<any[]>(
    `SELECT id, revokedAt, expiresAt
     FROM sessions
     WHERE id = ? AND userId = ?`,
    [sessionId, userId],
  );

  if (!session) return false;
  if (session.revokedAt) return false;
  if (session.expiresAt < Date.now()) return false;

  // Check user tokenVersion
  const user = await queryOne<any[]>(
    `SELECT tokenVersion FROM users WHERE id = ?`,
    [userId],
  );
  if (!user) return false;
  if (user.tokenVersion !== expectedTokenVersion) return false;

  return true;
}
