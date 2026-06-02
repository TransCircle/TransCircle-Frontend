import { Router } from 'express'
import { exec, queryOne } from '../Database'
import { ulid } from '../utils/ulid'
import { hashPassword, verifyPassword } from '../utils/password'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { hmacToken, revokeUserSessions } from '../utils/session'
import { passwordResetSchema } from '../utils/validation'
import { requireAuth } from '../middleware/auth'
import { rateLimitCheck } from '../middleware/rateLimit'

const router: Router = Router()

// POST /auth/password/forgot — api.md §1.4.1
router.post('/auth/password/forgot', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const email = req.body?.email as string | undefined
  if (!email) { sendError(res, Errors.BAD_REQUEST.code, Errors.BAD_REQUEST.message, req.requestId, 400); return }

  const user = await queryOne(`SELECT id, status FROM users WHERE email = ?`, [email])
  if (!user) { sendError(res, 'EMAIL_NOT_FOUND', '邮箱未注册', req.requestId, 404); return }
  if (user.status === 'banned') { sendError(res, Errors.ACCOUNT_BANNED.code, '账户已被封禁', req.requestId, Errors.ACCOUNT_BANNED.status); return }

  const resetToken = ulid()
  const tokenHash = await hmacToken(resetToken)
  await exec(`INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt) VALUES (?, ?, 'password_reset', ?, '{}', ?, ?)`, [ulid(), user.id, tokenHash, Date.now() + 3600_000, Date.now()])

  sendSuccess(res, { sent: true }, req.requestId, 202)
})

// POST /auth/password/reset — api.md §1.4.2
router.post('/auth/password/reset', async (req, res) => {
  const parsed = passwordResetSchema.safeParse(req.body)
  if (!parsed.success) { sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 422, parsed.error.flatten()); return }

  const { token, newPassword } = parsed.data
  const tokenHash = await hmacToken(token)
  const now = Date.now()

  const record = await queryOne(`SELECT id, userId FROM auth_tokens WHERE tokenHash = ? AND type = 'password_reset' AND usedAt IS NULL AND expiresAt > ?`, [tokenHash, now])
  if (!record) { sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '令牌无效或已过期', req.requestId, 410); return }

  const passwordHash = await hashPassword(newPassword)
  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [now, record.id])
  await exec(`UPDATE users SET passwordHash = ?, tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ?`, [passwordHash, now, record.userId])
  await revokeUserSessions(record.userId, 'password_reset')

  sendSuccess(res, { passwordReset: true }, req.requestId)
})

// POST /me/password — api.md §1.5
router.post('/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string }
  if (!newPassword || newPassword.length < 12 || newPassword.length > 128) { sendError(res, Errors.VALIDATION_ERROR.code, '新密码长度必须在 12-128 字符之间', req.requestId, 422); return }

  const now = Date.now()
  const userId = req.user!.userId
  const userRow = await queryOne(`SELECT passwordHash FROM users WHERE id = ?`, [userId])

  if (userRow?.passwordHash) {
    if (!currentPassword) { sendError(res, Errors.INVALID_CREDENTIALS.code, '当前密码错误', req.requestId, Errors.INVALID_CREDENTIALS.status); return }
    const valid = await verifyPassword(userRow.passwordHash as string, currentPassword)
    if (!valid) { sendError(res, Errors.INVALID_CREDENTIALS.code, '当前密码错误', req.requestId, Errors.INVALID_CREDENTIALS.status); return }
  }

  const passwordHash = await hashPassword(newPassword)
  await exec(`UPDATE users SET passwordHash = ?, passwordUpdatedAt = ?, tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ?`, [passwordHash, now, now, userId])
  await revokeUserSessions(userId, 'password_change', req.user!.sessionId)

  sendSuccess(res, { passwordChanged: true, revokedSessions: 0 }, req.requestId)
})

export default router
