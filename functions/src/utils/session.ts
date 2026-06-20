import { query, queryOne, exec } from '../Database'
import { genId } from './ulid'
import { conf } from '../Config'
import { parseUserAgent, type DeviceInfo } from './user-agent'

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000 // 7 days
const REFRESH_TOKEN_BYTES = 32
const SESSION_SECRET =
  (conf.SESSION as Record<string, string | undefined>)?.SESS_SECRET

if (!SESSION_SECRET) {
  throw new Error('SESSION.SESS_SECRET must be configured in config.toml (required for HMAC signing)')
}

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

/** Generate a high-entropy token (256 bits) using crypto random values. */
export function generateHighEntropyToken(): string {
  const buf = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(buf)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
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
 * If `conn` is provided, uses it for transactional atomicity.
 */
export async function createSession(
  userId: string,
  roles: string[],
  loginMethod: string,
  ip: string,
  ua: string,
  conn?: import('mysql2/promise').PoolConnection,
): Promise<{ sessionId: string; refreshToken: string }> {
  const sessionId = genId('sess_')
  const refreshToken = randomToken()
  const tokenPrefix = refreshToken.slice(0, 8)
  const [tokenHash, ipHash, uaHash] = await Promise.all([
    hmacToken(refreshToken),
    hmacToken(ip || 'unknown'),  // hmac_sha256 per api.md §15.4 (was sha256)
    sha256(ua || 'unknown'),
  ])
  const ipStr = ip || 'unknown'
  const ipPrefix = ipStr.includes(':')
    ? ipStr.split(':').slice(0, 4).join(':') + '::/48'
    : ipStr.split('.').slice(0, 3).join('.') + '.0'
  const deviceInfo: DeviceInfo = parseUserAgent(ua || 'unknown')
  const now = Date.now()

  const run = conn ? conn.execute.bind(conn) : exec

  await run(
    `INSERT INTO sessions (id, userId, createdAt, lastUsedAt, expiresAt, ipHash, ipPrefix, userAgentHash, deviceSummary, loginMethod)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, userId, now, now, now + SESSION_MAX_AGE, ipHash, ipPrefix, uaHash, JSON.stringify(deviceInfo), loginMethod],
  )

  await run(
    `INSERT INTO refresh_token_events (id, sessionId, tokenHash, tokenPrefix, status, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [genId('rte_'), sessionId, tokenHash, tokenPrefix, now, now + SESSION_MAX_AGE],
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
      `SELECT s.id, s.userId, s.expiresAt, u.tokenVersion
       FROM sessions s
       JOIN users u ON u.id = s.userId
       WHERE s.id = ?`,
      [event.sessionId],
    )

    if (!session || (session.expiresAt as number) < now) {
      await exec(`UPDATE refresh_token_events SET status = 'revoked' WHERE tokenHash = ?`, [newHash])
      return null
    }

    // Insert new active token event
    await exec(
      `INSERT INTO refresh_token_events (id, sessionId, tokenHash, tokenPrefix, status, createdAt, expiresAt)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [genId('rte_'), event.sessionId, newHash, newPrefix, now, now + SESSION_MAX_AGE],
    )

    await exec(`UPDATE sessions SET lastUsedAt = ? WHERE id = ?`, [now, event.sessionId])

    // Fetch actual roles from DB (api.md §15.10)
    let roles: string[] = []
    try {
      const roleRows = await query(
        `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = ?`,
        [session.userId],
      )
      roles = (roleRows as Array<{ name: string }>).map(r => r.name)
    } catch { /* no roles */ }

    return {
      id: session.id,
      userId: session.userId,
      tokenVersion: session.tokenVersion,
      roles,
      newRefreshToken: newToken,
    }
  }

  // Token already consumed — potential replay attack per api.md §1.11.2
  const oldRecord = await queryOne(
    `SELECT usedAt FROM refresh_token_events WHERE id = ?`,
    [event.id],
  )
  const usedAt = oldRecord?.usedAt as number | undefined

  if (event.status === 'active') {
    // Was active at read time but someone else rotated it concurrently
    if (usedAt && now - usedAt <= 2000) {
      // race-grace window (≤2s): concurrent refresh from network jitter/retry
      // Follow rotation chain to find the active session (api.md §1.11.2)
      if (event.rotatedToHash) {
        const rotatedEvent = await queryOne(
          `SELECT rte.sessionId, s.userId, u.tokenVersion
           FROM refresh_token_events rte
           JOIN sessions s ON s.id = rte.sessionId
           JOIN users u ON u.id = s.userId
           WHERE rte.tokenHash = ? AND rte.status = 'active'`,
          [event.rotatedToHash],
        )
        if (rotatedEvent) {
          let roles: string[] = []
          try {
            const roleRows = await query(
              `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = ?`,
              [rotatedEvent.userId],
            )
            roles = (roleRows as Array<{ name: string }>).map(r => r.name)
          } catch { /* no roles */ }
          return {
            id: rotatedEvent.sessionId,
            userId: rotatedEvent.userId,
            tokenVersion: rotatedEvent.tokenVersion,
            roles,
            newRefreshToken: '', // client already has it from first response
          }
        }
      }
    } else {
      // Outside race-grace window (>2s): real reuse — revoke session + all tokens + bump tokenVersion
      await exec(
        `UPDATE sessions SET revokedAt = ?, revokedReason = 'refresh_reuse_detected' WHERE id = ?`,
        [now, event.sessionId],
      )
      await exec(
        `UPDATE refresh_token_events SET status = 'revoked' WHERE sessionId = ? AND status IN ('active', 'rotated')`,
        [event.sessionId],
      )
    }
  } else if (event.status === 'rotated' && event.rotatedToHash) {
    // Reuse of an already-rotated token outside race-grace — chase the chain
    const rotatedEvent = await queryOne(
      `SELECT sessionId FROM refresh_token_events WHERE tokenHash = ?`,
      [event.rotatedToHash],
    )
    if (rotatedEvent && (!usedAt || now - usedAt > 2000)) {
      await exec(
        `UPDATE sessions SET revokedAt = ?, revokedReason = 'refresh_reuse_detected' WHERE id = ?`,
        [now, rotatedEvent.sessionId],
      )
      await exec(
        `UPDATE refresh_token_events SET status = 'revoked' WHERE sessionId = ? AND status IN ('active', 'rotated')`,
        [rotatedEvent.sessionId],
      )
    }
  }

  // Mark token as reused and bump tokenVersion only outside race-grace window
  if (!usedAt || now - usedAt > 2000) {
    await exec(
      `UPDATE refresh_token_events SET status = 'reused', usedAt = COALESCE(usedAt, ?) WHERE id = ?`,
      [now, event.id],
    )

    // Bump tokenVersion per api.md §1.11.2 reuse handling
    const reuseSession = await queryOne(
      `SELECT userId FROM sessions WHERE id = ?`,
      [event.sessionId],
    )
    if (reuseSession) {
      await exec(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [reuseSession.userId])
    }
  }

  return null
}

/** Revoke all sessions for a user, including their refresh token events. */
export async function revokeUserSessions(userId: string, reason: string, exceptSessionId?: string): Promise<void> {
  const now = Date.now()
  if (exceptSessionId) {
    await exec(`UPDATE sessions SET revokedAt = ?, revokedReason = ? WHERE userId = ? AND id != ? AND revokedAt IS NULL`, [
      now, reason, userId, exceptSessionId,
    ])
    await exec(
      `UPDATE refresh_token_events SET status = 'revoked'
       WHERE sessionId IN (SELECT id FROM sessions WHERE userId = ? AND id != ? AND revokedAt = ?)
         AND status IN ('active', 'rotated')`,
      [userId, exceptSessionId, now],
    )
  } else {
    await exec(`UPDATE sessions SET revokedAt = ?, revokedReason = ? WHERE userId = ? AND revokedAt IS NULL`, [
      now, reason, userId,
    ])
    await exec(
      `UPDATE refresh_token_events SET status = 'revoked'
       WHERE sessionId IN (SELECT id FROM sessions WHERE userId = ? AND revokedAt = ?)
         AND status IN ('active', 'rotated')`,
      [userId, now],
    )
  }
}

/** Revoke a specific session, including its refresh token events. */
/**
 * Detect if the current request originates from a native/mobile client
 * (as opposed to a browser). Per api.md §1.3:
 * - Browser: refreshToken delivered via Set-Cookie (omit from response body)
 * - Native: refreshToken delivered via response body
 *
 * Priority: explicit X-Client-Type header > UA heuristic fallback.
 */
export function isNativeClient(req: import('express').Request): boolean {
  if (req.headers['x-client-type'] === 'native') return true
  const ua = req.headers['user-agent']
  if (!ua) return false
  // Fallback: browsers typically include these keywords; native SDKs don't
  return !/Mozilla|Chrome\b|Safari\b|Firefox\b|Edge\b|Opera\b/i.test(ua)
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  const now = Date.now()
  await exec(`UPDATE sessions SET revokedAt = ?, revokedReason = ? WHERE id = ? AND revokedAt IS NULL`, [
    now, reason, sessionId,
  ])
  await exec(
    `UPDATE refresh_token_events SET status = 'revoked'
     WHERE sessionId = ? AND status IN ('active', 'rotated')`,
    [sessionId],
  )
}
