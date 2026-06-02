import { Router } from 'express'
import { queryOne, exec } from '../Database'
import { ulid } from '../utils/ulid'
import { signJwt } from '../utils/jwt'
import { verifyPassword } from '../utils/password'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { createSession, hmacToken } from '../utils/session'
import { loginSchema } from '../utils/validation'
import { rateLimitCheck } from '../middleware/rateLimit'
import { findUserByUsername, findUserByEmail } from '../utils/users'
import { conf } from '../Config'

const router: Router = Router()
const SESSION_CONF = conf.SESSION as Record<string, string | number | undefined> | undefined

// POST /auth/login — api.md §1.3
router.post('/login', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 422, parsed.error.flatten())
    return
  }

  const { identifier, password } = parsed.data
  const now = Date.now()

  // Find user by username or email
  const user = identifier.includes('@')
    ? await findUserByEmail(identifier)
    : await findUserByUsername(identifier)

  if (!user) {
    sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
    return
  }

  // Check user status
  if (user.status === 'banned') {
    sendError(res, 'ACCOUNT_BANNED', '账户已被封禁', req.requestId, 403)
    return
  }
  if (user.status === 'merged') {
    sendError(res, 'ACCOUNT_MERGED', '账户已被合并', req.requestId, 403)
    return
  }
  if (user.status === 'pending_deletion') {
    sendError(res, 'ACCOUNT_PENDING_DELETION', '账户正在注销', req.requestId, 423)
    return
  }
  if (user.status === 'deleted') {
    sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
    return
  }

  // Verify password
  const userRow = await queryOne(`SELECT passwordHash FROM users WHERE id = ?`, [user.id])
  if (!userRow?.passwordHash) {
    sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
    return
  }

  const valid = await verifyPassword(userRow.passwordHash as string, password)
  if (!valid) {
    sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
    return
  }

  // Check MFA
  const totpEnabled = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'enabled' LIMIT 1`,
    [user.id],
  )

  if (totpEnabled) {
    // Generate MFA challenge
    const mfaChallenge = ulid()
    const challengeHash = await hmacToken(mfaChallenge)
    await exec(
      `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
       VALUES (?, ?, 'mfa_challenge', ?, '{}', ?, ?)`,
      [ulid(), user.id, challengeHash, now + 300_000, now],
    )

    sendSuccess(res, {
      mfaRequired: true,
      mfaChallengeToken: mfaChallenge,
      mfaChallengeExpiresIn: 300,
      availableMethods: ['totp'],
    }, req.requestId)
    return
  }

  // Create session
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'
  const { sessionId, refreshToken } = await createSession(user.id, user.roles, 'password', ip, ua)

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
    refreshToken, // 原生客户端用
    user: {
      id: user.id, username: user.username,
      displayName: user.displayName, avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
    },
  }, req.requestId)
})

export default router
