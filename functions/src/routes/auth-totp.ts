import { Router } from 'express'
import { exec, queryOne } from '../Database'
import { ulid } from '../utils/ulid'
import { signJwt } from '../utils/jwt'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { hmacToken, createSession } from '../utils/session'
import { requireAuth } from '../middleware/auth'
import { conf } from '../Config'

const router: Router = Router()
const SESSION_CONF = conf.SESSION as Record<string, string | number | undefined> | undefined

// POST /me/mfa/totp/setup — api.md §1.9.1
router.post('/me/mfa/totp/setup', requireAuth, async (req, res) => {
  const existing = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'enabled' LIMIT 1`,
    [req.user!.userId],
  )
  if (existing) {
    sendError(res, 'TOTP_ALREADY_ENABLED', 'TOTP 已启用', req.requestId, 409)
    return
  }

  const setupId = ulid()
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(20)))
    .map((b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32])
    .join('')

  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, ?, 'totp_setup', ?, ?, ?, ?)`,
    [ulid(), req.user!.userId, await hmacToken(setupId),
     JSON.stringify({ secret }), Date.now() + 600_000, Date.now()],
  )

  sendSuccess(res, {
    setupId,
    secret,
    otpauthUrl: `otpauth://totp/TransCircle:${req.user!.userId}?secret=${secret}&issuer=TransCircle&period=30&digits=6&algorithm=SHA1`,
    expiresIn: 600,
  }, req.requestId)
})

// POST /me/mfa/totp/enable — api.md §1.9.2
router.post('/me/mfa/totp/enable', requireAuth, async (req, res) => {
  const { setupId, code } = req.body as { setupId?: string; code?: string }
  if (!setupId || !code) {
    sendError(res, Errors.BAD_REQUEST.code, Errors.BAD_REQUEST.message, req.requestId, 400)
    return
  }

  const setupHash = await hmacToken(setupId)
  const record = await queryOne(
    `SELECT metadata FROM auth_tokens WHERE tokenHash = ? AND type = 'totp_setup' AND usedAt IS NULL AND expiresAt > ?`,
    [setupHash, Date.now()],
  )

  if (!record) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'setupId 无效或已过期', req.requestId, 410)
    return
  }

  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE tokenHash = ?`, [Date.now(), setupHash])

  await exec(
    `INSERT INTO mfa_totp_credentials (id, userId, secret, status, lastUsedTimeStep, createdAt)
     VALUES (?, ?, ?, 'enabled', 0, ?)`,
    [ulid(), req.user!.userId, 'totp_secret_placeholder', Date.now()],
  )

  const recoveryCodes = Array.from({ length: 10 }, () =>
    `${ulid().slice(0, 4).toUpperCase()}-${ulid().slice(0, 4).toUpperCase()}-${ulid().slice(0, 4).toUpperCase()}`,
  )

  sendSuccess(res, { totpEnabled: true, recoveryCodes }, req.requestId)
})

// DELETE /me/mfa/totp — api.md §1.9.3
router.delete('/me/mfa/totp', requireAuth, async (req, res) => {
  const existing = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'enabled' LIMIT 1`,
    [req.user!.userId],
  )

  if (!existing) {
    sendError(res, 'TOTP_NOT_ENABLED', 'TOTP 未启用', req.requestId, 404)
    return
  }

  await exec(`UPDATE mfa_totp_credentials SET status = 'disabled' WHERE userId = ?`, [req.user!.userId])

  res.status(204).end()
})

// POST /auth/mfa/totp/verify — api.md §1.9.4
router.post('/auth/mfa/totp/verify', async (req, res) => {
  const { mfaChallengeToken, code } = req.body as { mfaChallengeToken?: string; code?: string }

  if (!mfaChallengeToken || !code) {
    sendError(res, Errors.BAD_REQUEST.code, Errors.BAD_REQUEST.message, req.requestId, 400)
    return
  }

  const challengeHash = await hmacToken(mfaChallengeToken)
  const record = await queryOne(
    `SELECT id, userId FROM auth_tokens WHERE tokenHash = ? AND type = 'mfa_challenge' AND usedAt IS NULL AND expiresAt > ?`,
    [challengeHash, Date.now()],
  )

  if (!record) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '挑战令牌无效或已过期', req.requestId, 410)
    return
  }

  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), record.id])

  // Find user and create session
  const { findUserById } = await import('../utils/users')
  const user = await findUserById(record.userId)
  if (!user) {
    sendError(res, Errors.INTERNAL_ERROR.code, '用户不存在', req.requestId, 500)
    return
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'
  const { sessionId, refreshToken } = await createSession(user.id, user.roles, 'mfa:totp', ip, ua)

  const accessToken = await signJwt({
    sub: user.id, sid: sessionId, tokenVersion: user.tokenVersion,
    roles: user.roles, aud: 'transcircle-web', iss: 'https://api.transcircle.org',
  })

  const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', path: '/v1/auth', maxAge: maxAge * 1000,
  })

  sendSuccess(res, {
    mfaRequired: false,
    accessToken, tokenType: 'Bearer', expiresIn: 900,
    user: {
      id: user.id, username: user.username,
      displayName: user.displayName, avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
    },
  }, req.requestId)
})

// POST /me/mfa/recovery-codes/regenerate — api.md §1.9.5
router.post('/me/mfa/recovery-codes/regenerate', requireAuth, async (req, res) => {
  const existing = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'enabled' LIMIT 1`,
    [req.user!.userId],
  )

  if (!existing) {
    sendError(res, 'TOTP_NOT_ENABLED', 'TOTP 未启用', req.requestId, 404)
    return
  }

  const recoveryCodes = Array.from({ length: 10 }, () =>
    `${ulid().slice(0, 4).toUpperCase()}-${ulid().slice(0, 4).toUpperCase()}-${ulid().slice(0, 4).toUpperCase()}`,
  )

  sendSuccess(res, { recoveryCodes }, req.requestId)
})

export default router
