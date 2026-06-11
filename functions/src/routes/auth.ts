import { Router, type Router as RouterType } from 'express'
import { conf } from '../Config'
import { exec, queryOne } from '../Database'
import { ulid, genId } from '../utils/ulid'
import { signJwt } from '../utils/jwt'
import { hashPassword } from '../utils/password'
import { sendSuccess, sendError, Errors, zodErrorsToDetails, sendNoContent } from '../utils/response'
import { createSession, rotateRefreshToken, revokeSession, hmacToken, generateHighEntropyToken } from '../utils/session'
import { findUserById } from '../utils/users'
import { loginCodeSchema, completeRegistrationSchema } from '../utils/validation'
import { requireAuth } from '../middleware/auth'
import { rateLimitCheck } from '../middleware/rateLimit'
import { writeAuditLog, sha256base64url } from '../utils/audit'
import { metrics } from '../utils/metrics'
import { isPasswordNotLeaked } from '../utils/hibp'
import { encryptOAuthPii, decryptOAuthPii } from '../utils/crypto'
import { sendEmail, buildVerificationEmail } from '../utils/mail'

const router: RouterType = Router()

/** Grant extra roles (e.g. 'reviewer' from GitHub org check) to a user within a transaction. */
async function grantExtraRoles(
  conn: import('mysql2/promise').PoolConnection,
  userId: string,
  extraRoles?: string[],
  grantedBy?: string,
): Promise<void> {
  if (!extraRoles || extraRoles.length === 0) return
  for (const roleName of extraRoles) {
    const [roleRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id FROM roles WHERE name = ?`, [roleName],
    )
    if (roleRows[0]) {
      await conn.execute(
        `INSERT IGNORE INTO user_roles (id, userId, roleId, grantedBy, createdAt) VALUES (?, ?, ?, ?, ?)`,
        [genId('ur_'), userId, roleRows[0].id, grantedBy || userId, Date.now()],
      )
    }
  }
}

const oauthConf = conf.OAUTH as Record<string, string | undefined> | undefined
const GITHUB_CLIENT_ID = oauthConf?.GITHUB_CLIENT_ID as string | undefined
const GITHUB_CLIENT_SECRET = oauthConf?.GITHUB_CLIENT_SECRET as string | undefined
const X_CLIENT_ID = oauthConf?.X_CLIENT_ID as string | undefined
const X_CLIENT_SECRET = oauthConf?.X_CLIENT_SECRET as string | undefined

const SESSION_CONF = conf.SESSION as Record<string, string | number | undefined> | undefined
const APP_URL = (conf.APP as Record<string, string | undefined> | undefined)?.FRONTEND_URL || 'https://submit.transcircle.org'
const API_URL = (conf.APP as Record<string, string | undefined> | undefined)?.API_URL || 'https://api.transcircle.org'

/**
 * Redirect with required security headers per api.md §1.6.2:
 * Cache-Control: no-store, Referrer-Policy: no-referrer
 */
function safeRedirect(res: import('express').Response, url: string): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.redirect(url)
}

/** Allowlist for redirectAfter in OAuth start per api.md §1.6.1 */
const REDIRECT_ALLOWLIST = [
  '/dashboard',
  '/settings',
  '/settings/security',
  '/settings/security/oauth-bind/confirm',
  '/auth/callback',
  '/auth/oauth/continue',
  '/auth/oauth/merge',
  '/auth/error',
]

function validateRedirectAfter(url: string | undefined): string {
  if (!url) return '/dashboard'
  // Strip query params for allowlist matching
  const pathOnly = url.split('?')[0]?.split('#')[0] ?? url
  const allowed = REDIRECT_ALLOWLIST.includes(pathOnly)
  if (!allowed) return '/dashboard'
  return url
}

// ──────────────────────────────────────────────
// POST /auth/refresh
// Refresh access token using HttpOnly refresh cookie or request body — api.md §1.11.2
// Proper rotation with reuse detection in rotateRefreshToken()
// ──────────────────────────────────────────────
router.post('/refresh', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  // Support both Cookie (browser) and request body (native clients) per api.md §1.11.2
  // Spec: "两者择一，同时存在以 Cookie 为准"
  const rawToken = (req.cookies?.refresh_token as string | undefined) ?? req.body?.refreshToken
  if (!rawToken) {
    metrics.authTokenRefreshTotal["expired"] = (metrics.authTokenRefreshTotal["expired"] || 0) + 1
    sendError(res, 'INVALID_REFRESH_TOKEN', '刷新令牌无效', req.requestId, 401)
    return
  }

  const tokenHash = await hmacToken(rawToken)
  const result = await rotateRefreshToken(rawToken)
  if (!result) {
    // Per api.md §1.11.2: audit reuse detection events
    const reuseEvent = await queryOne(
      `SELECT rte.status, rte.sessionId, s.userId
       FROM refresh_token_events rte
       LEFT JOIN sessions s ON s.id = rte.sessionId
       WHERE rte.tokenHash = ?`,
      [tokenHash],
    )
    if (reuseEvent && (reuseEvent.status === 'reused' || reuseEvent.status === 'revoked')) {
      writeAuditLog(req, {
        actorUserId: (reuseEvent.userId as string | null) || null,
        action: 'session.refresh_reuse_detected',
        resourceType: 'session',
        resourceId: (reuseEvent.sessionId as string) || null,
        after: { status: reuseEvent.status as string },
      }).catch((e: unknown) => console.error('audit error:', e))
    }
  metrics.authTokenRefreshTotal["reuse_detected"] = (metrics.authTokenRefreshTotal["reuse_detected"] || 0) + 1
    sendError(res, 'REFRESH_TOKEN_REVOKED', '刷新令牌已被吊销', req.requestId, 401)
    return
  }

  // Audit successful refresh per api.md §8
  writeAuditLog(req, {
    actorUserId: result.userId,
    action: 'auth.token.refresh',
    resourceType: 'session',
    resourceId: result.id,
    after: {},
  }).catch((e: unknown) => console.error('audit error:', e))

  // Sign new access token using the existing session (no new session created)
  const accessToken = await signJwt({
    sub: result.userId,
    sid: result.id,
    tokenVersion: result.tokenVersion,
    roles: result.roles,
    aud: 'transcircle-web',
    iss: 'https://api.transcircle.org',
  })

  // Determine if client is native (refreshToken came from body, not cookie)
  const isNativeClient = !!req.body?.refreshToken

  // Only set new refresh token cookie if race-grace returned a new one
  // (race-grace hit returns empty newRefreshToken — client already has it)
  if (result.newRefreshToken) {
    const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
    res.cookie('refresh_token', result.newRefreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/v1/auth',
      maxAge: maxAge * 1000,
    })
  }

  // Per api.md §1.11.2: browser clients get refreshToken via Set-Cookie,
  // but native clients (which passed refreshToken in request body) need
  // the new refreshToken in the response body too.
  const responseData: Record<string, unknown> = { accessToken, tokenType: 'Bearer', expiresIn: 900 }
  if (isNativeClient && result?.newRefreshToken) {
    responseData.refreshToken = result.newRefreshToken
  }
    metrics.authTokenRefreshTotal["success"] = (metrics.authTokenRefreshTotal["success"] || 0) + 1
  sendSuccess(res, responseData, req.requestId)
})

// ──────────────────────────────────────────────
// POST /auth/logout — api.md §1.11.3
// Revokes current session only, does NOT bump tokenVersion
// Returns 204 No Content
// ──────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res) => {
  // Audit log per api.md §1.11.3: action = session.revoke
  writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'session.revoke',
    resourceType: 'session',
    resourceId: req.user!.sessionId,
    after: { revokedReason: 'logout', sessionId: req.user!.sessionId },
  }).catch((e: unknown) => console.error('audit error:', e))
  await revokeSession(req.user!.sessionId, 'logout')
  await exec(`UPDATE refresh_token_events SET status = 'revoked' WHERE sessionId = ?`, [req.user!.sessionId])
  res.clearCookie('refresh_token', { path: '/v1/auth' })
  sendNoContent(res, req.requestId)
})

// ──────────────────────────────────────────────
// GET /auth/oauth/github/start — api.md §1.6.1
// ──────────────────────────────────────────────
router.get('/oauth/github/start', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    sendError(res, Errors.OAUTH_PROVIDER_ERROR.code, 'GitHub OAuth 未配置', req.requestId, 503)
    return
  }

  const state = genId('ost_')
  const callbackUrl = `${API_URL}/v1/auth/oauth/github/callback`
  const redirectAfter = validateRedirectAfter(req.query.redirectAfter as string | undefined)

  const stateHash = await hmacToken(state)
  const stateIp = req.ip || req.socket.remoteAddress || 'unknown'
  const stateUa = req.headers['user-agent'] || 'unknown'
  // Per api.md §1.6.1: state must bind provider, redirectAfter, ipHash, uaHash, mode
  const stateMeta = JSON.stringify({
    provider: 'github',
    mode: 'login',
    redirectAfter,
    ipHash: await hmacToken(stateIp),
    uaHash: await hmacToken(stateUa),
  })
  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, NULL, 'oauth_state', ?, ?, ?, ?)`,
    [ulid(), stateHash, stateMeta, Date.now() + 600_000, Date.now()],
  )

  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/v1/auth/oauth',
    maxAge: 600_000,
  })

  const authorizationUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=read:user+user:email&state=${state}`

  sendSuccess(res, { authorizationUrl, stateExpiresIn: 600 }, req.requestId)
})

// ──────────────────────────────────────────────
// POST /auth/oauth/complete-binding — api.md §1.6.5
// Bind pending OAuth identity to current logged-in user
// ──────────────────────────────────────────────
router.post('/oauth/complete-binding', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  // Requires Bearer Token
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, Errors.UNAUTHORIZED.code, Errors.UNAUTHORIZED.message, req.requestId, Errors.UNAUTHORIZED.status)
    return
  }

  const { verifyJwt } = await import('../utils/jwt')
  const payload = await verifyJwt(authHeader.slice(7))
  if (!payload) {
    sendError(res, Errors.UNAUTHORIZED.code, '登录已过期', req.requestId, Errors.UNAUTHORIZED.status)
    return
  }

  // 校验 user.status = 'active'
  const user = await findUserById(payload.sub)
  if (!user || user.status !== 'active') {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }

  // 校验 step-up (5 分钟内)
  const session = await queryOne(
    `SELECT lastStepUpAt FROM sessions WHERE id = ? AND userId = ?`,
    [payload.sid, payload.sub],
  )
  if (!session || !session.lastStepUpAt || Date.now() - session.lastStepUpAt > 300_000) {
    sendError(res, 'STEP_UP_REQUIRED', '需要二次认证', req.requestId, 403)
    return
  }

  // 从 Cookie 读取 pending token
  const provider = req.query.provider as string || 'github'
  const pendingCookieName = `oauth_pending_${provider}`
  const pendingToken = req.cookies?.[pendingCookieName] as string | undefined
  if (!pendingToken) {
    sendError(res, 'MISSING_OAUTH_PENDING', `缺少 ${pendingCookieName} Cookie`, req.requestId, 401)
    return
  }

  // CSRF 校验
  const csrfToken = req.headers['x-csrf-token'] as string | undefined
  const csrfCookie = req.cookies?.oauth_pending_csrf as string | undefined
  if (!csrfToken || csrfToken !== csrfCookie) {
    sendError(res, Errors.CSRF_TOKEN_INVALID.code, Errors.CSRF_TOKEN_INVALID.message, req.requestId, Errors.CSRF_TOKEN_INVALID.status)
    return
  }

  // Find and consume pending registration token
  const pendingHash = await hmacToken(pendingToken)
  const pendingRecord = await queryOne(
    `SELECT id, metadata FROM auth_tokens
     WHERE tokenHash = ? AND type = 'oauth_pending_registration' AND usedAt IS NULL AND expiresAt > ?`,
    [pendingHash, Date.now()],
  )
  if (!pendingRecord) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'OAuth pending token 无效', req.requestId, 410)
    return
  }

  const meta = typeof pendingRecord.metadata === 'string' ? JSON.parse(pendingRecord.metadata) : pendingRecord.metadata

  // Decrypt PII from encrypted metadata blob (api.md §1.6.2)
  if (meta.pii) {
    try {
      const pii = await decryptOAuthPii(meta.pii)
      // Also decrypt csrfToken from pii for validation
      Object.assign(meta, pii)
    } catch { /* corrupted pii — proceed with nulls */ }
  }

  // 原子检查 + 消费 + 写入 (事务 + FOR UPDATE 预防竞态, api.md §1.6.5)
  const { getConnection } = await import('../Database')
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    // 锁定 pending token
    const [lockPending] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id, metadata FROM auth_tokens
       WHERE tokenHash = ? AND type = 'oauth_pending_registration' AND usedAt IS NULL AND expiresAt > ?
       FOR UPDATE`,
      [pendingHash, Date.now()],
    )
    if ((lockPending as unknown[]).length === 0) {
      await conn.rollback()
      sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'OAuth pending token 无效', req.requestId, 410)
      return
    }

    // 检查当前用户在该 provider 下是否已有绑定 (行锁保护)
    const [lockBind] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id FROM oauth_accounts WHERE userId = ? AND provider = ? FOR UPDATE`,
      [payload.sub, meta.provider],
    )
    if ((lockBind as unknown[]).length > 0) {
      await conn.rollback()
      sendError(res, Errors.PROVIDER_ALREADY_BOUND.code, Errors.PROVIDER_ALREADY_BOUND.message, req.requestId, Errors.PROVIDER_ALREADY_BOUND.status)
      return
    }

    // 检查该 OAuth 身份是否已被其他账号绑定
    const [lockOa] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id, userId FROM oauth_accounts WHERE provider = ? AND providerUserId = ? FOR UPDATE`,
      [meta.provider, meta.providerUserId],
    )
    if ((lockOa as unknown[]).length > 0) {
      await conn.rollback()
      const conflictUserId = lockOa[0].userId as string
      // 生成 mergeToken per api.md §1.8
      const mergeToken = generateHighEntropyToken()
      const mergeHash = await hmacToken(mergeToken)
      await exec(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'merge', ?, ?, ?, ?)`,
        [ulid(), conflictUserId, mergeHash,
         JSON.stringify({ primaryUserId: payload.sub, conflictUserId, provider: meta.provider }),
         Date.now() + 600_000, Date.now()],
      )
      sendError(res, Errors.OAUTH_ALREADY_LINKED.code, '该 OAuth 账号已关联到另一个账号，请走账号合并流程', req.requestId, 409, undefined, {
        conflictUserId,
        mergeToken,
        mergeTokenExpiresIn: 600,
      })
      return
    }

    // 消费 pending token
    await conn.execute(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), lockPending[0].id])

    // 写入 oauth_accounts (UNIQUE 约束做最终安全网)
    try {
      await conn.execute(
        `INSERT INTO oauth_accounts (id, userId, provider, providerUserId, providerUsername, providerDisplayName, providerAvatarUrl, providerEmail, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [genId('oauth_'), payload.sub, meta.provider, meta.providerUserId, meta.providerUsername || null, meta.providerDisplayName || null, meta.providerAvatarUrl || null, meta.providerEmail || null, Date.now(), Date.now()],
      )
    } catch (insertErr: unknown) {
      const mysqlErr = insertErr as { code?: string }
      if (mysqlErr.code === 'ER_DUP_ENTRY') {
        await conn.rollback()
        sendError(res, Errors.OAUTH_ALREADY_LINKED.code, '该 OAuth 身份已被绑定', req.requestId, 409)
        return
      }
      throw insertErr
    }

    // Audit log per api.md §1.6.5
    await writeAuditLog(req, {
      actorUserId: payload.sub,
      action: 'oauth.bind',
      resourceType: 'oauth_account',
      resourceId: payload.sub,
      after: { provider: meta.provider },
    })

    await conn.commit()
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('oauth complete-binding error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '绑定失败', req.requestId, 500)
    return
  } finally {
    conn.release()
  }

  // 清除 pending cookies
  res.clearCookie(`oauth_pending_${provider}`, { path: '/v1/auth/oauth' })
  res.clearCookie('oauth_pending_csrf', { path: '/' })

  sendSuccess(res, {
    userId: payload.sub,
    boundProvider: meta.provider,
    providerUsername: meta.providerUsername || null,
    boundAt: Date.now(),
  }, req.requestId)
})

// ──────────────────────────────────────────────
// GET /auth/oauth/pending-profile — api.md §1.6.6
// Fetch OAuth pending profile for pre-fill
// ──────────────────────────────────────────────
router.get('/oauth/pending-profile', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const provider = req.query.provider as string || 'github'
  const csrfToken = req.headers['x-csrf-token'] as string | undefined
  const csrfCookie = req.cookies?.oauth_pending_csrf as string | undefined

  if (!csrfToken || csrfToken !== csrfCookie) {
    sendError(res, Errors.CSRF_TOKEN_INVALID.code, Errors.CSRF_TOKEN_INVALID.message, req.requestId, Errors.CSRF_TOKEN_INVALID.status)
    return
  }

  const pendingCookieName = `oauth_pending_${provider}`
  const pendingToken = req.cookies?.[pendingCookieName] as string | undefined
  if (!pendingToken) {
    sendError(res, 'MISSING_OAUTH_PENDING', `缺少 ${pendingCookieName} Cookie`, req.requestId, 401)
    return
  }

  const pendingHash = await hmacToken(pendingToken)
  const pendingRecord = await queryOne(
    `SELECT metadata, expiresAt FROM auth_tokens
     WHERE tokenHash = ? AND type = 'oauth_pending_registration' AND usedAt IS NULL`,
    [pendingHash],
  )

  if (!pendingRecord || pendingRecord.expiresAt < Date.now()) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'Pending token 已过期', req.requestId, 410)
    return
  }

  const meta = typeof pendingRecord.metadata === 'string' ? JSON.parse(pendingRecord.metadata) : pendingRecord.metadata
  const expiresIn = Math.max(0, Math.floor((pendingRecord.expiresAt - Date.now()) / 1000))

  // Decrypt PII per api.md §1.6.2
  let pii: { providerEmail?: string | null; providerDisplayName?: string | null; providerEmailVerified?: boolean } = {}
  if (meta.pii) {
    try { pii = await decryptOAuthPii(meta.pii) } catch { /* corrupted pii — return nulls */ }
  }

  sendSuccess(res, {
    provider: meta.provider,
    mode: meta.mode || 'registration',
    suggestedEmail: pii.providerEmail || null,
    suggestedDisplayName: pii.providerDisplayName || null,
    providerEmailVerified: !!pii.providerEmailVerified,
    expiresIn,
  }, req.requestId)
})

// ──────────────────────────────────────────────
// OAuth 回调统一分流逻辑 — api.md §1.6.2
// ──────────────────────────────────────────────
async function handleOAuthCallback(
  provider: 'github' | 'x',
  providerUserId: string,
  providerData: {
    username: string
    displayName: string
    avatarUrl: string | null
    email: string | null
    emailVerified: boolean
  },
  req: import('express').Request,
  res: import('express').Response,
  extraRoles?: string[],
): Promise<void> {
  const state = req.query.state as string | undefined
  const cookieState = req.cookies?.oauth_state

  if (cookieState !== state) {
    res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
    safeRedirect(res, `${APP_URL}/auth/error?status=bad_state`)
    return
  }

  // Verify state record
  if (!state) {
    res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
    safeRedirect(res, `${APP_URL}/auth/error?status=bad_state`)
    return
  }

  const stateHash = await hmacToken(state)
  const stateRecord = await queryOne(
    `SELECT id, metadata FROM auth_tokens WHERE tokenHash = ? AND type = 'oauth_state' AND expiresAt > ?`,
    [stateHash, Date.now()],
  )
  if (!stateRecord) {
    res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
    safeRedirect(res, `${APP_URL}/auth/error?status=bad_state`)
    return
  }

  const stateMeta = typeof stateRecord.metadata === 'string' ? JSON.parse(stateRecord.metadata) : stateRecord.metadata
  const cbIp = req.ip || req.socket.remoteAddress || 'unknown'
  const cbUa = req.headers['user-agent'] || 'unknown'
  if (
    (stateMeta.ipHash && stateMeta.ipHash !== (await hmacToken(cbIp))) ||
    (stateMeta.uaHash && stateMeta.uaHash !== (await hmacToken(cbUa)))
  ) {
    await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), stateRecord.id])
    res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
    safeRedirect(res, `${APP_URL}/auth/error?status=bad_state`)
    return
  }

  // Consume state per api.md §1.6.2: mark usedAt, don't delete
  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), stateRecord.id])
  res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })

  const mode = (stateMeta.mode as 'login' | 'bind') || 'login'
  const redirectAfter = stateMeta.redirectAfter || '/dashboard'

  // Look up existing OAuth binding
  const existing = await queryOne(
    `SELECT oa.userId, u.status, u.tokenVersion
     FROM oauth_accounts oa JOIN users u ON u.id = oa.userId
     WHERE oa.provider = ? AND oa.providerUserId = ?`,
    [provider, providerUserId],
  )

  const now = Date.now()

  if (existing) {
    // OAuth 已绑定到本地账号
    if (mode === 'bind') {
      if (stateMeta.userId && existing.userId === stateMeta.userId) {
        safeRedirect(res, `${APP_URL}/settings/security?status=bind_already_self&provider=${provider}`)
        return
      } else {
        // 已绑定到其他用户 → 合并流程
        const mergeToken = generateHighEntropyToken()
        const mergeHash = await hmacToken(mergeToken)
        await exec(
          `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
           VALUES (?, ?, 'merge', ?, ?, ?, ?)`,
          [ulid(), existing.userId, mergeHash,
           JSON.stringify({ primaryUserId: stateMeta.userId, conflictUserId: existing.userId, provider }),
           now + 600_000, now],
        )
        safeRedirect(res, `${APP_URL}/auth/oauth/merge?status=bind_conflict_merge&mergeToken=${mergeToken}&conflictUserId=${existing.userId}`)
        return
      }
    }

    // mode === 'login'
    switch (existing.status) {
      case 'active':
      case 'pending_verification': {
        // Audit login success per api.md §1.6.2
        writeAuditLog(req, {
          actorUserId: existing.userId,
          action: 'auth.login.success',
          resourceType: 'user',
          resourceId: existing.userId,
          after: { method: `oauth:${provider}` },
        }).catch((e: unknown) => console.error('audit error:', e))

        const ip = req.ip || req.socket.remoteAddress || 'unknown'
        const ua = req.headers['user-agent'] || 'unknown'

        // Fetch actual roles per api.md §15.10
        const userRoleRows = await import('../Database').then(d => d.query(
          `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = ?`,
          [existing.userId],
        ))
        const sessionRoles = (userRoleRows as Array<{ name: string }>).map(r => r.name)

        // Grant extraRoles (e.g. 'reviewer' from org check) if not already granted
        if (extraRoles && extraRoles.length > 0) {
          for (const roleName of extraRoles) {
            if (!sessionRoles.includes(roleName)) {
              const roleRow = await import('../Database').then(d => d.queryOne(`SELECT id FROM roles WHERE name = ?`, [roleName]))
              if (roleRow) {
                await exec(
                  `INSERT IGNORE INTO user_roles (id, userId, roleId, grantedBy, createdAt) VALUES (?, ?, ?, ?, ?)`,
                  [genId('ur_'), existing.userId, roleRow.id, existing.userId, now],
                )
              }
            }
          }
        }

        const { sessionId, refreshToken } = await createSession(
          existing.userId,
          sessionRoles,
          `oauth:${provider}`,
          ip, ua,
        )

        // Per api.md §1.6.2: login_ok 时 lastStepUpAt 必须为 NULL
        await exec(
          `UPDATE sessions SET lastStepUpAt = NULL WHERE id = ?`,
          [sessionId],
        )

        // Create login code per api.md §1.6.2:
        // auth_tokens.metadata MUST bind sessionId, requestIpHash, userAgentHash
        const loginCode = genId('oa_lc_')
        const loginCodeHash = await hmacToken(loginCode)
        const loginCodeIpHash = await hmacToken(ip)
        const loginCodeUaHash = await sha256base64url(ua)
        await exec(
          `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
           VALUES (?, ?, 'oauth_login_code', ?,
           JSON_OBJECT('sessionId', ?, 'requestIpHash', ?, 'userAgentHash', ?, 'provider', ?), ?, ?)`,
          [ulid(), existing.userId, loginCodeHash,
           sessionId, loginCodeIpHash, loginCodeUaHash, provider,
           now + 60_000, now],
        )

        const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
        res.cookie('refresh_token', refreshToken, {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/v1/auth',
          maxAge: maxAge * 1000,
        })

        safeRedirect(res, `${APP_URL}/auth/callback?status=login_ok&loginCode=${loginCode}&redirectAfter=${encodeURIComponent(redirectAfter)}`)
        return
      }
      case 'banned':
        writeAuditLog(req, { actorUserId: existing.userId, action: 'auth.login.fail', resourceType: 'user', resourceId: existing.userId, after: { reason: 'banned' } }).catch((e: unknown) => console.error('audit error:', e))
        safeRedirect(res, `${APP_URL}/auth/error?status=login_blocked&code=ACCOUNT_BANNED`)
        return
      case 'merged':
        writeAuditLog(req, { actorUserId: existing.userId, action: 'auth.login.fail', resourceType: 'user', resourceId: existing.userId, after: { reason: 'merged' } }).catch((e: unknown) => console.error('audit error:', e))
        safeRedirect(res, `${APP_URL}/auth/error?status=login_blocked&code=ACCOUNT_MERGED`)
        return
      case 'pending_deletion':
        writeAuditLog(req, { actorUserId: existing.userId, action: 'auth.login.fail', resourceType: 'user', resourceId: existing.userId, after: { reason: 'pending_deletion' } }).catch((e: unknown) => console.error('audit error:', e))
        safeRedirect(res, `${APP_URL}/auth/error?status=login_blocked&code=ACCOUNT_PENDING_DELETION`)
        return
      case 'deleted':
        writeAuditLog(req, { actorUserId: existing.userId, action: 'auth.login.fail', resourceType: 'user', resourceId: existing.userId, after: { reason: 'deleted' } }).catch((e: unknown) => console.error('audit error:', e))
        safeRedirect(res, `${APP_URL}/auth/error?status=login_blocked&code=ACCOUNT_DELETED`)
        return
      default:
        writeAuditLog(req, { actorUserId: existing.userId, action: 'auth.login.fail', resourceType: 'user', resourceId: existing.userId, after: { reason: 'unknown_status' } }).catch((e: unknown) => console.error('audit error:', e))
        safeRedirect(res, `${APP_URL}/auth/error?status=oauth_error`)
        return
    }
  }

  // OAuth 未绑定
  if (mode === 'bind') {
    // 检查该 provider 下是否已有绑定
    const providerBound = await queryOne(
      `SELECT id FROM oauth_accounts WHERE userId = ? AND provider = ?`,
      [stateMeta.userId, provider],
    )
    if (providerBound) {
      safeRedirect(res, `${APP_URL}/auth/error?status=bind_provider_taken&provider=${provider}`)
      return
    }

    // 生成 pending 注册 token（binding 模式）
    const pendingToken = genId('opt_')
    const pendingHash = await hmacToken(pendingToken)
    const csrfToken = genId('ocs_')
    const csrfHash = await hmacToken(csrfToken)

    const bindPii = await encryptOAuthPii({
      providerUsername: providerData.username,
      providerDisplayName: providerData.displayName,
      providerAvatarUrl: providerData.avatarUrl,
      providerEmail: providerData.email,
      providerEmailVerified: providerData.emailVerified,
      csrfToken,
    })

    await exec(
      `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
       VALUES (?, ?, 'oauth_pending_registration', ?, ?, ?, ?)`,
      [ulid(), stateMeta.userId, pendingHash,
       JSON.stringify({
         provider, providerUserId, mode: 'binding', userId: stateMeta.userId,
         extraRoles: extraRoles || [],
         pii: bindPii,
         requestIpHash: await hmacToken(cbIp),
         userAgentHash: await hmacToken(cbUa),
       }),
       now + 600_000, now],
    )

    await exec(
      `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
       VALUES (?, ?, 'oauth_pending_registration', ?, JSON_OBJECT('csrfFor', ?), ?, ?)`,
      [ulid(), stateMeta.userId, csrfHash, pendingToken, now + 600_000, now],
    )

    // 设置 oauth_pending_{provider} HttpOnly Cookie（per api.md §1.6.1）
    res.cookie(`oauth_pending_${provider}`, pendingToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/v1/auth/oauth',
      maxAge: 600_000,
    })

    // 设置 CSRF Cookie（非 HttpOnly，前端可读，Path=/ 以便前端 JS 可从任何页面读取）
    res.cookie('oauth_pending_csrf', csrfToken, {
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600_000,
    })

    // Audit log per api.md §15.13
    writeAuditLog(req, {
      actorUserId: stateMeta.userId,
      action: 'oauth.bind.callback_pending_binding',
      resourceType: 'oauth_account',
      resourceId: stateMeta.userId,
      after: { provider, status: 'pending_binding' },
    }).catch((e: unknown) => console.error('audit error:', e))

    safeRedirect(res, `${APP_URL}/settings/security/oauth-bind/confirm?status=pending_binding&provider=${provider}`)
    return
  }

  // mode === 'login' — 生成 pending 注册 token
  const pendingToken = genId('opt_')
  const pendingHash = await hmacToken(pendingToken)
  const csrfToken = genId('ocs_')
  const csrfHash = await hmacToken(csrfToken)

  const loginPii = await encryptOAuthPii({
    providerUsername: providerData.username,
    providerDisplayName: providerData.displayName,
    providerAvatarUrl: providerData.avatarUrl,
    providerEmail: providerData.email,
    providerEmailVerified: providerData.emailVerified,
    csrfToken,
  })

  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, NULL, 'oauth_pending_registration', ?, ?, ?, ?)`,
    [ulid(), pendingHash,
     JSON.stringify({
       provider, providerUserId, mode: 'registration',
       extraRoles: extraRoles || [],
       pii: loginPii,
       requestIpHash: await hmacToken(cbIp),
       userAgentHash: await hmacToken(cbUa),
     }),
     now + 600_000, now],
  )

  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, NULL, 'oauth_pending_registration', ?, JSON_OBJECT('csrfFor', ?), ?, ?)`,
    [ulid(), csrfHash, pendingToken, now + 600_000, now],
  )

  // Set oauth_pending_<provider> HttpOnly cookie
  res.cookie(`oauth_pending_${provider}`, pendingToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/v1/auth/oauth',
    maxAge: 600_000,
  })

  // Set CSRF cookie
  res.cookie('oauth_pending_csrf', csrfToken, {
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600_000,
  })

  safeRedirect(res, `${APP_URL}/auth/oauth/continue?status=pending_registration&provider=${provider}`)
}

// ──────────────────────────────────────────────
// GET /auth/oauth/github/callback — api.md §1.6.2
// ──────────────────────────────────────────────
router.get('/oauth/github/callback', async (req, res) => {
  const code = req.query.code as string | undefined
  if (!code) {
    res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
    safeRedirect(res, `${APP_URL}/auth/error?status=oauth_error`)
    return
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code }),
    })
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
    if (!tokenData.access_token) {
      res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
      safeRedirect(res, `${APP_URL}/auth/error?status=oauth_error`)
      return
    }

    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'TransCircle' },
    })
    const githubUser = await userRes.json() as {
      id: number; login: string; name: string | null; avatar_url: string | null; email: string | null
    }

    let email = githubUser.email
    if (!email) {
      try {
        const emailRes = await fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'TransCircle', Accept: 'application/vnd.github.v3+json' },
        })
        const emails = await emailRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>
        const primary = emails.find((e) => e.primary && e.verified)
        if (primary) email = primary.email
      } catch { /* ignore */ }
    }

    // Check GitHub org membership for automatic reviewer role (api.md §15.10)
    const githubOrg = (conf.GITHUB as Record<string, string | undefined> | undefined)?.GITHUB_ORG
    const extraRoles: string[] = []
    if (githubOrg && tokenData.access_token) {
      try {
        const orgRes = await fetch(`https://api.github.com/orgs/${encodeURIComponent(githubOrg)}/members/${githubUser.login}`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'TransCircle', Accept: 'application/vnd.github.v3+json' },
        })
        if (orgRes.status === 204) extraRoles.push('reviewer')
      } catch { /* best-effort */ }
    }

    await handleOAuthCallback('github', String(githubUser.id), {
      username: githubUser.login,
      displayName: githubUser.name || githubUser.login,
      avatarUrl: githubUser.avatar_url,
      email: email || null,
      emailVerified: !!email,
    }, req, res, extraRoles)

    // api.md §1.6.2: 显式清理 provider access token，避免泄漏至错误追踪或堆栈
    writeAuditLog(req, {
      actorUserId: null,
      action: 'oauth.provider_token.discard',
      resourceType: 'oauth_account',
      resourceId: '',
      after: { provider: 'github', reason: 'callback_completed' },
    }).catch((e: unknown) => console.error('audit error:', e))
    tokenData.access_token = undefined
  } catch (err) {
    console.error('GitHub OAuth error:', err)
    res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
    safeRedirect(res, `${APP_URL}/auth/error?status=oauth_error`)
  }
})

// ──────────────────────────────────────────────
// GET /auth/oauth/x/start — api.md §1.6.1
// ──────────────────────────────────────────────
router.get('/oauth/x/start', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  if (!X_CLIENT_ID) {
    sendError(res, Errors.OAUTH_PROVIDER_ERROR.code, 'X OAuth 未配置', req.requestId, 503)
    return
  }

  const state = genId('ost_')
  const codeVerifier = ulid() + ulid()
  // S256 code challenge per api.md §1.6.7
  const codeChallengeEnc = new TextEncoder()
  const codeChallengeDigest = await crypto.subtle.digest('SHA-256', codeChallengeEnc.encode(codeVerifier))
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(codeChallengeDigest)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const callbackUrl = `${API_URL}/v1/auth/oauth/x/callback`
  const redirectAfter = validateRedirectAfter(req.query.redirectAfter as string | undefined)

  const stateHash = await hmacToken(state)
  const xStateIp = req.ip || req.socket.remoteAddress || 'unknown'
  const xStateUa = req.headers['user-agent'] || 'unknown'
  // Per api.md §1.6.1: state must bind provider, redirectAfter, ipHash, uaHash, mode
  const xStateMeta = JSON.stringify({
    provider: 'x',
    mode: 'login',
    redirectAfter,
    codeVerifier,
    codeChallenge,
    ipHash: await hmacToken(xStateIp),
    uaHash: await hmacToken(xStateUa),
  })
  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, NULL, 'oauth_state', ?, ?, ?, ?)`,
    [ulid(), stateHash, xStateMeta, Date.now() + 600_000, Date.now()],
  )

  res.cookie('oauth_state', state, {
    httpOnly: true, secure: true,
    sameSite: 'lax', path: '/v1/auth/oauth', maxAge: 600_000,
  })

  const scopes = encodeURIComponent('tweet.read users.read')
  const authorizationUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${X_CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${scopes}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`

  sendSuccess(res, { authorizationUrl, stateExpiresIn: 600 }, req.requestId)
})

// ──────────────────────────────────────────────
// GET /auth/oauth/x/callback — api.md §1.6.2
// ──────────────────────────────────────────────
router.get('/oauth/x/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string }
  if (!code) {
    res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
    safeRedirect(res, `${APP_URL}/auth/error?status=oauth_error`)
    return
  }

  try {
    // Verify state and code verifier from DB
    const stateHash = await hmacToken(state || '')
    const stateRecord = await queryOne(
      `SELECT id, metadata FROM auth_tokens WHERE tokenHash = ? AND type = 'oauth_state' AND expiresAt > ?`,
      [stateHash, Date.now()],
    )
    if (!stateRecord) {
      res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
      safeRedirect(res, `${APP_URL}/auth/error?status=bad_state`)
      return
    }

    const meta = typeof stateRecord.metadata === 'string' ? JSON.parse(stateRecord.metadata) : stateRecord.metadata
    const codeVerifier = meta.codeVerifier

    const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: `${API_URL}/v1/auth/oauth/x/callback`, code_verifier: codeVerifier }),
    })
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
    if (!tokenData.access_token) {
      res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
      safeRedirect(res, `${APP_URL}/auth/error?status=oauth_error`)
      return
    }

    const userRes = await fetch('https://api.twitter.com/2/users/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const userData = await userRes.json() as { data?: { id: string; username: string; name: string } }
    if (!userData.data) {
      res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
      safeRedirect(res, `${APP_URL}/auth/error?status=oauth_error`)
      return
    }

    const { id, username, name } = userData.data

    await handleOAuthCallback('x', id, {
      username,
      displayName: name || username,
      avatarUrl: null,
      email: null,
      emailVerified: false,
    }, req, res)

    // api.md §1.6.2: 清理 provider access token
    writeAuditLog(req, {
      actorUserId: null,
      action: 'oauth.provider_token.discard',
      resourceType: 'oauth_account',
      resourceId: '',
      after: { provider: 'x', reason: 'callback_completed' },
    }).catch((e: unknown) => console.error('audit error:', e))
    if (typeof tokenData !== 'undefined') (tokenData as Record<string, unknown>).access_token = undefined
  } catch (err) {
    console.error('X OAuth error:', err)
    res.clearCookie('oauth_state', { path: '/v1/auth/oauth' })
    safeRedirect(res, `${APP_URL}/auth/error?status=oauth_error`)
  }
})

// ──────────────────────────────────────────────
// POST /auth/oauth/complete-registration — api.md §1.6.4
// Complete OAuth registration with username/password etc.
// ──────────────────────────────────────────────
router.post('/oauth/complete-registration', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const provider = req.query.provider as string || 'github'

  // CSRF validation: X-CSRF-Token must match oauth_pending_csrf cookie
  const csrfToken = req.headers['x-csrf-token'] as string | undefined
  const csrfCookie = req.cookies?.oauth_pending_csrf as string | undefined
  if (!csrfToken || !csrfCookie || csrfToken !== csrfCookie) {
    sendError(res, Errors.CSRF_TOKEN_INVALID.code, Errors.CSRF_TOKEN_INVALID.message, req.requestId, Errors.CSRF_TOKEN_INVALID.status)
    return
  }

  const pendingCookieName = `oauth_pending_${provider}`
  const pendingToken = req.cookies?.[pendingCookieName] as string | undefined
  if (!pendingToken) {
    sendError(res, 'MISSING_OAUTH_PENDING', `缺少 ${pendingCookieName} Cookie`, req.requestId, 401)
    return
  }

  const parsed = completeRegistrationSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 422, zodErrorsToDetails(parsed.error.flatten()))
    return
  }

  const { username, password, displayName, emailMatchesProvider } = parsed.data
  // Normalize email: lowercase per api.md §1.1
  const email = parsed.data.email.toLowerCase()

  // api.md §1.1: HIBP k-Anonymity leak check
  if (!await isPasswordNotLeaked(password)) {
    sendError(res, Errors.VALIDATION_ERROR.code, '该密码已在公开泄露中出现，请更换密码', req.requestId, 422)
    return
  }

  const now = Date.now()
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'

  // Transaction with row-level lock
  const { getConnection } = await import('../Database')
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    // Look up oauth_pending_registration by pendingToken hash (contains actual provider data)
    // IMPORTANT: filter usedAt IS NULL to prevent concurrent requests from both passing (api.md §1.6.4)
    const pendingHash = await hmacToken(pendingToken)
    const [lockRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id, userId, metadata FROM auth_tokens
       WHERE tokenHash = ? AND type = 'oauth_pending_registration' AND usedAt IS NULL
       FOR UPDATE`,
      [pendingHash],
    )

    if ((lockRows as unknown[]).length === 0) {
      await conn.rollback()
      sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'Pending token 无效或已过期', req.requestId, 410)
      return
    }

    const pendingRecord = lockRows[0] as { id: string; userId: string; metadata: string }
    const meta = typeof pendingRecord.metadata === 'string' ? JSON.parse(pendingRecord.metadata) : pendingRecord.metadata

    // Decrypt PII from encrypted metadata blob (api.md §1.6.2)
    if (meta.pii) {
      try {
        const pii = await decryptOAuthPii(meta.pii)
        Object.assign(meta, pii)
      } catch {
        await conn.rollback()
        sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '加密数据损坏', req.requestId, 410)
        return
      }
    }

    // Verify this is a registration-mode token with actual provider data (not a csrf-only record)
    if (!meta.provider || !meta.providerUserId) {
      await conn.rollback()
      sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '无效的 pending token', req.requestId, 410)
      return
    }

    // Check uniqueness
    const [existingUsername] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id FROM users WHERE username = ? AND id != ?`,
      [username, pendingRecord.userId || '_new'],
    )
    if ((existingUsername as unknown[]).length > 0) {
      await conn.rollback()
      sendError(res, Errors.USERNAME_TAKEN.code, Errors.USERNAME_TAKEN.message, req.requestId, Errors.USERNAME_TAKEN.status)
      return
    }

    const [existingEmail] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id FROM users WHERE email = ? AND id != ?`,
      [email, pendingRecord.userId || '_new'],
    )
    if ((existingEmail as unknown[]).length > 0) {
      await conn.rollback()
      sendError(res, Errors.EMAIL_TAKEN.code, Errors.EMAIL_TAKEN.message, req.requestId, Errors.EMAIL_TAKEN.status)
      return
    }

    // Hash password with argon2id (per api.md 安全基线)
    const passwordHash = await hashPassword(password)

    // Mark pending token as used
    await conn.execute(`UPDATE auth_tokens SET usedAt = ? WHERE id = ? AND usedAt IS NULL`, [now, pendingRecord.id])

    if (pendingRecord.userId) {
      // Update existing stub user (created by OAuth callback)
      const emailVerified = !!(emailMatchesProvider && meta.providerEmailVerified)
      const emailVerifiedSource = emailVerified ? `oauth:${meta.provider}` : null
      await conn.execute(
        `UPDATE users SET username = ?, email = ?, emailVerified = ?, emailVerifiedSource = ?,
         displayName = COALESCE(NULLIF(?, ''), displayName),
         passwordHash = ?, passwordUpdatedAt = ?, status = 'active', updatedAt = ? WHERE id = ?`,
        [username, email, emailVerified, emailVerifiedSource, displayName || username, passwordHash, now, now, pendingRecord.userId],
      )

      // Insert OAuth binding if not yet bound
      await conn.execute(
        `INSERT IGNORE INTO oauth_accounts (id, userId, provider, providerUserId, providerUsername, providerDisplayName, providerAvatarUrl, providerEmail, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [genId('oauth_'), pendingRecord.userId, meta.provider, meta.providerUserId, meta.providerUsername || null, meta.providerDisplayName || null, meta.providerAvatarUrl || null, meta.providerEmail || null, now, now],
      )

      // Grant extra roles from pending token metadata (e.g. 'reviewer' from org check)
      await grantExtraRoles(conn, pendingRecord.userId, meta.extraRoles as string[] | undefined, pendingRecord.userId)

      const user = await findUserById(pendingRecord.userId)
      if (!user) {
        await conn.rollback()
        sendError(res, Errors.INTERNAL_ERROR.code, '用户查询失败', req.requestId, 500)
        return
      }

      // Create session
      const { sessionId, refreshToken } = await createSession(user.id, user.roles, `oauth:${provider}`, ip, ua)

      // Generate login code
      const loginCode = genId('oa_lc_')
      const loginCodeHash = await hmacToken(loginCode)
      await conn.execute(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'oauth_login_code', ?, JSON_OBJECT('sessionId', ?, 'provider', ?), ?, ?)`,
        [ulid(), user.id, loginCodeHash, sessionId, provider, now + 60_000, now],
      )

      // Audit logs
      await writeAuditLog(req, {
        actorUserId: pendingRecord.userId,
        action: 'auth.register',
        resourceType: 'user',
        resourceId: pendingRecord.userId,
        after: { username, email, provider },
      })

      await conn.commit()

      const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
      res.cookie('refresh_token', refreshToken, {
        httpOnly: true, secure: true,
        sameSite: 'lax', path: '/v1/auth', maxAge: maxAge * 1000,
      })

      res.clearCookie(`oauth_pending_${provider}`, { path: '/v1/auth/oauth' })
      res.clearCookie('oauth_pending_csrf', { path: '/' })

      // Send verification email if needed per api.md §1.6.4
      let verificationEmailSent = false
      if (!emailVerified && email) {
        const rawVerifyToken = genId('ev_')
        const verifyHash = await hmacToken(rawVerifyToken)
        await conn.execute(
          `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
           VALUES (?, ?, 'email_verify', ?, '{}', ?, ?)`,
          [ulid(), user.id, verifyHash, now + 86400_000, now],
        )
        verificationEmailSent = await sendEmail(buildVerificationEmail(email, rawVerifyToken))
      }

      sendSuccess(res, {
        user: {
          id: user.id, username, email,
          displayName: user.displayName, avatarUrl: user.avatarUrl,
          emailVerified,
          status: 'active',
          createdAt: user.createdAt,
        },
        boundProvider: provider as 'github' | 'x',
        loginCode,
        verificationEmailSent,
      }, req.requestId, 201)
      return
    } else {
      // Create new user
      const userId = genId('usr_')
      const emailVerified = !!(emailMatchesProvider && meta.providerEmailVerified)
      const emailVerifiedSource = emailVerified ? `oauth:${meta.provider}` : null
      await conn.execute(
        `INSERT INTO users (id, username, email, emailVerified, emailVerifiedSource, displayName, avatarUrl, passwordHash, passwordUpdatedAt, passwordHistory, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, username, email, emailVerified, emailVerifiedSource, displayName || username,
         meta.providerAvatarUrl || null, passwordHash, now, JSON.stringify([passwordHash]),
         emailVerified ? 'active' : 'pending_verification', now, now],
      )

      // Insert OAuth binding
      await conn.execute(
        `INSERT IGNORE INTO oauth_accounts (id, userId, provider, providerUserId, providerUsername, providerDisplayName, providerAvatarUrl, providerEmail, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [genId('oauth_'), userId, meta.provider, meta.providerUserId, meta.providerUsername || null, meta.providerDisplayName || null, meta.providerAvatarUrl || null, meta.providerEmail || null, now, now],
      )

      // Grant extra roles from pending token metadata (e.g. 'reviewer' from org check)
      await grantExtraRoles(conn, userId, meta.extraRoles as string[] | undefined, userId)

      // Use the new userId for session creation
      const user = await findUserById(userId)
      if (!user) {
        await conn.rollback()
        sendError(res, Errors.INTERNAL_ERROR.code, '用户创建失败', req.requestId, 500)
        return
      }

      // Create session
      const { sessionId, refreshToken } = await createSession(user.id, user.roles, `oauth:${provider}`, ip, ua)

      // Generate login code
      const loginCode = genId('oa_lc_')
      const loginCodeHash = await hmacToken(loginCode)
      await conn.execute(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'oauth_login_code', ?, JSON_OBJECT('sessionId', ?, 'provider', ?), ?, ?)`,
        [ulid(), user.id, loginCodeHash, sessionId, provider, now + 60_000, now],
      )

      // Audit logs
      await writeAuditLog(req, {
        actorUserId: userId,
        action: 'auth.register',
        resourceType: 'user',
        resourceId: userId,
        after: { username, email, provider },
      })
      await writeAuditLog(req, {
        actorUserId: userId,
        action: 'oauth.bind',
        resourceType: 'user',
        resourceId: userId,
        after: { provider, bound: true },
      })

      // Send verification email if needed per api.md §1.6.9
      let verificationEmailSent = false
      if (!emailVerified && email) {
        const rawVerifyToken = genId('ev_')
        const verifyHash = await hmacToken(rawVerifyToken)
        await conn.execute(
          `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
           VALUES (?, ?, 'email_verify', ?, '{}', ?, ?)`,
          [ulid(), userId, verifyHash, now + 86400_000, now],
        )
        verificationEmailSent = await sendEmail(buildVerificationEmail(email, rawVerifyToken))
      }

      await conn.commit()

      const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
      res.cookie('refresh_token', refreshToken, {
        httpOnly: true, secure: true,
        sameSite: 'lax', path: '/v1/auth', maxAge: maxAge * 1000,
      })

      res.clearCookie(`oauth_pending_${provider}`, { path: '/v1/auth/oauth' })
      res.clearCookie('oauth_pending_csrf', { path: '/' })

      sendSuccess(res, {
        user: {
          id: user.id, username, email,
          displayName: user.displayName, avatarUrl: user.avatarUrl,
          emailVerified, status: emailVerified ? 'active' : 'pending_verification',
          createdAt: user.createdAt,
        },
        boundProvider: provider as 'github' | 'x',
        loginCode,
        verificationEmailSent,
      }, req.requestId, 201)
      return
    }

    // (both branches above return — no additional commit needed here)
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('complete-registration error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '注册失败', req.requestId, 500)
  } finally {
    conn.release()
  }
})

// ──────────────────────────────────────────────
// POST /auth/oauth/exchange — api.md §1.6.3
// Exchange loginCode for access token
// ──────────────────────────────────────────────
router.post('/oauth/exchange', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const parsed = loginCodeSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, 'loginCode 不能为空', req.requestId, Errors.VALIDATION_ERROR.status)
    return
  }

  const { loginCode } = parsed.data
  const loginCodeHash = await hmacToken(loginCode)
  const { getConnection } = await import('../Database')

  let userId: string | null
  let existingSessionId: string | undefined
  let exchangeProvider: string | undefined
  {
    const conn = await getConnection()
    try {
      await conn.beginTransaction()

      const [lockRows] = await conn.execute(
        `SELECT id, userId, expiresAt, metadata FROM auth_tokens
         WHERE tokenHash = ? AND type = 'oauth_login_code'
         FOR UPDATE`,
        [loginCodeHash],
      )
      const rows = lockRows as Array<{ id: string; userId: string; expiresAt: number; metadata: string }>
      const token = rows[0] ?? null

      if (!token) {
        await conn.rollback()
        sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'loginCode 无效', req.requestId, 410)
        return
      }

      if (token.expiresAt < Date.now()) {
        await conn.execute(`DELETE FROM auth_tokens WHERE id = ?`, [token.id])
        await conn.commit()
        sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'loginCode 已过期', req.requestId, 410)
        return
      }

      // Extract metadata from token before consuming
      const meta = (() => {
        try {
          return typeof token.metadata === 'string' ? JSON.parse(token.metadata) : token.metadata
        } catch { return {} }
      })()
      existingSessionId = meta.sessionId as string | undefined

      // Extract provider from loginCode metadata for session creation fallback
      exchangeProvider = meta.provider as string | undefined

      // Validate requestIpHash per api.md §1.6.2
      const metaIpHash = meta.requestIpHash as string | undefined
      if (metaIpHash) {
        const currentIp = req.ip || req.socket.remoteAddress || 'unknown'
        const currentIpHash = await hmacToken(currentIp)
        if (currentIpHash !== metaIpHash) {
          await conn.rollback()
          sendError(res, 'BAD_STATE', '请求 IP 与登录时不匹配', req.requestId, 400)
          return
        }
      }

      // Validate userAgentHash per api.md §1.6.2
      const metaUaHash = meta.userAgentHash as string | undefined
      if (metaUaHash) {
        const currentUa = req.headers['user-agent'] || 'unknown'
        const currentUaHash = await sha256base64url(currentUa)
        if (currentUaHash !== metaUaHash) {
          await conn.rollback()
          sendError(res, 'BAD_STATE', 'User-Agent 与登录时不匹配', req.requestId, 400)
          return
        }
      }

      // Validate refresh_token Cookie per api.md §1.6.3
      const refreshTokenCookieHeader = req.cookies?.refresh_token as string | undefined
      if (!refreshTokenCookieHeader) {
        await conn.rollback()
        sendError(res, 'INVALID_REFRESH_TOKEN', '缺少 refresh_token Cookie', req.requestId, 401)
        return
      }
      const rtCookieHash = await hmacToken(refreshTokenCookieHeader)
      const [rtRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
        `SELECT sessionId FROM refresh_token_events WHERE tokenHash = ? AND status IN ('active', 'rotated')`,
        [rtCookieHash],
      )
      if (rtRows.length === 0 || rtRows[0]?.sessionId !== existingSessionId) {
        await conn.rollback()
        sendError(res, 'INVALID_REFRESH_TOKEN', 'refresh_token 与 loginCode 不匹配', req.requestId, 401)
        return
      }

      const [delRaw] = await conn.execute(`DELETE FROM auth_tokens WHERE id = ? AND tokenHash = ?`, [token.id, loginCodeHash])
      const delHeader = delRaw as { affectedRows: number }

      if (delHeader.affectedRows === 0) {
        await conn.commit()
        sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'loginCode 已被使用', req.requestId, 410)
        return
      }

      userId = token.userId
      await conn.commit()
    } finally {
      conn.release()
    }
  }

  if (!userId) {
    sendError(res, Errors.INTERNAL_ERROR.code, 'loginCode 兑换失败', req.requestId, 500)
    return
  }

  const user = await findUserById(userId)
  if (!user) {
    sendError(res, Errors.INTERNAL_ERROR.code, '用户不存在', req.requestId, 500)
    return
  }

  // OAuth callback already created the session — reuse sessionId (api.md §1.6.2)
  // loginCode metadata stores the sessionId created by the callback
  let refreshTokenCookie: string | undefined
  if (!existingSessionId) {
    // No existing session — create one (e.g. from complete-registration flow)
    const { createSession: cs } = await import('../utils/session')
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const ua = req.headers['user-agent'] || 'unknown'
    const newSession = await cs(user.id, user.roles, `oauth:${exchangeProvider || 'github'}`, ip, ua)
    existingSessionId = newSession.sessionId
    refreshTokenCookie = newSession.refreshToken
  }

  const accessToken = await signJwt({
    sub: user.id,
    sid: existingSessionId!,
    tokenVersion: user.tokenVersion,
    roles: user.roles,
    aud: 'transcircle-web',
    iss: 'https://api.transcircle.org',
  })

  if (refreshTokenCookie) {
    const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
    res.cookie('refresh_token', refreshTokenCookie, {
      httpOnly: true, secure: true,
      sameSite: 'lax', path: '/v1/auth', maxAge: maxAge * 1000,
    })
  }

  sendSuccess(res, {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: 900,
    user: {
      id: user.id, username: user.username,
      displayName: user.displayName, avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
    },
  }, req.requestId)
})

export default router
