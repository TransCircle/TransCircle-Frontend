import { Router, type Router as RouterType } from 'express'
import { conf } from '../Config'
import { exec, queryOne } from '../Database'
import { ulid } from '../utils/ulid'
import { signJwt } from '../utils/jwt'
import { hashPassword } from '../utils/password'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { createSession, rotateRefreshToken, revokeSession, hmacToken } from '../utils/session'
import { findUserById } from '../utils/users'
import { loginCodeSchema, completeRegistrationSchema } from '../utils/validation'
import { rateLimitCheck } from '../middleware/rateLimit'

const router: RouterType = Router()

const oauthConf = conf.OAUTH as Record<string, string | undefined> | undefined
const GITHUB_CLIENT_ID = oauthConf?.GITHUB_CLIENT_ID as string | undefined
const GITHUB_CLIENT_SECRET = oauthConf?.GITHUB_CLIENT_SECRET as string | undefined
const X_CLIENT_ID = oauthConf?.X_CLIENT_ID as string | undefined
const X_CLIENT_SECRET = oauthConf?.X_CLIENT_SECRET as string | undefined

const SESSION_CONF = conf.SESSION as Record<string, string | number | undefined> | undefined
const APP_URL = 'https://submit.transcircle.org'

// ──────────────────────────────────────────────
// POST /auth/refresh
// Refresh access token using HttpOnly refresh cookie — api.md §1.11.2
// Proper rotation with reuse detection in rotateRefreshToken()
// ──────────────────────────────────────────────
router.post('/refresh', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const rawToken = req.cookies?.refresh_token
  if (!rawToken) {
    sendError(res, 'INVALID_REFRESH_TOKEN', '刷新令牌无效', req.requestId, 401)
    return
  }

  const result = await rotateRefreshToken(rawToken)
  if (!result) {
    sendError(res, 'REFRESH_TOKEN_REVOKED', '刷新令牌已被吊销', req.requestId, 401)
    return
  }

  // Sign new access token using the existing session (no new session created)
  const accessToken = await signJwt({
    sub: result.userId,
    sid: result.id,
    tokenVersion: result.tokenVersion,
    roles: result.roles,
    aud: 'transcircle-web',
    iss: 'https://api.transcircle.org',
  })

  // Set new refresh token cookie
  const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
  res.cookie('refresh_token', result.newRefreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth',
    maxAge: maxAge * 1000,
  })

  sendSuccess(res, { accessToken, tokenType: 'Bearer', expiresIn: 900 }, req.requestId)
})

// ──────────────────────────────────────────────
// POST /auth/logout — api.md §1.11.3
// Revokes current session only, does NOT bump tokenVersion
// Returns 204 No Content
// ──────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const rawToken = req.cookies?.refresh_token

  if (rawToken) {
    const tokenHash = await hmacToken(rawToken)
    const event = await queryOne(
      `SELECT sessionId FROM refresh_token_events WHERE tokenHash = ? AND status = 'active'`,
      [tokenHash],
    )
    if (event) {
      await revokeSession(event.sessionId, 'logout')
      await exec(`UPDATE refresh_token_events SET status = 'revoked' WHERE tokenHash = ?`, [tokenHash])
    }
  }

  res.clearCookie('refresh_token', { path: '/v1/auth' })
  res.status(204).end()
})

// ──────────────────────────────────────────────
// GET /auth/oauth/github/start — api.md §1.6.1
// ──────────────────────────────────────────────
router.get('/oauth/github/start', async (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    sendError(res, Errors.OAUTH_PROVIDER_ERROR.code, 'GitHub OAuth 未配置', req.requestId, 503)
    return
  }

  const state = ulid()
  const callbackUrl = `${APP_URL}/v1/auth/oauth/github/callback`

  const stateHash = await hmacToken(state)
  const stateIp = req.ip || req.socket.remoteAddress || 'unknown'
  const stateUa = req.headers['user-agent'] || 'unknown'
  const stateMeta = JSON.stringify({
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
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600_000,
  })

  const redirectAfter = (req.query.redirectAfter as string) || '/dashboard'
  const authorizationUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=read:user+user:email&state=${state}`

  sendSuccess(res, { authorizationUrl, stateExpiresIn: 600, redirectAfter }, req.requestId)
})

// ──────────────────────────────────────────────
// POST /auth/oauth/complete-binding — api.md §1.6.5
// Bind pending OAuth identity to current logged-in user
// ──────────────────────────────────────────────
router.post('/oauth/complete-binding', async (req, res) => {
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
    sendError(res, Errors.UNAUTHORIZED.code, `缺少 ${pendingCookieName} Cookie`, req.requestId, 401)
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

  // 检查当前用户在该 provider 下是否已有绑定
  const existingBind = await queryOne(
    `SELECT id FROM oauth_accounts WHERE userId = ? AND provider = ?`,
    [payload.sub, meta.provider],
  )
  if (existingBind) {
    sendError(res, Errors.PROVIDER_ALREADY_BOUND.code, Errors.PROVIDER_ALREADY_BOUND.message, req.requestId, Errors.PROVIDER_ALREADY_BOUND.status)
    return
  }

  // 消费 pending token
  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), pendingRecord.id])

  // 写入 oauth_accounts
  await exec(
    `INSERT INTO oauth_accounts (id, userId, provider, providerUserId, providerUsername, providerDisplayName, providerAvatarUrl, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ulid(), payload.sub, meta.provider, meta.providerUserId, meta.providerUsername || null, meta.providerDisplayName || null, meta.providerAvatarUrl || null, Date.now(), Date.now()],
  )

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
router.get('/oauth/pending-profile', async (req, res) => {
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

  sendSuccess(res, {
    provider: meta.provider,
    mode: meta.mode || 'registration',
    suggestedEmail: meta.providerEmail || null,
    suggestedDisplayName: meta.providerDisplayName || null,
    providerEmailVerified: !!meta.providerEmailVerified,
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
): Promise<void> {
  const state = req.query.state as string | undefined
  const cookieState = req.cookies?.oauth_state

  if (cookieState !== state) {
    res.clearCookie('oauth_state', { path: '/' })
    res.redirect(`${APP_URL}/auth/callback?status=bad_state`)
    return
  }

  // Verify state record
  if (!state) {
    res.clearCookie('oauth_state', { path: '/' })
    res.redirect(`${APP_URL}/auth/callback?status=bad_state`)
    return
  }

  const stateHash = await hmacToken(state)
  const stateRecord = await queryOne(
    `SELECT id, metadata FROM auth_tokens WHERE tokenHash = ? AND type = 'oauth_state' AND expiresAt > ?`,
    [stateHash, Date.now()],
  )
  if (!stateRecord) {
    res.clearCookie('oauth_state', { path: '/' })
    res.redirect(`${APP_URL}/auth/callback?status=bad_state`)
    return
  }

  const stateMeta = typeof stateRecord.metadata === 'string' ? JSON.parse(stateRecord.metadata) : stateRecord.metadata
  const cbIp = req.ip || req.socket.remoteAddress || 'unknown'
  const cbUa = req.headers['user-agent'] || 'unknown'
  if (
    (stateMeta.ipHash && stateMeta.ipHash !== (await hmacToken(cbIp))) ||
    (stateMeta.uaHash && stateMeta.uaHash !== (await hmacToken(cbUa)))
  ) {
    await exec(`DELETE FROM auth_tokens WHERE id = ?`, [stateRecord.id])
    res.clearCookie('oauth_state', { path: '/' })
    res.redirect(`${APP_URL}/auth/callback?status=bad_state`)
    return
  }

  // Consume state
  await exec(`DELETE FROM auth_tokens WHERE id = ?`, [stateRecord.id])
  res.clearCookie('oauth_state', { path: '/' })

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
        res.redirect(`${APP_URL}/auth/callback?status=bind_already_self&provider=${provider}`)
        return
      } else {
        // 已绑定到其他用户 → 合并流程
        const mergeToken = ulid()
        const mergeHash = await hmacToken(mergeToken)
        await exec(
          `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
           VALUES (?, ?, 'account_merge', ?, ?, ?, ?)`,
          [ulid(), existing.userId, mergeHash,
           JSON.stringify({ primaryUserId: stateMeta.userId, conflictUserId: existing.userId, provider }),
           now + 600_000, now],
        )
        res.redirect(`${APP_URL}/auth/oauth/merge?status=bind_conflict_merge&mergeToken=${mergeToken}&conflictUserId=${existing.userId}`)
        return
      }
    }

    // mode === 'login'
    switch (existing.status) {
      case 'active':
      case 'pending_verification': {
        const ip = req.ip || req.socket.remoteAddress || 'unknown'
        const ua = req.headers['user-agent'] || 'unknown'
        const { sessionId, refreshToken } = await createSession(
          existing.userId,
          [], // roles 将在 exchange 时通过 signJwt 确定
          `oauth:${provider}`,
          ip, ua,
        )

        // Create login code
        const loginCode = ulid()
        const loginCodeHash = await hmacToken(loginCode)
        await exec(
          `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
           VALUES (?, ?, 'oauth_login_code', ?, JSON_OBJECT('sessionId', ?), ?, ?)`,
          [ulid(), existing.userId, loginCodeHash, sessionId, now + 60_000, now],
        )

        const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
        res.cookie('refresh_token', refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/v1/auth',
          maxAge: maxAge * 1000,
        })

        res.redirect(`${APP_URL}/auth/callback?status=login_ok&loginCode=${loginCode}&redirectAfter=${encodeURIComponent(redirectAfter)}`)
        return
      }
      case 'banned':
        res.redirect(`${APP_URL}/auth/callback?status=login_blocked&code=ACCOUNT_BANNED`)
        return
      case 'merged':
        res.redirect(`${APP_URL}/auth/callback?status=login_blocked&code=ACCOUNT_MERGED`)
        return
      case 'pending_deletion':
        res.redirect(`${APP_URL}/auth/callback?status=login_blocked&code=ACCOUNT_PENDING_DELETION`)
        return
      case 'deleted':
        res.redirect(`${APP_URL}/auth/callback?status=login_blocked&code=ACCOUNT_DELETED`)
        return
      default:
        res.redirect(`${APP_URL}/auth/callback?status=oauth_error`)
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
      res.redirect(`${APP_URL}/auth/callback?status=bind_provider_taken&provider=${provider}`)
      return
    }

    // 生成 pending 注册 token（binding 模式）
    const pendingToken = ulid()
    const pendingHash = await hmacToken(pendingToken)
    const csrfToken = ulid()
    const csrfHash = await hmacToken(csrfToken)

    await exec(
      `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
       VALUES (?, ?, 'oauth_pending_registration', ?, ?, ?, ?)`,
      [ulid(), stateMeta.userId, pendingHash,
       JSON.stringify({
         provider, providerUserId, mode: 'binding', userId: stateMeta.userId,
         providerUsername: providerData.username,
         providerDisplayName: providerData.displayName,
         providerAvatarUrl: providerData.avatarUrl,
         providerEmail: providerData.email,
         providerEmailVerified: providerData.emailVerified,
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

    // 设置 CSRF Cookie（非 HttpOnly，前端可读）
    res.cookie('oauth_pending_csrf', csrfToken, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 600_000,
    })

    res.redirect(`${APP_URL}/settings/security/oauth-bind/confirm?status=pending_binding&provider=${provider}`)
    return
  }

  // mode === 'login' — 生成 pending 注册 token
  const pendingToken = ulid()
  const pendingHash = await hmacToken(pendingToken)
  const csrfToken = ulid()
  const csrfHash = await hmacToken(csrfToken)

  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, NULL, 'oauth_pending_registration', ?, ?, ?, ?)`,
    [ulid(), pendingHash,
     JSON.stringify({
       provider, providerUserId, mode: 'registration',
       providerUsername: providerData.username,
       providerDisplayName: providerData.displayName,
       providerAvatarUrl: providerData.avatarUrl,
       providerEmail: providerData.email,
       providerEmailVerified: providerData.emailVerified,
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
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth/oauth',
    maxAge: 600_000,
  })

  // Set CSRF cookie
  res.cookie('oauth_pending_csrf', csrfToken, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600_000,
  })

  res.redirect(`${APP_URL}/auth/callback?status=pending_registration&provider=${provider}`)
}

// ──────────────────────────────────────────────
// GET /auth/oauth/github/callback — api.md §1.6.2
// ──────────────────────────────────────────────
router.get('/oauth/github/callback', async (req, res) => {
  const code = req.query.code as string | undefined
  if (!code) {
    res.redirect(`${APP_URL}/auth/callback?status=oauth_error`)
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
      res.redirect(`${APP_URL}/auth/callback?status=oauth_error`)
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

    await handleOAuthCallback('github', String(githubUser.id), {
      username: githubUser.login,
      displayName: githubUser.name || githubUser.login,
      avatarUrl: githubUser.avatar_url,
      email: email || null,
      emailVerified: !!email,
    }, req, res)
  } catch (err) {
    console.error('GitHub OAuth error:', err)
    res.redirect(`${APP_URL}/auth/callback?status=oauth_error`)
  }
})

// ──────────────────────────────────────────────
// GET /auth/oauth/x/start — api.md §1.6.1
// ──────────────────────────────────────────────
router.get('/oauth/x/start', async (req, res) => {
  if (!X_CLIENT_ID) {
    sendError(res, Errors.OAUTH_PROVIDER_ERROR.code, 'X OAuth 未配置', req.requestId, 503)
    return
  }

  const state = ulid()
  const codeVerifier = ulid() + ulid()
  const callbackUrl = `${APP_URL}/v1/auth/oauth/x/callback`

  const stateHash = await hmacToken(state)
  const xStateIp = req.ip || req.socket.remoteAddress || 'unknown'
  const xStateUa = req.headers['user-agent'] || 'unknown'
  const xStateMeta = JSON.stringify({
    codeVerifier,
    ipHash: await hmacToken(xStateIp),
    uaHash: await hmacToken(xStateUa),
  })
  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, NULL, 'oauth_state', ?, ?, ?, ?)`,
    [ulid(), stateHash, xStateMeta, Date.now() + 600_000, Date.now()],
  )

  res.cookie('oauth_state', state, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', path: '/', maxAge: 600_000,
  })

  const scopes = encodeURIComponent('tweet.read users.read')
  const redirectAfter = (req.query.redirectAfter as string) || '/dashboard'
  const authorizationUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${X_CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${scopes}&state=${state}&code_challenge=${codeVerifier}&code_challenge_method=plain`

  sendSuccess(res, { authorizationUrl, stateExpiresIn: 600, redirectAfter }, req.requestId)
})

// ──────────────────────────────────────────────
// GET /auth/oauth/x/callback — api.md §1.6.2
// ──────────────────────────────────────────────
router.get('/oauth/x/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string }
  if (!code) {
    res.redirect(`${APP_URL}/auth/callback?status=oauth_error`)
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
      res.clearCookie('oauth_state', { path: '/' })
      res.redirect(`${APP_URL}/auth/callback?status=bad_state`)
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
      body: new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: `${APP_URL}/v1/auth/oauth/x/callback`, code_verifier: codeVerifier }),
    })
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
    if (!tokenData.access_token) {
      res.redirect(`${APP_URL}/auth/callback?status=oauth_error`)
      return
    }

    const userRes = await fetch('https://api.twitter.com/2/users/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const userData = await userRes.json() as { data?: { id: string; username: string; name: string } }
    if (!userData.data) {
      res.redirect(`${APP_URL}/auth/callback?status=oauth_error`)
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
  } catch (err) {
    console.error('X OAuth error:', err)
    res.redirect(`${APP_URL}/auth/callback?status=oauth_error`)
  }
})

// ──────────────────────────────────────────────
// POST /auth/oauth/complete-registration — api.md §1.6.4
// Complete OAuth registration with username/password etc.
// ──────────────────────────────────────────────
router.post('/oauth/complete-registration', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const provider = req.query.provider as string || 'github'

  // Dual-cookie CSRF validation
  const csrfToken = req.headers['x-csrf-token'] as string | undefined
  if (!csrfToken) {
    sendError(res, Errors.CSRF_TOKEN_INVALID.code, '缺少 X-CSRF-Token', req.requestId, Errors.CSRF_TOKEN_INVALID.status)
    return
  }

  const pendingCookieName = `oauth_pending_${provider}`
  const pendingToken = req.cookies?.[pendingCookieName] as string | undefined
  if (!pendingToken) {
    sendError(res, Errors.UNAUTHORIZED.code, `缺少 ${pendingCookieName} Cookie`, req.requestId, 401)
    return
  }

  const parsed = completeRegistrationSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 422, parsed.error.flatten())
    return
  }

  const { username, email, password, displayName, emailMatchesProvider } = parsed.data
  const now = Date.now()
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'

  // Transaction with row-level lock
  const { getConnection } = await import('../Database')
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    // Look up oauth_pending_registration
    const csrfHash = await hmacToken(csrfToken)
    const [lockRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id, userId, metadata FROM auth_tokens
       WHERE tokenHash = ? AND type = 'oauth_pending_registration'
       FOR UPDATE`,
      [csrfHash],
    )

    if ((lockRows as unknown[]).length === 0) {
      await conn.rollback()
      sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'CSRF Token 无效或已过期', req.requestId, 410)
      return
    }

    const pendingRecord = lockRows[0] as { id: string; userId: string; metadata: string }
    const meta = typeof pendingRecord.metadata === 'string' ? JSON.parse(pendingRecord.metadata) : pendingRecord.metadata

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
      await conn.execute(
        `UPDATE users SET username = ?, email = ?, displayName = COALESCE(NULLIF(?, ''), displayName),
         passwordHash = ?, passwordUpdatedAt = ?, status = 'active', updatedAt = ? WHERE id = ?`,
        [username, email, displayName || username, passwordHash, now, now, pendingRecord.userId],
      )

      // Insert OAuth binding if not yet bound
      await conn.execute(
        `INSERT IGNORE INTO oauth_accounts (id, userId, provider, providerUserId, providerUsername, providerDisplayName, providerAvatarUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ulid(), pendingRecord.userId, meta.provider, meta.providerUserId, meta.providerUsername || null, meta.providerDisplayName || null, meta.providerAvatarUrl || null, now, now],
      )

      const user = await findUserById(pendingRecord.userId)
      if (!user) {
        await conn.rollback()
        sendError(res, Errors.INTERNAL_ERROR.code, '用户查询失败', req.requestId, 500)
        return
      }

      // Create session
      const { sessionId, refreshToken } = await createSession(user.id, user.roles, `oauth:${provider}`, ip, ua)

      // Generate login code
      const loginCode = ulid()
      const loginCodeHash = await hmacToken(loginCode)
      await conn.execute(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'oauth_login_code', ?, JSON_OBJECT('sessionId', ?), ?, ?)`,
        [ulid(), user.id, loginCodeHash, sessionId, now + 60_000, now],
      )

      // Audit logs
      await conn.execute(
        `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, after, createdAt, requestId)
         VALUES (?, ?, 'auth.register', 'user', ?, ?, ?, ?)`,
        [ulid(), pendingRecord.userId, pendingRecord.userId, JSON.stringify({ username, email, provider }), now, req.requestId],
      )

      await conn.commit()

      const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
      res.cookie('refresh_token', refreshToken, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax', path: '/v1/auth', maxAge: maxAge * 1000,
      })

      res.clearCookie(`oauth_pending_${provider}`, { path: '/v1/auth/oauth' })
      res.clearCookie('oauth_pending_csrf', { path: '/' })

      sendSuccess(res, {
        user: {
          id: user.id, username, email,
          displayName: user.displayName, avatarUrl: user.avatarUrl,
          emailVerified: !!emailMatchesProvider,
          status: 'active',
          createdAt: user.createdAt,
        },
        boundProvider: provider as 'github' | 'x',
        loginCode,
        verificationEmailSent: false,
      }, req.requestId, 201)
      return
    } else {
      // Create new user
      const userId = ulid()
      const emailVerified = !!(emailMatchesProvider && meta.providerEmailVerified)
      await conn.execute(
        `INSERT INTO users (id, username, email, emailVerified, displayName, avatarUrl, passwordHash, passwordUpdatedAt, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, username, email, emailVerified, displayName || username,
         meta.providerAvatarUrl || null, passwordHash, now,
         emailVerified ? 'active' : 'pending_verification', now, now],
      )

      // Insert OAuth binding
      await conn.execute(
        `INSERT IGNORE INTO oauth_accounts (id, userId, provider, providerUserId, providerUsername, providerDisplayName, providerAvatarUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ulid(), userId, meta.provider, meta.providerUserId, meta.providerUsername || null, meta.providerDisplayName || null, meta.providerAvatarUrl || null, now, now],
      )

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
      const loginCode = ulid()
      const loginCodeHash = await hmacToken(loginCode)
      await conn.execute(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'oauth_login_code', ?, JSON_OBJECT('sessionId', ?), ?, ?)`,
        [ulid(), user.id, loginCodeHash, sessionId, now + 60_000, now],
      )

      // Audit logs
      await conn.execute(
        `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, after, createdAt, requestId)
         VALUES (?, ?, 'auth.register', 'user', ?, ?, ?, ?)`,
        [ulid(), userId, userId, JSON.stringify({ username, email, provider }), now, req.requestId],
      )
      await conn.execute(
        `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, after, createdAt, requestId)
         VALUES (?, ?, 'oauth.bind', 'user', ?, ?, ?, ?)`,
        [ulid(), userId, userId, JSON.stringify({ provider, bound: true }), now, req.requestId],
      )

      await conn.commit()

      const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
      res.cookie('refresh_token', refreshToken, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production',
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
        verificationEmailSent: false,
      }, req.requestId, 201)
      return
    }

    await conn.commit()
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
  {
    const conn = await getConnection()
    try {
      await conn.beginTransaction()

      const [lockRows] = await conn.execute(
        `SELECT id, userId, expiresAt FROM auth_tokens
         WHERE tokenHash = ? AND type = 'oauth_login_code'
         FOR UPDATE`,
        [loginCodeHash],
      )
      const rows = lockRows as Array<{ id: string; userId: string; expiresAt: number }>
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

  // Create session (if not already created by OAuth callback)
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'
  const { sessionId, refreshToken } = await createSession(user.id, user.roles, 'oauth:exchange', ip, ua)

  const accessToken = await signJwt({
    sub: user.id,
    sid: sessionId,
    tokenVersion: user.tokenVersion,
    roles: user.roles,
    aud: 'transcircle-web',
    iss: 'https://api.transcircle.org',
  })

  const maxAge = (SESSION_CONF?.SESS_MAXAGE as number) || 7 * 24 * 60 * 60
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', path: '/v1/auth', maxAge: maxAge * 1000,
  })

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
