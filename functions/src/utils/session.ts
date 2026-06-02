import { queryOne, exec } from '../Database'
import { ulid } from './ulid'
import { conf } from '../Config'

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000 // 7 days
const REFRESH_TOKEN_BYTES = 32
const SESSION_SECRET =
  ((conf.SESSION as Record<string, string | undefined>)?.SESS_SECRET) || 'default-secret-change-me'

function randomToken(): string {
  const buf = crypto.getRandomValues(new Uint8Array(REFRESH_TOKEN_BYTES))
  return Array.from(buf)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
}

/** HMAC-SHA256 for token hashing. */
export async function hmacToken(data: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/** SHA-256 for fingerprinting. */
async function sha256(data: string): Promise<string> {
  const enc = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

export interface SessionInfo {
  id: string
  userId: string
  tokenVersion: number
  roles: string[]
}

export interface RotateResult extends SessionInfo {
  newRefreshToken: string
}

/**
 * Create a new session with refresh token for a user.
 * Returns the session record info and the raw refresh token string.
 */
export async function createSession(
  userId: string,
  roles: string[],
  loginMethod: string,
  ip: string,
  ua: string,
): Promise<{ sessionId: string; refreshToken: string }> {
  const sessionId = ulid()
  const refreshToken = randomToken()
  const tokenPrefix = refreshToken.slice(0, 8)
  const [tokenHash, ipHash, uaHash] = await Promise.all([
    hmacToken(refreshToken),
    sha256(ip || 'unknown'),
    sha256(ua || 'unknown'),
  ])
  const ipPrefix = (ip || 'unknown').split('.').slice(0, 3).join('.') + '.0'
  const now = Date.now()

  await exec(
    `INSERT INTO sessions (id, userId, createdAt, lastUsedAt, expiresAt, ipHash, ipPrefix, userAgentHash, loginMethod)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, userId, now, now, now + SESSION_MAX_AGE, ipHash, ipPrefix, uaHash, loginMethod],
  )

  await exec(
    `INSERT INTO refresh_token_events (id, sessionId, tokenHash, tokenPrefix, status, createdAt)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    [ulid(), sessionId, tokenHash, tokenPrefix, now],
  )

  return { sessionId, refreshToken }
}

/**
 * Verify and rotate a refresh token.
 * Returns null on invalid/reused token, or RotateResult on success.
 *
 * Atomic rotation with reuse detection:
 * - UPDATE ... WHERE status='active' eliminates TOCTOU race
 * - race-grace window (2s) handles concurrent refresh requests
 */
export async function rotateRefreshToken(rawToken: string): Promise<RotateResult | null> {
  const [tokenHash] = await Promise.all([hmacToken(rawToken)])
  const prefix = rawToken.slice(0, 8)

  const event = await queryOne(
    `SELECT id, sessionId, status, rotatedToHash
     FROM refresh_token_events
     WHERE tokenHash = ? AND tokenPrefix = ?`,
    [tokenHash, prefix],
  )

  if (!event) return null

  const now = Date.now()
  const newToken = randomToken()
  const newPrefix = newToken.slice(0, 8)
  const newHash = await hmacToken(newToken)

  // Atomic claim: only 'active' tokens can be rotated
  const claimed = await exec(
    `UPDATE refresh_token_events
     SET status = 'rotated', rotatedToHash = ?, usedAt = ?
     WHERE id = ? AND status = 'active'`,
    [newHash, now, event.id],
  )

  if (claimed.affectedRows === 1) {
    // Won the race — token is atomically ours
    const session = await queryOne(
      `SELECT s.id, s.userId, u.tokenVersion,
              EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = u.id AND r.name = 'admin') AS isAdmin
       FROM sessions s
       JOIN users u ON u.id = s.userId
       WHERE s.id = ?`,
      [event.sessionId],
    )

    if (!session || session.expiresAt < now) {
      await exec(`UPDATE refresh_token_events SET status = 'revoked' WHERE tokenHash = ?`, [newHash])
      return null
    }

    // Insert new active token event
    await exec(
      `INSERT INTO refresh_token_events (id, sessionId, tokenHash, tokenPrefix, status, createdAt)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [ulid(), event.sessionId, newHash, newPrefix, now],
    )

    await exec(`UPDATE sessions SET lastUsedAt = ? WHERE id = ?`, [now, event.sessionId])

    return {
      id: session.id,
      userId: session.userId,
      tokenVersion: session.tokenVersion,
      roles: session.isAdmin ? ['reviewer'] : [],
      newRefreshToken: newToken,
    }
  }

  // Token already consumed — potential replay attack
  if (event.status === 'active') {
    // Was active at read time but someone else rotated it — check race-grace window
    const oldRecord = await queryOne(
      `SELECT usedAt FROM refresh_token_events WHERE id = ?`,
      [event.id],
    )
    const usedAt = oldRecord?.usedAt as number | undefined
    if (usedAt && now - usedAt <= 2000) {
      // race-grace window: concurrent refresh, return the new token
      if (event.rotatedToHash) {
        // Race-grace window: the client received new token from first response
        // and should use it on retry. We can't reconstruct from hash here.
        return null
      }
    } else {
      // Real reuse — revoke the session
      await exec(
        `UPDATE sessions SET revokedAt = ?, revokedReason = 'refresh_reuse_detected' WHERE id = ?`,
        [now, event.sessionId],
      )
    }
  } else if (event.status === 'rotated' && event.rotatedToHash) {
    // Reuse of an already-rotated token — chase the chain
    const rotatedEvent = await queryOne(
      `SELECT sessionId FROM refresh_token_events WHERE tokenHash = ?`,
      [event.rotatedToHash],
    )
    if (rotatedEvent) {
      await exec(
        `UPDATE sessions SET revokedAt = ?, revokedReason = 'refresh_reuse_detected' WHERE id = ?`,
        [now, rotatedEvent.sessionId],
      )
    }
  }

  await exec(
    `UPDATE refresh_token_events SET status = 'reused', usedAt = ? WHERE id = ?`,
    [now, event.id],
  )

  return null
}

/** Revoke all sessions for a user. */
export async function revokeUserSessions(userId: string, reason: string, exceptSessionId?: string): Promise<void> {
  if (exceptSessionId) {
    await exec(`UPDATE sessions SET revokedAt = ?, revokedReason = ? WHERE userId = ? AND id != ? AND revokedAt IS NULL`, [
      Date.now(),
      reason,
      userId,
      exceptSessionId,
    ])
  } else {
    await exec(`UPDATE sessions SET revokedAt = ?, revokedReason = ? WHERE userId = ? AND revokedAt IS NULL`, [
      Date.now(),
      reason,
      userId,
    ])
  }
}

/** Revoke a specific session. */
export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await exec(`UPDATE sessions SET revokedAt = ?, revokedReason = ? WHERE id = ? AND revokedAt IS NULL`, [
    Date.now(),
    reason,
    sessionId,
  ])
}
