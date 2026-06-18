import { Router } from 'express'
import { queryOne, exec, getConnection } from '../Database'
import { ulid, genId } from '../utils/ulid'
import { signJwt } from '../utils/jwt'
import { verifyPassword, hashPassword } from '../utils/password'
import { metrics } from '../utils/metrics'
import { sendSuccess, sendError, Errors, zodErrorsToDetails } from '../utils/response'
import { createSession, hmacToken, isNativeClient } from '../utils/session'
import { loginSchema } from '../utils/validation'
import { rateLimitCheck } from '../middleware/rateLimit'
import { findUserByUsername, findUserByEmail } from '../utils/users'
import { conf } from '../Config'
import { writeAuditLog } from '../utils/audit'

const router: Router = Router()
const SESSION_CONF = conf.SESSION as Record<string, string | number | undefined> | undefined

// Pre-computed dummy argon2id hash for constant-time login response (api.md §1.3)
// Prevents timing-based username enumeration by always running a password verify.
// Generated with: argon2.hash('__constant_time_dummy__', { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 })
let _dummyHash: string | undefined
async function getDummyHash(): Promise<string> {
  if (!_dummyHash) {
    _dummyHash = await hashPassword('__constant_time_dummy__')
  }
  return _dummyHash
}

// Helper: atomic check-and-increment login failure count (api.md §1.3: 5 failures → 423)
// 使用事务 + FOR UPDATE 保证精确计数
// 原子记录登录失败 + 锁检查 (api.md §1.3)
async function recordLoginFailureAtomic(userId: string, ip: string, identifier: string): Promise<void> {
  const conn = await getConnection()
  try {
    await conn.beginTransaction()
    const now = Date.now()
    const windowStart = Math.floor(now / 900_000) * 900_000

    const lockoutKey = `login:lockout:${userId}:${windowStart}`
    const [lockRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id, count FROM rate_limits WHERE bucketKey = ? FOR UPDATE`,
      [lockoutKey],
    )
    if (lockRows[0]?.id) {
      await conn.execute(`UPDATE rate_limits SET count = count + 1 WHERE id = ?`, [lockRows[0].id])
    } else {
      await conn.execute(
        `INSERT INTO rate_limits (id, bucketKey, windowStart, count, createdAt) VALUES (?, ?, ?, 1, ?)`,
        [ulid(), lockoutKey, windowStart, now],
      )
    }

    const ipIdentKey = `login:ip:ident:${ip}:${identifier}:${windowStart}`
    await conn.execute(
      `INSERT INTO rate_limits (id, bucketKey, windowStart, count, createdAt) VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE count = count + 1`,
      [ulid(), ipIdentKey, windowStart, now],
    )

    await conn.commit()
  } catch {
    await conn.rollback().catch(() => {})
  } finally {
    conn.release()
  }
}

// Helper: clear login failure records on success
async function clearLoginFailures(userId: string): Promise<void> {
  try {
    await exec(`DELETE FROM rate_limits WHERE bucketKey LIKE ?`, [`login:lockout:${userId}:%`])
  } catch { /* best-effort */ }
}

// POST /auth/login — api.md §1.3
router.post('/login', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 422, zodErrorsToDetails(parsed.error.flatten()))
    return
  }

  const { identifier, password } = parsed.data
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()

  // Find user by username or email per api.md §1.3: use proper email regex, not includes('@')
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)
  const user = isEmail
    ? await findUserByEmail(identifier)
    : await findUserByUsername(identifier)

  if (!user) {
    // api.md §1.3: Constant-time response to prevent enumeration.
    // Verify with dummy hash so response time matches "wrong password" path.
    const dummyHash = await getDummyHash()
    await verifyPassword(dummyHash, password)

    writeAuditLog(req, {
      actorUserId: null,
      action: 'auth.login.fail',
      resourceType: 'user',
      resourceId: '',
      after: { reason: 'user_not_found' },
    }).catch((e: unknown) => console.error('audit error:', e))
    sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
    metrics.authLoginTotal["invalid_credentials"] = (metrics.authLoginTotal["invalid_credentials"] || 0) + 1
    return
  }

  // Check account lockout per api.md §1.3: 5 failures in 15 min → 423
  // 使用事务 + FOR UPDATE 保证原子性
  const lockoutWindowStart = Math.floor(now / 900_000) * 900_000 // 15 min windows
  const lockoutBucketKey = `login:lockout:${user.id}:${lockoutWindowStart}`
  {
    const conn = await getConnection()
    try {
      await conn.beginTransaction()
      const [lRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
        `SELECT count FROM rate_limits WHERE bucketKey = ? FOR UPDATE`,
        [lockoutBucketKey],
      )
      if ((lRows[0]?.count as number) >= 5) {
        await conn.rollback()
        const retryAfter = Math.ceil((lockoutWindowStart + 900_000 - now) / 1000)
        res.setHeader('Retry-After', String(retryAfter))
    metrics.authLoginTotal["locked"] = (metrics.authLoginTotal["locked"] || 0) + 1
        sendError(res, 'ACCOUNT_LOCKED', '账户已锁定，请 15 分钟后重试', req.requestId, 423)
        return
      }
      await conn.commit()
    } finally {
      conn.release()
    }
  }

  // IP×identifier rate limit per api.md §1.3: 10 failures in 15 min
  const ipIdentKey = `login:ip:ident:${req.ip || 'unknown'}:${identifier}`
  const ipIdentWindow = Math.floor(now / 900_000) * 900_000
  const ipIdentBucketKey = `${ipIdentKey}:${ipIdentWindow}`
  const ipIdentRecord = await queryOne(
    `SELECT count FROM rate_limits WHERE bucketKey = ?`,
    [ipIdentBucketKey],
  )
  if (ipIdentRecord && (ipIdentRecord.count as number) >= 10) {
    const retryAfter = Math.ceil((ipIdentWindow + 900_000 - now) / 1000)
    res.setHeader('Retry-After', String(retryAfter))
    sendError(res, Errors.RATE_LIMITED.code, `登录尝试过多，请 ${retryAfter} 秒后重试`, req.requestId, Errors.RATE_LIMITED.status)
    return
  }

  // Check user status
  if (user.status === 'banned') {
    writeAuditLog(req, { actorUserId: user.id, action: 'auth.login.fail', resourceType: 'user', resourceId: user.id, after: { reason: 'banned' } }).catch((e: unknown) => console.error('audit error:', e))
    sendError(res, 'ACCOUNT_BANNED', '账户已被封禁', req.requestId, 403)
    return
  }
  if (user.status === 'merged') {
    writeAuditLog(req, { actorUserId: user.id, action: 'auth.login.fail', resourceType: 'user', resourceId: user.id, after: { reason: 'merged' } }).catch((e: unknown) => console.error('audit error:', e))
    sendError(res, 'ACCOUNT_MERGED', '账户已被合并', req.requestId, 403)
    return
  }
  if (user.status === 'pending_deletion') {
    writeAuditLog(req, { actorUserId: user.id, action: 'auth.login.fail', resourceType: 'user', resourceId: user.id, after: { reason: 'pending_deletion' } }).catch((e: unknown) => console.error('audit error:', e))
    sendError(res, 'ACCOUNT_PENDING_DELETION', '账户正在注销，需先撤销注销', req.requestId, 403)
    return
  }
  if (user.status === 'deleted') {
    writeAuditLog(req, { actorUserId: user.id, action: 'auth.login.fail', resourceType: 'user', resourceId: user.id, after: { reason: 'deleted' } }).catch((e: unknown) => console.error('audit error:', e))
    sendError(res, Errors.ACCOUNT_DELETED.code, Errors.ACCOUNT_DELETED.message, req.requestId, Errors.ACCOUNT_DELETED.status)
    return
  }

  // Verify password
  const userRow = await queryOne(`SELECT passwordHash FROM users WHERE id = ?`, [user.id])
  if (!userRow?.passwordHash) {
    await recordLoginFailureAtomic(user.id, ip, identifier)
    writeAuditLog(req, { actorUserId: user.id, action: 'auth.login.fail', resourceType: 'user', resourceId: user.id, after: { reason: 'no_password' } }).catch((e: unknown) => console.error('audit error:', e))
    sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
    return
  }

  const valid = await verifyPassword(userRow.passwordHash as string, password)
  if (!valid) {
    await recordLoginFailureAtomic(user.id, ip, identifier)
    writeAuditLog(req, { actorUserId: user.id, action: 'auth.login.fail', resourceType: 'user', resourceId: user.id, after: { reason: 'wrong_password' } }).catch((e: unknown) => console.error('audit error:', e))
    sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
    return
  }

  // Clear lockout on successful login
  await clearLoginFailures(user.id)

  // Audit log: login success
  await writeAuditLog(req, {
    actorUserId: user.id,
    action: 'auth.login.success',
    resourceType: 'user',
    resourceId: user.id,
    after: { method: 'password' },
  }).catch((e: unknown) => console.error('audit error:', e))

  // Check MFA — both TOTP and Passkey per api.md §1.3
  const totpEnabled = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'active' LIMIT 1`,
    [user.id],
  )
  const passkeyActive = await queryOne(
    `SELECT COUNT(*) as cnt FROM passkeys WHERE userId = ? AND status = 'active'`,
    [user.id],
  )
  const passkeyCount = (passkeyActive?.cnt as number) || 0

  const availableMethods: string[] = []
  if (totpEnabled) availableMethods.push('totp')
  if (passkeyCount > 0) availableMethods.push('passkey')

  if (availableMethods.length > 0) {
    // Generate MFA challenge
    const mfaChallenge = genId('mfa_chal_')
    const challengeHash = await hmacToken(mfaChallenge)
    await exec(
      `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
       VALUES (?, ?, 'mfa_challenge', ?, JSON_OBJECT('loginMethod', 'password'), ?, ?)`,
      [ulid(), user.id, challengeHash, now + 300_000, now],
    )
    metrics.authLoginTotal["mfa_required"] = (metrics.authLoginTotal["mfa_required"] || 0) + 1

    sendSuccess(res, {
      mfaRequired: true,
      mfaChallengeToken: mfaChallenge,
      mfaChallengeExpiresIn: 300,
      availableMethods,
    }, req.requestId)
    return
  }

  // Create session
  const ua = req.headers['user-agent'] || 'unknown'
  const { sessionId, refreshToken } = await createSession(user.id, user.roles, 'password', ip, ua)

  const accessToken = await signJwt({
    sub: user.id, sid: sessionId, tokenVersion: user.tokenVersion,
    roles: user.roles, aud: 'transcircle-web', iss: 'https://api.transcircle.org',
  })

  const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true, secure: true,
    sameSite: 'lax', path: '/v1/auth', maxAge: maxAge * 1000,
  })

  // api.md §1.3: 浏览器场景通过 Cookie 下发时，响应体省略 refreshToken
  const nativeClient = isNativeClient(req)
  const loginResp: Record<string, unknown> = {
    mfaRequired: false,
    accessToken, tokenType: 'Bearer', expiresIn: 900,
    user: {
      id: user.id, username: user.username,
      displayName: user.displayName, avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
    },
  }
  metrics.authLoginTotal["success"] = (metrics.authLoginTotal["success"] || 0) + 1
  if (nativeClient) loginResp.refreshToken = refreshToken
  sendSuccess(res, loginResp, req.requestId)
})

export default router
