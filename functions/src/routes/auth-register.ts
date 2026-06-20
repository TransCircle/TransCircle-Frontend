import { Router } from 'express'
import { exec, queryOne } from '../Database'
import { ulid, genId } from '../utils/ulid'
import { hashPassword } from '../utils/password'
import { sendSuccess, sendError, Errors, zodErrorsToDetails } from '../utils/response'
import { registerSchema } from '../utils/validation'
import { hmacToken } from '../utils/session'
import { rateLimitCheck } from '../middleware/rateLimit'
import { idempotencyKey } from '../middleware/idempotency'
import { writeAuditLog } from '../utils/audit'
import { sendEmail, buildVerificationEmail } from '../utils/mail'
import { isPasswordNotLeaked } from '../utils/hibp'
import { lookupAsn, trackGlobalConflict } from '../utils/asn'

const router: Router = Router()

/**
 * Verify a CAPTCHA token against Cloudflare Turnstile (or reCAPTCHA).
 * Returns true if valid or if CAPTCHA_SECRET is not configured (dev mode).
 * api.md §1.1: CAPTCHA 升级阈值触发后必须验证 X-Captcha-Token。
 */
async function verifyCaptcha(token: string): Promise<boolean> {
  const secret = process.env.CAPTCHA_SECRET
  if (!secret) return true // skip if not configured
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token }),
    })
    const data = await res.json() as { success?: boolean }
    return data.success === true
  } catch {
    return false
  }
}

/** Extract IPv4 /24 or IPv6 /48 CIDR prefix from IP */
function cidrPrefix(ip: string): string {
  if (ip.includes(':')) {
    // IPv6: take /48 (first 3 groups)
    const parts = ip.split(':')
    return parts.slice(0, 3).join(':') + '::/48'
  }
  // IPv4: take /24
  const parts = ip.split('.')
  return parts.slice(0, 3).join('.') + '.0/24'
}

/** Set standard X-RateLimit-* response headers per api.md */
function setRateLimitHeaders(res: import('express').Response, max: number, remaining: number, windowMs: number): void {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs
  res.setHeader('X-RateLimit-Limit', String(max))
  res.setHeader('X-RateLimit-Remaining', String(remaining))
  res.setHeader('X-RateLimit-Reset', String(windowStart + windowMs))
}

// POST /auth/register — api.md §1.1
router.post('/register', (req, _res, next) => { req.rateLimitAction = 'register'; next(); }, rateLimitCheck, idempotencyKey, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 422, zodErrorsToDetails(parsed.error.flatten()))
    return
  }

  const { username, email, password, displayName } = parsed.data
  const now = Date.now()
  const ip = req.ip || req.socket.remoteAddress || 'unknown'

  // ── CIDR /24 subnet rate limiting (api.md §1.1: 300/h per /24) ──
  const hourWindow = Math.floor(now / 3600_000) * 3600_000
  const subnet = cidrPrefix(ip)
  const subnetKey = `register:subnet:${subnet}:${hourWindow}`
  const subnetRate = await queryOne(`SELECT count FROM rate_limits WHERE bucketKey = ? AND windowStart = ?`, [subnetKey, hourWindow])
  if ((subnetRate?.count as number || 0) >= 300) {
    setRateLimitHeaders(res, 300, 0, 3600_000)
    sendError(res, Errors.RATE_LIMITED.code, '该网段注册过于频繁', req.requestId, 429)
    return
  }

  // ── ASN rate limiting (api.md §1.1: 300/h per ASN + 风控审计) ──
  const asnInfo = await lookupAsn(ip)
  if (asnInfo) {
    const asnKey = `register:asn:${asnInfo.asn}:${hourWindow}`
    const asnRate = await queryOne(`SELECT count FROM rate_limits WHERE bucketKey = ? AND windowStart = ?`, [asnKey, hourWindow])
    if ((asnRate?.count as number || 0) >= 300) {
      setRateLimitHeaders(res, 300, 0, 3600_000)
      // Write audit log for ASN-level rate limit (风控审计 per api.md §1.1)
      writeAuditLog(req, {
        actorUserId: null,
        action: 'rate_limit.asn',
        resourceType: 'register',
        resourceId: '',
        after: { asn: asnInfo.asn, org: asnInfo.org, ipPrefix: subnet },
      }).catch((e: unknown) => console.error('audit error:', e))
      sendError(res, Errors.RATE_LIMITED.code, '该网络注册过于频繁', req.requestId, 429)
      return
    }
  }

  // ── CAPTCHA upgrade: track conflicts per IP in 1-min window (api.md §1.1) ──
  const captchaWindow = Math.floor(now / 60_000) * 60_000
  const captchaKey = `register:captcha:${ip}:${captchaWindow}`
  // Only enforce CAPTCHA after threshold; check is done before conflict increments below

  // Normalize email: lowercase per api.md §1.1 "邮箱本地部分大小写敏感性以服务端归一化为准"
  const normalizedEmail = email.toLowerCase()

  // Per-email and per-username rate limits (api.md §1.1: 5/24h)
  const dayWindow = Math.floor(now / 86400_000) * 86400_000
  const emailRateKey = `register:email:${normalizedEmail}:${dayWindow}`
  const usernameRateKey = `register:username:${username}:${dayWindow}`
  const emailRate = await queryOne(`SELECT count FROM rate_limits WHERE bucketKey = ? AND windowStart = ?`, [emailRateKey, dayWindow])
  const usernameRate = await queryOne(`SELECT count FROM rate_limits WHERE bucketKey = ? AND windowStart = ?`, [usernameRateKey, dayWindow])
  if ((emailRate?.count as number || 0) >= 5) {
    const retryAfter = Math.ceil((dayWindow + 86400_000 - now) / 1000)
    res.setHeader('Retry-After', String(retryAfter))
    setRateLimitHeaders(res, 5, 0, 86400_000)
    sendError(res, Errors.RATE_LIMITED.code, '该邮箱注册过于频繁', req.requestId, 429)
    return
  }
  if ((usernameRate?.count as number || 0) >= 5) {
    const retryAfter = Math.ceil((dayWindow + 86400_000 - now) / 1000)
    res.setHeader('Retry-After', String(retryAfter))
    setRateLimitHeaders(res, 5, 0, 86400_000)
    sendError(res, Errors.RATE_LIMITED.code, '该用户名注册过于频繁', req.requestId, 429)
    return
  }

  // Helper: track count for a rate limit bucket key
  async function incrementCounter(bucketKey: string, windowStart: number): Promise<void> {
    const existing = await queryOne(`SELECT id, count FROM rate_limits WHERE bucketKey = ? AND windowStart = ?`, [bucketKey, windowStart])
    if (existing) {
      await exec(`UPDATE rate_limits SET count = count + 1 WHERE id = ?`, [existing.id])
    } else {
      await exec(`INSERT INTO rate_limits (id, bucketKey, windowStart, count, createdAt) VALUES (?, ?, ?, 1, ?)`, [ulid(), bucketKey, windowStart, now])
    }
  }

  // ── CAPTCHA upgrade check (api.md §1.1: ≥10 conflicts/min from same IP) ──
  const captchaConflictCount = await queryOne(
    `SELECT count FROM rate_limits WHERE bucketKey = ? AND windowStart = ?`,
    [captchaKey, captchaWindow],
  )
  if ((captchaConflictCount?.count as number || 0) >= 10) {
    const captchaToken = req.headers['x-captcha-token'] as string | undefined
    if (!captchaToken || !(await verifyCaptcha(captchaToken))) {
      const retryAfter = Math.ceil((captchaWindow + 60_000 - now) / 1000)
      res.setHeader('Retry-After', String(retryAfter))
      setRateLimitHeaders(res, 10, 0, 60_000)
      sendError(res, Errors.RATE_LIMITED.code, '需要 CAPTCHA 验证', req.requestId, 429)
      return
    }
  }

  // Check uniqueness
  const existingUser = await queryOne(`SELECT id FROM users WHERE username = ?`, [username])
  if (existingUser) {
    // Track conflict for CAPTCHA escalation (api.md §1.1)
    await incrementCounter(captchaKey, captchaWindow)
    // Track global conflict for PagerDuty alerting (api.md §1.1)
    const alert = trackGlobalConflict()
    if (alert.triggered) {
      console.error(`[ALERT] GLOBAL CONFLICT THRESHOLD: ${alert.count} conflicts in current 5-min window`)
    }
    sendError(res, Errors.USERNAME_TAKEN.code, Errors.USERNAME_TAKEN.message, req.requestId, 409, undefined, { nextAction: 'choose_other_username' })
    return
  }

  const existingEmail = await queryOne(`SELECT id FROM users WHERE email = ?`, [normalizedEmail])
  if (existingEmail) {
    // Track conflict for CAPTCHA escalation (api.md §1.1)
    await incrementCounter(captchaKey, captchaWindow)
    // Track global conflict for PagerDuty alerting (api.md §1.1)
    const alert = trackGlobalConflict()
    if (alert.triggered) {
      console.error(`[ALERT] GLOBAL CONFLICT THRESHOLD: ${alert.count} conflicts in current 5-min window`)
    }
    sendError(res, Errors.EMAIL_TAKEN.code, '该邮箱已被注册', req.requestId, 409, undefined, { nextAction: 'password_forgot' })
    return
  }

  // api.md §1.1: HIBP k-Anonymity leak check
  if (!await isPasswordNotLeaked(password)) {
    sendError(res, Errors.VALIDATION_ERROR.code, '该密码已在公开泄露中出现，请更换密码', req.requestId, 422)
    return
  }

  const passwordHash = await hashPassword(password)
  const userId = genId('usr_')

  await exec(
    `INSERT INTO users (id, username, email, emailVerified, emailVerifiedSource, displayName, passwordHash, passwordUpdatedAt, passwordHistory, status, createdAt, updatedAt)
     VALUES (?, ?, ?, FALSE, NULL, ?, ?, ?, ?, 'pending_verification', ?, ?)`,
    [userId, username, normalizedEmail, displayName, passwordHash, now, JSON.stringify([passwordHash]), now, now],
  )

  // Generate verification token
  const verifyToken = genId('vfy_')
  const verifyHash = await hmacToken(verifyToken)
  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, ?, 'email_verify', ?, '{}', ?, ?)`,
    [ulid(), userId, verifyHash, now + 86400_000, now],
  )

  // Audit log
  await writeAuditLog(req, {
    actorUserId: userId,
    action: 'auth.register',
    resourceType: 'user',
    resourceId: userId,
    after: { username, email },
  })

  // Track per-email, per-username, and CIDR subnet rate limits (api.md §1.1)
  for (const [bucket, ws] of [[emailRateKey, dayWindow], [usernameRateKey, dayWindow], [subnetKey, hourWindow]] as const) {
    const existingRate = await queryOne(`SELECT id, count FROM rate_limits WHERE bucketKey = ? AND windowStart = ?`, [bucket, ws])
    if (existingRate) {
      await exec(`UPDATE rate_limits SET count = count + 1 WHERE id = ?`, [existingRate.id])
    } else {
      await exec(`INSERT INTO rate_limits (id, bucketKey, windowStart, count, createdAt) VALUES (?, ?, ?, 1, ?)`, [ulid(), bucket, ws, now])
    }
  }

  // Actually send verification email per api.md §1.1
  const emailSent = await sendEmail(buildVerificationEmail(normalizedEmail, verifyToken))

  sendSuccess(res, {
    user: {
      id: userId, username, email: normalizedEmail, displayName,
      avatarUrl: null, emailVerified: false,
      status: 'pending_verification', createdAt: now,
    },
    verificationEmailSent: emailSent,
  }, req.requestId, 201)
})

// POST /auth/email/verify — api.md §1.2.1
router.post('/email/verify', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
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
  await exec(`UPDATE users SET emailVerified = TRUE, emailVerifiedSource = 'email', status = 'active', updatedAt = ? WHERE id = ?`, [Date.now(), record.userId])

  // Audit log per api.md §15.13
  writeAuditLog(req, {
    actorUserId: record.userId,
    action: 'auth.email.verify',
    resourceType: 'user',
    resourceId: record.userId,
    after: { emailVerified: true },
  }).catch((e: unknown) => console.error('audit error:', e))

  sendSuccess(res, { emailVerified: true, userId: record.userId }, req.requestId)
})

// POST /auth/email/resend — api.md §1.2.2
router.post('/email/resend', (req, _res, next) => { req.rateLimitAction = 'email:resend'; next(); }, rateLimitCheck, async (req, res) => {
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

  // Generate and send new verification token
  const verifyToken = genId('vfy_')
  const verifyHash = await hmacToken(verifyToken)
  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, ?, 'email_verify', ?, '{}', ?, ?)`,
    [ulid(), user.id, verifyHash, Date.now() + 86400_000, Date.now()],
  )
  const sent = await sendEmail(buildVerificationEmail(email, verifyToken))

  sendSuccess(res, { sent }, req.requestId, 202)
})

export default router
