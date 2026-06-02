import { Router } from 'express'
import { exec, queryOne } from '../Database'
import { ulid } from '../utils/ulid'
import { hashPassword } from '../utils/password'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { registerSchema } from '../utils/validation'
import { hmacToken } from '../utils/session'
import { rateLimitCheck } from '../middleware/rateLimit'

const router: Router = Router()

// POST /auth/register — api.md §1.1
router.post('/register', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 422, parsed.error.flatten())
    return
  }

  const { username, email, password, displayName } = parsed.data
  const now = Date.now()

  // Check uniqueness
  const existingUser = await queryOne(`SELECT id FROM users WHERE username = ?`, [username])
  if (existingUser) {
    sendError(res, Errors.USERNAME_TAKEN.code, Errors.USERNAME_TAKEN.message, req.requestId, 409)
    return
  }

  const existingEmail = await queryOne(`SELECT id FROM users WHERE email = ?`, [email])
  if (existingEmail) {
    sendError(res, Errors.EMAIL_TAKEN.code, '该邮箱已被注册', req.requestId, 409)
    return
  }

  const passwordHash = await hashPassword(password)
  const userId = ulid()

  await exec(
    `INSERT INTO users (id, username, email, emailVerified, displayName, passwordHash, passwordUpdatedAt, status, createdAt, updatedAt)
     VALUES (?, ?, ?, FALSE, ?, ?, ?, 'pending_verification', ?, ?)`,
    [userId, username, email, displayName, passwordHash, now, now, now],
  )

  // Generate verification token
  const verifyToken = ulid()
  const verifyHash = await hmacToken(verifyToken)
  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, ?, 'email_verify', ?, '{}', ?, ?)`,
    [ulid(), userId, verifyHash, now + 86400_000, now],
  )

  // Audit log
  await exec(
    `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, after, createdAt, requestId)
     VALUES (?, ?, 'auth.register', 'user', ?, ?, ?, ?)`,
    [ulid(), userId, userId, JSON.stringify({ username, email }), now, req.requestId],
  )

  sendSuccess(res, {
    user: {
      id: userId, username, email, displayName,
      avatarUrl: null, emailVerified: false,
      status: 'pending_verification', createdAt: now,
    },
    verificationEmailSent: true,
  }, req.requestId, 201)
})

// POST /auth/email/verify — api.md §1.2.1
router.post('/email/verify', async (req, res) => {
  const token = req.body?.token as string | undefined
  if (!token) {
    sendError(res, Errors.BAD_REQUEST.code, Errors.BAD_REQUEST.message, req.requestId, 400)
    return
  }

  const tokenHash = await hmacToken(token)
  const record = await queryOne(
    `SELECT id, userId FROM auth_tokens WHERE tokenHash = ? AND type = 'email_verify' AND usedAt IS NULL AND expiresAt > ?`,
    [tokenHash, Date.now()],
  )

  if (!record) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '令牌无效或已过期', req.requestId, 410)
    return
  }

  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), record.id])
  await exec(`UPDATE users SET emailVerified = TRUE, status = 'active', updatedAt = ? WHERE id = ?`, [Date.now(), record.userId])

  sendSuccess(res, { emailVerified: true, userId: record.userId }, req.requestId)
})

// POST /auth/email/resend — api.md §1.2.2
router.post('/email/resend', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const email = req.body?.email as string | undefined
  if (!email) {
    sendError(res, Errors.BAD_REQUEST.code, Errors.BAD_REQUEST.message, req.requestId, 400)
    return
  }

  const user = await queryOne(`SELECT id, emailVerified FROM users WHERE email = ?`, [email])
  if (!user) {
    sendError(res, 'EMAIL_NOT_FOUND', '邮箱未注册', req.requestId, 404)
    return
  }

  if (user.emailVerified) {
    sendError(res, 'EMAIL_ALREADY_VERIFIED', '邮箱已通过验证', req.requestId, 409)
    return
  }

  sendSuccess(res, { sent: true }, req.requestId, 202)
})

export default router
