import { Router } from 'express'
import { exec, queryOne } from '../Database'
import { ulid, genId } from '../utils/ulid'
import { hashPassword, verifyPassword } from '../utils/password'
import { sendSuccess, sendError, Errors, zodErrorsToDetails } from '../utils/response'
import { hmacToken, revokeUserSessions } from '../utils/session'
import { passwordResetSchema, validatePassword } from '../utils/validation'
import { requireAuth } from '../middleware/auth'
import { rateLimitCheck } from '../middleware/rateLimit'
import { writeAuditLog } from '../utils/audit'
import { sendEmail, buildPasswordResetEmail } from '../utils/mail'
import { isPasswordNotLeaked } from '../utils/hibp'
import { log } from '../Logger'

const router: Router = Router()

// POST /auth/password/forgot — api.md §1.4.1
router.post('/auth/password/forgot', (req, _res, next) => { req.rateLimitAction = 'password:forgot'; next(); }, rateLimitCheck, async (req, res) => {
  const email = req.body?.email as string | undefined
  if (!email) { sendError(res, Errors.BAD_REQUEST.code, Errors.BAD_REQUEST.message, req.requestId, 400); return }

  // Per-email rate limit: 3/h per api.md §1.4.1
  const now = Date.now()
  const hourWindow = Math.floor(now / 3600_000) * 3600_000
  const emailRateKey = `password:forgot:email:${email.toLowerCase()}:${hourWindow}`
  const emailRate = await queryOne(`SELECT count FROM rate_limits WHERE bucketKey = ? AND windowStart = ?`, [emailRateKey, hourWindow])
  if ((emailRate?.count as number || 0) >= 3) {
    sendError(res, Errors.RATE_LIMITED.code, '该邮箱密码重置请求过于频繁', req.requestId, Errors.RATE_LIMITED.status)
    return
  }

  const user = await queryOne(`SELECT id, status FROM users WHERE email = ?`, [email])
  if (!user) { sendError(res, 'EMAIL_NOT_FOUND', '邮箱未注册', req.requestId, 404); return }
  if (user.status === 'banned') { sendError(res, Errors.ACCOUNT_BANNED.code, '账户已被封禁', req.requestId, Errors.ACCOUNT_BANNED.status); return }

  const resetToken = genId('rst_')
  const tokenHash = await hmacToken(resetToken)
  await exec(`INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt) VALUES (?, ?, 'password_reset', ?, '{}', ?, ?)`, [ulid(), user.id, tokenHash, Date.now() + 3600_000, Date.now()])

  // Send password reset email per api.md §1.4.1
  await sendEmail(buildPasswordResetEmail(email, resetToken)).catch((e: unknown) => log(`ERROR: failed to send password reset email to ${email}: ${(e as Error).message}`))

  // Audit log
  await writeAuditLog(req, {
    actorUserId: user.id,
    action: 'auth.password.reset.request',
    resourceType: 'user',
    resourceId: user.id,
    after: {},
  })

  // Increment per-email rate limit counter
  await exec(
    `INSERT INTO rate_limits (id, bucketKey, windowStart, count, createdAt) VALUES (?, ?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE count = count + 1`,
    [ulid(), emailRateKey, hourWindow, now],
  ).catch(() => {})

  sendSuccess(res, { sent: true }, req.requestId, 202)
})

// POST /auth/password/reset — api.md §1.4.2
router.post('/auth/password/reset', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const parsed = passwordResetSchema.safeParse(req.body)
  if (!parsed.success) { sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 422, zodErrorsToDetails(parsed.error.flatten())); return }

  const { token, newPassword } = parsed.data
  const tokenHash = await hmacToken(token)
  const now = Date.now()

  const record = await queryOne(`SELECT id, userId FROM auth_tokens WHERE tokenHash = ? AND type = 'password_reset' AND usedAt IS NULL AND expiresAt > ?`, [tokenHash, now])
  if (!record) { sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '令牌无效或已过期', req.requestId, 410); return }

  // api.md §1.1: HIBP k-Anonymity leak check
  if (!await isPasswordNotLeaked(newPassword)) {
    sendError(res, Errors.VALIDATION_ERROR.code, '该密码已在公开泄露中出现，请更换密码', req.requestId, 422)
    return
  }

  const passwordHash = await hashPassword(newPassword)
  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [now, record.id])
  await exec(`UPDATE users SET passwordHash = ?, tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ?`, [passwordHash, now, record.userId])
  await revokeUserSessions(record.userId, 'password_reset')

  // Audit log
  await writeAuditLog(req, {
    actorUserId: record.userId,
    action: 'auth.password.reset',
    resourceType: 'user',
    resourceId: record.userId,
    after: { passwordReset: true },
  })

  sendSuccess(res, { passwordReset: true }, req.requestId)
})

// POST /me/password — api.md §1.5
router.post('/me/password', requireAuth, (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string }

  // Validate password per spec (including username/email check per api.md §1.1)
  if (!newPassword) {
    sendError(res, Errors.VALIDATION_ERROR.code, '新密码不能为空', req.requestId, 422)
    return
  }
  const userRow = await queryOne(`SELECT username, email, passwordHash, passwordHistory FROM users WHERE id = ?`, [req.user!.userId])
  const pwdErr = validatePassword(newPassword, userRow?.username as string | undefined, userRow?.email as string | undefined)
  if (pwdErr) {
    sendError(res, Errors.VALIDATION_ERROR.code, pwdErr, req.requestId, 422)
    return
  }

  // Check password history (api.md §1.1: not among last 5 passwords)
  if (userRow?.passwordHistory) {
    const { verifyPassword } = await import('../utils/password')
    const history = (typeof userRow.passwordHistory === 'string' ? JSON.parse(userRow.passwordHistory) : userRow.passwordHistory) as string[]
    for (const oldHash of history) {
      if (await verifyPassword(oldHash, newPassword)) {
        sendError(res, Errors.VALIDATION_ERROR.code, '新密码不能与最近 5 个历史密码相同', req.requestId, 422)
        return
      }
    }
  }

  const now = Date.now()
  const userId = req.user!.userId

  if (userRow?.passwordHash) {
    if (!currentPassword) { sendError(res, Errors.INVALID_CREDENTIALS.code, '当前密码错误', req.requestId, Errors.INVALID_CREDENTIALS.status); return }
    const valid = await verifyPassword(userRow.passwordHash as string, currentPassword)
    if (!valid) { sendError(res, Errors.INVALID_CREDENTIALS.code, '当前密码错误', req.requestId, Errors.INVALID_CREDENTIALS.status); return }
  }

  // api.md §1.1: HIBP k-Anonymity leak check
  if (!await isPasswordNotLeaked(newPassword)) {
    sendError(res, Errors.VALIDATION_ERROR.code, '该密码已在公开泄露中出现，请更换密码', req.requestId, 422)
    return
  }

  const passwordHash = await hashPassword(newPassword)
  // Update password history: keep last 5 hashes
  const oldHistory = (() => {
    try {
      const raw = userRow?.passwordHistory
      return typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
    } catch { return [] }
  })() as string[]
  const newHistory = [...oldHistory, userRow?.passwordHash].filter(Boolean).slice(-5)
  await exec(
    `UPDATE users SET passwordHash = ?, passwordUpdatedAt = ?, passwordHistory = ?, tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ?`,
    [passwordHash, now, JSON.stringify(newHistory), now, userId],
  )
  await revokeUserSessions(userId, 'password_changed', req.user!.sessionId)

  // Count revoked sessions
  const revoked = await queryOne(
    `SELECT COUNT(*) as cnt FROM sessions WHERE userId = ? AND revokedReason = 'password_changed' AND id != ?`,
    [userId, req.user!.sessionId],
  )

  // Issue new access token for current session (api.md §1.5 requires this)
  const userAfterUpdate = await queryOne(
    `SELECT tokenVersion FROM users WHERE id = ?`,
    [userId],
  )
  const signJwt = (await import('../utils/jwt')).signJwt
  const newAccessToken = await signJwt({
    sub: userId,
    sid: req.user!.sessionId,
    tokenVersion: (userAfterUpdate?.tokenVersion as number) || 0,
    roles: req.user!.roles,
    aud: 'transcircle-web',
    iss: 'https://api.transcircle.org',
  })

  // Issue new refresh token for current session
  const { hmacToken: hmac } = await import('../utils/session')
  const { randomBytes } = await import('node:crypto')
  const newRefreshToken = randomBytes(32).toString('base64url')
  const newRefreshHash = await hmac(newRefreshToken)
  const sessionConf = (await import('../Config')).conf.SESSION as Record<string, string | number | undefined> | undefined
  const maxAge = (sessionConf?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
  await exec(
    `INSERT INTO refresh_token_events (id, sessionId, tokenHash, tokenPrefix, status, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [genId('rte_'), req.user!.sessionId, newRefreshHash, newRefreshToken.slice(0, 8), now, now + maxAge * 1000],
  )

  // Audit log
  await writeAuditLog(req, {
    actorUserId: userId,
    action: 'password.change',
    resourceType: 'user',
    resourceId: userId,
    after: { passwordChanged: true },
  })

  sendSuccess(res, {
    passwordChanged: true,
    revokedSessions: (revoked?.cnt as number) || 0,
    accessToken: newAccessToken,
    tokenType: 'Bearer',
    expiresIn: 900,
    refreshToken: newRefreshToken,
  }, req.requestId)
})

export default router
