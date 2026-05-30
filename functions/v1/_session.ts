// JWT + Refresh Token session management
// Matches apidocs.md §1.3 / §1.6.3 / §1.11.2 auth model
// Access tokens: JWT (HS256), 15min, sent as Bearer header
// Refresh tokens: rt_<ULID>.random, 7 days, stored in D1, sent as HttpOnly cookie
// Rotation: old token marked 'rotated' with rotated_to_hash pointing to new token

import { verifyAccessToken } from './_jwt'
import { ensureSchema } from './_db'
import { ulidWithPrefix } from './_ulid'

interface SessionData {
  provider: 'github' | 'x'
  userId: string
  username: string
  avatarUrl?: string
  isAdmin: boolean
  tokenVersion: number
}

const REFRESH_COOKIE = 'refresh_token'
const COOKIE_PATH = '/v1/auth'
const REFRESH_TTL = 7 * 24 * 60 * 60 // 7 days in seconds
const REUSE_GRACE_MS = 2000 // 2s grace window for network retries

function generateToken(): string {
  const ulid = ulidWithPrefix('rt_')
  const rand = crypto.getRandomValues(new Uint8Array(16))
  const randStr = btoa(String.fromCharCode(...rand)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${ulid}.${randStr}`
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function setRefreshCookie(response: Response, token: string): Response {
  const headers = new Headers(response.headers)
  headers.set(
    'Set-Cookie',
    `${REFRESH_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${REFRESH_TTL}`,
  )
  return new Response(response.body, { ...response, headers })
}

export function clearRefreshCookie(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set(
    'Set-Cookie',
    `${REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0`,
  )
  return new Response(response.body, { ...response, headers })
}

export function getRefreshToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || ''
  const match = cookie.match(new RegExp(`${REFRESH_COOKIE}=([^;]+)`))
  return match?.[1] || null
}

// Extract and verify JWT from Authorization header
export async function getSession(
  request: Request,
  secret: string,
): Promise<SessionData | null> {
  const auth = request.headers.get('Authorization') || ''
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match) return null

  const payload = await verifyAccessToken(match[1], secret)
  if (!payload) return null

  return {
    provider: payload.provider as 'github' | 'x',
    userId: payload.sub,
    username: payload.username,
    isAdmin: payload.roles.includes('admin'),
    tokenVersion: payload.tokenVersion,
  }
}

// Store refresh token in D1 and return the raw token for cookie
export async function createRefreshToken(
  db: D1Database,
  session: SessionData,
): Promise<string> {
  await ensureSchema(db)
  const token = generateToken()
  const hash = await hashToken(token)
  const now = Date.now()
  const expiresAt = now + REFRESH_TTL * 1000

  await db.prepare(
    `INSERT INTO refresh_tokens (token_hash, user_id, provider, username, is_admin, token_version, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).bind(hash, session.userId, session.provider, session.username,
    session.isAdmin ? 1 : 0, session.tokenVersion, now, expiresAt).run()

  return token
}

// Verify refresh token from cookie against D1
export async function verifyRefreshToken(
  db: D1Database,
  token: string,
): Promise<SessionData | null> {
  await ensureSchema(db)
  const hash = await hashToken(token)
  const now = Date.now()

  const row = await db.prepare(
    `SELECT user_id, provider, username, is_admin, token_version, status, used_at
     FROM refresh_tokens WHERE token_hash = ? AND expires_at > ?`,
  ).bind(hash, now).first<{
    user_id: string; provider: string; username: string;
    is_admin: number; token_version: number; status: string; used_at: number | null
  }>()

  if (!row) return null
  if (row.status !== 'active') {
    // Token has been used or revoked — potential reuse
    return null
  }

  return {
    provider: row.provider as 'github' | 'x',
    userId: row.user_id,
    username: row.username,
    isAdmin: row.is_admin === 1,
    tokenVersion: row.token_version,
  }
}

// Rotate refresh token: mark old as rotated, create new token
// Per apidocs.md §1.11.2 rotation + reuse detection
export async function rotateRefreshToken(
  db: D1Database,
  oldToken: string,
  session: SessionData,
): Promise<string | null> {
  await ensureSchema(db)
  const oldHash = await hashToken(oldToken)
  const now = Date.now()

  // Check old token status
  const oldRow = await db.prepare(
    `SELECT token_hash, status, used_at FROM refresh_tokens WHERE token_hash = ?`,
  ).bind(oldHash).first<{ token_hash: string; status: string; used_at: number | null }>()

  if (!oldRow) return null

  if (oldRow.status === 'rotated') {
    // Check race grace window: if within 2s, it's a legitimate retry
    if (oldRow.used_at && (now - oldRow.used_at) <= REUSE_GRACE_MS) {
      // Follow rotation chain to return the latest token
      const newRow = await db.prepare(
        `SELECT token_hash FROM refresh_tokens WHERE rotated_to_hash IS NOT NULL AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
      ).bind(oldRow.used_at).first<{ token_hash: string }>()
      if (newRow) return null // caller should use existing new token
    }
    // Outside grace window = real reuse → revoke all
    await revokeAllForUser(db, session.userId)
    return null
  }

  if (oldRow.status !== 'active') {
    // revoked or reused → block
    return null
  }

  // Create new token
  const newToken = generateToken()
  const newHash = await hashToken(newToken)
  const expiresAt = now + REFRESH_TTL * 1000

  // Mark old as rotated, insert new
  await db.prepare(
    `UPDATE refresh_tokens SET status = 'rotated', rotated_to_hash = ?, used_at = ? WHERE token_hash = ? AND status = 'active'`,
  ).bind(newHash, now, oldHash).run()

  await db.prepare(
    `INSERT INTO refresh_tokens (token_hash, user_id, provider, username, is_admin, token_version, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).bind(newHash, session.userId, session.provider, session.username,
    session.isAdmin ? 1 : 0, session.tokenVersion, now, expiresAt).run()

  return newToken
}

// Revoke all refresh tokens for a user
async function revokeAllForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare(
    `UPDATE refresh_tokens SET status = 'revoked', used_at = ? WHERE user_id = ? AND status IN ('active', 'rotated')`,
  ).bind(Date.now(), userId).run()
}

export async function revokeRefreshTokens(db: D1Database, userId: string): Promise<void> {
  await revokeAllForUser(db, userId)
}

// Clear the old encrypted-session-style cookie (for migrating existing sessions)
export function clearSessionCookie(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set(
    'Set-Cookie',
    `tc_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  )
  return new Response(response.body, { ...response, headers })
}
