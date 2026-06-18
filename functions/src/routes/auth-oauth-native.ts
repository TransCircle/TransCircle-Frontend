import { Router } from 'express'
import { exec, queryOne, getConnection } from '../Database'
import { ulid, genId } from '../utils/ulid'
import { signJwt } from '../utils/jwt'
import { sendSuccess, sendError, Errors, zodErrorsToDetails } from '../utils/response'
import { hmacToken, createSession, generateHighEntropyToken } from '../utils/session'
import { hashPassword } from '../utils/password'
import { encryptOAuthPii, decryptOAuthPii } from '../utils/crypto'
import { rateLimitCheck } from '../middleware/rateLimit'
import { idempotencyKey } from '../middleware/idempotency'
import { writeAuditLog } from '../utils/audit'
import { findUserById } from '../utils/users'
import { completeRegistrationSchema } from '../utils/validation'
import { isPasswordNotLeaked } from '../utils/hibp'
import { sendEmail, buildVerificationEmail } from '../utils/mail'
import { conf } from '../Config'

const router: Router = Router()
const oauthConf = conf.OAUTH as Record<string, string | undefined> | undefined
const API_URL = (conf.APP as Record<string, string | undefined> | undefined)?.API_URL || 'https://api.transcircle.org'

// Per api.md §1.6.7: redirectUri must be validated against allowlist
const REDIRECT_URI_ALLOWLIST = [
  'transcircle://oauth/callback',
]
// Also allow all loopback addresses (127.0.0.1:*) per OAuth native spec
function isValidRedirectUri(uri: string): boolean {
  if (REDIRECT_URI_ALLOWLIST.includes(uri)) return true
  if (/^http:\/\/127\.0\.0\.1(?::\d+)?\/callback$/.test(uri)) return true
  return false
}

// ─── 1.6.7 Native OAuth Start (PKCE) ────────────────────────────────
router.post('/auth/oauth/native/start', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const { provider, codeChallenge, codeChallengeMethod, redirectUri, mode } = req.body as {
    provider?: string
    codeChallenge?: string
    codeChallengeMethod?: string
    redirectUri?: string
    mode?: 'login' | 'bind'
  }

  if (!provider || !codeChallenge || !redirectUri || !mode) {
    sendError(res, Errors.BAD_REQUEST.code, '缺少必要参数', req.requestId, 400)
    return
  }
  if (!['github', 'x'].includes(provider)) {
    sendError(res, Errors.VALIDATION_ERROR.code, 'provider 必须为 github 或 x', req.requestId, 422)
    return
  }
  if (codeChallengeMethod !== 'S256') {
    sendError(res, Errors.VALIDATION_ERROR.code, 'codeChallengeMethod 必须为 S256', req.requestId, 422)
    return
  }
  if (!isValidRedirectUri(redirectUri)) {
    sendError(res, Errors.VALIDATION_ERROR.code, 'redirectUri 不在 allowlist 中', req.requestId, 422)
    return
  }
  if (codeChallenge.length < 43 || codeChallenge.length > 128) {
    sendError(res, Errors.VALIDATION_ERROR.code, 'codeChallenge 长度必须在 43-128 字符之间', req.requestId, 422)
    return
  }

  // Bind mode requires auth + step-up
  let bindUserId: string | undefined
  if (mode === 'bind') {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      sendError(res, Errors.UNAUTHORIZED.code, '绑定模式需要登录', req.requestId, Errors.UNAUTHORIZED.status)
      return
    }
    const { verifyJwt } = await import('../utils/jwt')
    const payload = await verifyJwt(authHeader.slice(7))
    if (!payload) {
      sendError(res, Errors.UNAUTHORIZED.code, '登录已过期', req.requestId, Errors.UNAUTHORIZED.status)
      return
    }
    // Check step-up
    const session = await queryOne(
      `SELECT lastStepUpAt FROM sessions WHERE id = ? AND userId = ?`,
      [payload.sid, payload.sub],
    )
    if (!session?.lastStepUpAt || Date.now() - session.lastStepUpAt > 300_000) {
      sendError(res, 'STEP_UP_REQUIRED', '需要二次认证', req.requestId, 403)
      return
    }
    bindUserId = payload.sub

    // Per api.md §1.6.7: audit oauth bind start
    writeAuditLog(req, {
      actorUserId: payload.sub,
      action: 'oauth.bind.start',
      resourceType: 'oauth_account',
      resourceId: payload.sub,
      after: { provider, mode: 'bind', channel: 'native' },
    }).catch((e: unknown) => console.error('audit error:', e))
  }

  // Get client ID
  let clientId: string
  let callbackUrl: string
  if (provider === 'github') {
    clientId = oauthConf?.GITHUB_CLIENT_ID as string
    callbackUrl = `${API_URL}/v1/auth/oauth/github/callback`
  } else {
    clientId = oauthConf?.X_CLIENT_ID as string
    callbackUrl = `${API_URL}/v1/auth/oauth/x/callback`
  }

  if (!clientId) {
    sendError(res, Errors.OAUTH_PROVIDER_ERROR.code, `${provider} OAuth 未配置`, req.requestId, 502)
    return
  }

  // Generate state and store PKCE params
  const state = genId('ost_')
  const stateHash = await hmacToken(state)
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'

  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, ?, 'oauth_state', ?, ?, ?, ?)`,
    [ulid(), bindUserId || null, stateHash,
     JSON.stringify({
       provider, mode, userId: bindUserId || null, redirectUri,
       codeChallenge, codeChallengeMethod, channel: 'native',
       ipHash: await hmacToken(ip), uaHash: await hmacToken(ua),
     }),
     Date.now() + 600_000, Date.now()],
  )

  let authorizationUrl: string
  if (provider === 'github') {
    const githubScopes = 'read:user+user:email'
    authorizationUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${githubScopes}&state=${state}`
  } else {
    const xScopes = encodeURIComponent('tweet.read users.read')
    authorizationUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${xScopes}&state=${state}`
  }

  sendSuccess(res, { authorizationUrl, stateExpiresIn: 600 }, req.requestId)
})

// ─── 1.6.8 Native OAuth Exchange (PKCE) ─────────────────────────────
router.post('/auth/oauth/native/exchange', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const { provider, code, state, codeVerifier } = req.body as {
    provider?: string
    code?: string
    state?: string
    codeVerifier?: string
  }

  if (!provider || !code || !state || !codeVerifier) {
    sendError(res, Errors.BAD_REQUEST.code, '缺少必要参数', req.requestId, 400)
    return
  }

  // Verify state — differentiate missing vs expired per api.md §1.6.8
  const stateHash = await hmacToken(state)
  const stateRecord = await queryOne(
    `SELECT id, metadata, expiresAt FROM auth_tokens WHERE tokenHash = ? AND type = 'oauth_state' AND usedAt IS NULL`,
    [stateHash],
  )

  if (!stateRecord) {
    sendError(res, 'BAD_STATE', 'state 无效', req.requestId, 400)
    return
  }

  // Expired state returns 410 TOKEN_INVALID_OR_EXPIRED per spec
  if ((stateRecord.expiresAt as number) < Date.now()) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'state 已过期', req.requestId, 410)
    return
  }

  const meta = typeof stateRecord.metadata === 'string' ? JSON.parse(stateRecord.metadata) : stateRecord.metadata

  if (meta.channel !== 'native') {
    sendError(res, 'BAD_STATE', 'state 通道不匹配', req.requestId, 400)
    return
  }

  // Verify PKCE code verifier
  const enc = new TextEncoder()
  const challengeDigest = await crypto.subtle.digest('SHA-256', enc.encode(codeVerifier))
  const computedChallenge = btoa(String.fromCharCode(...new Uint8Array(challengeDigest)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  if (computedChallenge !== meta.codeChallenge) {
    sendError(res, 'PKCE_VERIFICATION_FAILED', 'PKCE 验证失败', req.requestId, 422)
    return
  }

  // Mark state as used
  await exec(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [Date.now(), stateRecord.id])

  // Exchange code with provider (reuse existing callback logic)
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'
  const now = Date.now()

  let providerUserId: string
  let providerData: { username: string; displayName: string; avatarUrl: string | null; email: string | null; emailVerified: boolean }

  try {
    if (provider === 'github') {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: oauthConf?.GITHUB_CLIENT_ID,
          client_secret: oauthConf?.GITHUB_CLIENT_SECRET,
          code,
        }),
      })
      const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
      if (!tokenData.access_token) {
        sendError(res, 'OAUTH_ERROR', 'OAuth 授权失败', req.requestId, 400)
        return
      }

      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'TransCircle' },
      })
      const ghUser = await userRes.json() as { id: number; login: string; name: string | null; avatar_url: string | null; email: string | null }
      providerUserId = String(ghUser.id)
      providerData = {
        username: ghUser.login,
        displayName: ghUser.name || ghUser.login,
        avatarUrl: ghUser.avatar_url,
        email: ghUser.email || null,
        emailVerified: !!ghUser.email,
      }
    } else {
      const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${oauthConf?.X_CLIENT_ID}:${oauthConf?.X_CLIENT_SECRET}`)}`,
        },
        body: new URLSearchParams({
          code, grant_type: 'authorization_code',
          redirect_uri: `${API_URL}/v1/auth/oauth/x/callback`,
          code_verifier: codeVerifier,
        }),
      })
      const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
      if (!tokenData.access_token) {
        sendError(res, 'OAUTH_ERROR', 'OAuth 授权失败', req.requestId, 400)
        return
      }

      const userRes = await fetch('https://api.twitter.com/2/users/me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      })
      const xData = await userRes.json() as { data?: { id: string; username: string; name: string } }
      if (!xData.data) {
        sendError(res, 'OAUTH_ERROR', '获取用户信息失败', req.requestId, 400)
        return
      }
      providerUserId = xData.data.id
      providerData = {
        username: xData.data.username,
        displayName: xData.data.name || xData.data.username,
        avatarUrl: null,
        email: null,
        emailVerified: false,
      }
    }
  } catch {
    sendError(res, Errors.OAUTH_PROVIDER_ERROR.code, 'OAuth 提供商返回错误', req.requestId, 502)
    return
  }

  // Look up existing OAuth binding
  const existing = await queryOne(
    `SELECT oa.userId, u.status FROM oauth_accounts oa JOIN users u ON u.id = oa.userId
     WHERE oa.provider = ? AND oa.providerUserId = ?`,
    [provider, providerUserId],
  )

  if (existing) {
    // Already bound to local account
    if (meta.mode === 'bind' && meta.userId) {
      if (existing.userId === meta.userId) {
        sendSuccess(res, { status: 'bind_already_self', provider }, req.requestId)
        return
      } else {
        // Merge conflict
        const mergeToken = generateHighEntropyToken()
        const mergeHash = await hmacToken(mergeToken)
        await exec(
          `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
           VALUES (?, ?, 'merge', ?, ?, ?, ?)`,
          [ulid(), existing.userId, mergeHash,
           JSON.stringify({ primaryUserId: meta.userId, conflictUserId: existing.userId, provider }),
           now + 600_000, now],
        )
        sendSuccess(res, {
          status: 'bind_conflict_merge',
          mergeToken,
          conflictUserId: existing.userId,
          expiresIn: 600,
        }, req.requestId)
        return
      }
    }

    // Login mode
    switch (existing.status) {
      case 'active':
      case 'pending_verification': {
        const user = await findUserById(existing.userId)
        if (!user) {
          sendError(res, Errors.INTERNAL_ERROR.code, '用户查询失败', req.requestId, 500)
          return
        }
        // Audit login success per api.md §1.6.8
        writeAuditLog(req, {
          actorUserId: existing.userId,
          action: 'auth.login.success',
          resourceType: 'user',
          resourceId: existing.userId,
          after: { method: `oauth:${provider}` },
        }).catch((e: unknown) => console.error('audit error:', e))

        const { sessionId, refreshToken } = await createSession(
          existing.userId, user.roles, `oauth:${provider}`, ip, ua,
        )
        const accessToken = await signJwt({
          sub: existing.userId, sid: sessionId, tokenVersion: user.tokenVersion,
          roles: user.roles, aud: 'transcircle-web', iss: 'https://api.transcircle.org',
        })
        sendSuccess(res, {
          status: 'login_ok',
          accessToken, tokenType: 'Bearer', expiresIn: 900,
          refreshToken,
          user: {
            id: user.id, username: user.username,
            displayName: user.displayName, avatarUrl: user.avatarUrl,
            emailVerified: user.emailVerified,
          },
        }, req.requestId)
        return
      }
      case 'banned':
        writeAuditLog(req, { actorUserId: existing.userId, action: 'auth.login.fail', resourceType: 'user', resourceId: existing.userId, after: { reason: 'banned' } }).catch((e: unknown) => console.error('audit error:', e))
        sendSuccess(res, { status: 'login_blocked', code: 'ACCOUNT_BANNED' }, req.requestId)
        return
      case 'merged':
        writeAuditLog(req, { actorUserId: existing.userId, action: 'auth.login.fail', resourceType: 'user', resourceId: existing.userId, after: { reason: 'merged' } }).catch((e: unknown) => console.error('audit error:', e))
        sendSuccess(res, { status: 'login_blocked', code: 'ACCOUNT_MERGED' }, req.requestId)
        return
      case 'pending_deletion':
        writeAuditLog(req, { actorUserId: existing.userId, action: 'auth.login.fail', resourceType: 'user', resourceId: existing.userId, after: { reason: 'pending_deletion' } }).catch((e: unknown) => console.error('audit error:', e))
        sendSuccess(res, { status: 'login_blocked', code: 'ACCOUNT_PENDING_DELETION' }, req.requestId)
        return
      case 'deleted':
        writeAuditLog(req, { actorUserId: existing.userId, action: 'auth.login.fail', resourceType: 'user', resourceId: existing.userId, after: { reason: 'deleted' } }).catch((e: unknown) => console.error('audit error:', e))
        sendSuccess(res, { status: 'login_blocked', code: 'ACCOUNT_DELETED' }, req.requestId)
        return
      default:
        sendSuccess(res, { status: 'oauth_error' }, req.requestId)
        return
    }
  }

  // OAuth not bound — generate pendingHandle
  const pendingHandle = genId('opt_')
  const pendingHash = await hmacToken(pendingHandle)
  const csrfToken = genId('ocs_')

  const pendingMode = meta.mode === 'bind' ? 'binding' : 'registration'
  const pendingUserId = meta.mode === 'bind' ? (meta.userId || null) : null

  // Encrypt PII per api.md §1.6.2
  const nativePii = await encryptOAuthPii({
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
    [ulid(), pendingUserId, pendingHash,
     JSON.stringify({
       provider, providerUserId, mode: pendingMode, userId: pendingUserId,
       pii: nativePii,
       requestIpHash: await hmacToken(ip),
       userAgentHash: await hmacToken(ua),
       channel: 'native',
     }),
     now + 600_000, now],
  )

  sendSuccess(res, {
    status: pendingMode === 'binding' ? 'pending_binding' : 'pending_registration',
    pendingHandle,
    csrfToken,
    expiresIn: 600,
    provider,
    suggestedEmail: providerData.email || null,
    suggestedDisplayName: providerData.displayName || null,
    providerEmailVerified: providerData.emailVerified,
  }, req.requestId)
})

// ─── 1.6.9 Native OAuth Complete Registration ──────────────────────
router.post('/auth/oauth/native/complete-registration', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, idempotencyKey, async (req, res) => {
  const { pendingHandle, csrfToken: bodyCsrf, provider, username, password, displayName, emailMatchesProvider } = req.body as {
    pendingHandle?: string; csrfToken?: string; provider?: string
    username?: string; email?: string; password?: string
    displayName?: string; emailMatchesProvider?: boolean
  }
  // Normalize email: lowercase per api.md §1.1
  const email = (req.body as Record<string, unknown>)?.email as string | undefined

  if (!pendingHandle || !bodyCsrf || !provider || !username || !email || !password || !displayName) {
    sendError(res, Errors.BAD_REQUEST.code, '缺少必要参数', req.requestId, 400)
    return
  }

  const normalizedEmail = email.toLowerCase()

  // Validate fields
  const parsed = completeRegistrationSchema.safeParse({ username, email: normalizedEmail, password, displayName, emailMatchesProvider })
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '字段校验失败', req.requestId, 422, zodErrorsToDetails(parsed.error.flatten()))
    return
  }

  // api.md §1.1: HIBP k-Anonymity leak check
  if (!await isPasswordNotLeaked(password)) {
    sendError(res, Errors.VALIDATION_ERROR.code, '该密码已在公开泄露中出现，请更换密码', req.requestId, 422)
    return
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'
  const now = Date.now()

  // Look up pending handle
  const handleHash = await hmacToken(pendingHandle)
  const record = await queryOne(
    `SELECT id, userId, metadata FROM auth_tokens WHERE tokenHash = ? AND type = 'oauth_pending_registration' AND usedAt IS NULL AND expiresAt > ?`,
    [handleHash, now],
  )

  if (!record) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'pendingHandle 无效或已过期', req.requestId, 410)
    return
  }

  const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata

  // Decrypt PII (api.md §1.6.2)
  if (meta.pii) {
    try {
      const pii = await decryptOAuthPii(meta.pii)
      Object.assign(meta, pii)
    } catch {
      sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '加密数据损坏', req.requestId, 410)
      return
    }
  }

  if (meta.channel !== 'native') {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'pendingHandle 通道不匹配', req.requestId, 410)
    return
  }

  if (meta.csrfToken !== bodyCsrf) {
    sendError(res, 'CSRF_TOKEN_INVALID', 'CSRF 令牌无效', req.requestId, 403)
    return
  }

  if (meta.provider !== provider) {
    sendError(res, Errors.BAD_REQUEST.code, 'provider 不匹配', req.requestId, 400)
    return
  }

  // Transaction
  const { getConnection } = await import('../Database')
  const conn = await getConnection()

  try {
    await conn.beginTransaction()

    // Mark pending token used — check usedAt IS NULL to prevent concurrent consumption (api.md §1.6.9)
    const [lockRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id FROM auth_tokens WHERE id = ? AND usedAt IS NULL FOR UPDATE`, [record.id],
    )
    if ((lockRows as unknown[]).length === 0) {
      await conn.rollback()
      sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'pendingHandle 已被使用', req.requestId, 410)
      return
    }
    await conn.execute(`UPDATE auth_tokens SET usedAt = ? WHERE id = ? AND usedAt IS NULL`, [now, record.id])

    // Check uniqueness
    const [uRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id FROM users WHERE username = ?`, [username],
    )
    if ((uRows as unknown[]).length > 0) {
      await conn.rollback()
      sendError(res, Errors.USERNAME_TAKEN.code, Errors.USERNAME_TAKEN.message, req.requestId, Errors.USERNAME_TAKEN.status)
      return
    }

    const [eRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id FROM users WHERE email = ?`, [normalizedEmail],
    )
    if ((eRows as unknown[]).length > 0) {
      await conn.rollback()
      sendError(res, Errors.EMAIL_TAKEN.code, '该邮箱已被注册', req.requestId, 409, undefined, { nextAction: 'password_forgot' })
      return
    }

    const pwdHash = await hashPassword(password)
    const userId = genId('usr_')
    const emailVerified = !!(emailMatchesProvider && meta.providerEmailVerified)

    const emailVerifiedSource = emailVerified ? `oauth:${meta.provider}` : null
    await conn.execute(
      `INSERT INTO users (id, username, email, emailVerified, emailVerifiedSource, displayName, avatarUrl, passwordHash, passwordUpdatedAt, passwordHistory, status, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, username, normalizedEmail, emailVerified, emailVerifiedSource, displayName, meta.providerAvatarUrl || null, pwdHash, now, JSON.stringify([pwdHash]),
       emailVerified ? 'active' : 'pending_verification', now, now],
    )

    await conn.execute(
      `INSERT INTO oauth_accounts (id, userId, provider, providerUserId, providerUsername, providerDisplayName, providerAvatarUrl, providerEmail, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [genId('oauth_'), userId, meta.provider, meta.providerUserId, meta.providerUsername || null, meta.providerDisplayName || null, meta.providerAvatarUrl || null, meta.providerEmail || null, now, now],
    )

    const user = await findUserById(userId)
    if (!user) {
      await conn.rollback()
      sendError(res, Errors.INTERNAL_ERROR.code, '用户创建失败', req.requestId, 500)
      return
    }

    const { sessionId, refreshToken } = await createSession(user.id, user.roles, `oauth:${provider}`, ip, ua)

    const accessToken = await signJwt({
      sub: user.id, sid: sessionId, tokenVersion: user.tokenVersion,
      roles: user.roles, aud: 'transcircle-web', iss: 'https://api.transcircle.org',
    })

    await writeAuditLog(req, {
      actorUserId: userId, action: 'auth.register', resourceType: 'user', resourceId: userId,
      after: { username, email: normalizedEmail, provider },
    })
    await writeAuditLog(req, {
      actorUserId: userId, action: 'oauth.bind', resourceType: 'oauth_account', resourceId: userId,
      after: { provider, bound: true },
    })

    await conn.commit()

    // Send verification email if needed per api.md §1.6.9
    let verificationEmailSent = false
    if (!emailVerified && normalizedEmail) {
      const rawVerifyToken = genId('ev_')
      const verifyHash = await hmacToken(rawVerifyToken)
      await exec(
        `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
         VALUES (?, ?, 'email_verify', ?, '{}', ?, ?)`,
        [ulid(), userId, verifyHash, Date.now() + 86400_000, Date.now()],
      ).catch((e: unknown) =>
        console.error('verify token insert error:', (e as Error).message || e),
      )
      verificationEmailSent = await sendEmail(buildVerificationEmail(normalizedEmail, rawVerifyToken))
    }

    sendSuccess(res, {
      user: {
        id: user.id, username, email: normalizedEmail,
        displayName: user.displayName, avatarUrl: user.avatarUrl,
        emailVerified, status: emailVerified ? 'active' : 'pending_verification',
        createdAt: user.createdAt,
      },
      boundProvider: provider,
      accessToken, tokenType: 'Bearer', expiresIn: 900,
      refreshToken,
      verificationEmailSent,
    }, req.requestId, 201)
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('native complete-registration error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '注册失败', req.requestId, 500)
  } finally {
    conn.release()
  }
})

// ─── 1.6.10 Native OAuth Complete Binding ───────────────────────────
router.post('/auth/oauth/native/complete-binding', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
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

  // Check user active
  const user = await findUserById(payload.sub)
  if (!user || user.status !== 'active') {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }

  // Step-up
  const session = await queryOne(
    `SELECT lastStepUpAt FROM sessions WHERE id = ? AND userId = ?`,
    [payload.sid, payload.sub],
  )
  if (!session?.lastStepUpAt || Date.now() - session.lastStepUpAt > 300_000) {
    sendError(res, 'STEP_UP_REQUIRED', '需要二次认证', req.requestId, 403)
    return
  }

  const { pendingHandle, csrfToken: bodyCsrf, provider } = req.body as {
    pendingHandle?: string; csrfToken?: string; provider?: string
  }

  if (!pendingHandle || !bodyCsrf || !provider) {
    sendError(res, Errors.BAD_REQUEST.code, '缺少必要参数', req.requestId, 400)
    return
  }

  const handleHash = await hmacToken(pendingHandle)
  const record = await queryOne(
    `SELECT id, metadata FROM auth_tokens
     WHERE tokenHash = ? AND type = 'oauth_pending_registration' AND usedAt IS NULL AND expiresAt > ?`,
    [handleHash, Date.now()],
  )

  if (!record) {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'pendingHandle 无效或已过期', req.requestId, 410)
    return
  }

  const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata

  // Decrypt PII (api.md §1.6.2)
  if (meta.pii) {
    try {
      const pii = await decryptOAuthPii(meta.pii)
      Object.assign(meta, pii)
    } catch {
      sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '加密数据损坏', req.requestId, 410)
      return
    }
  }

  if (meta.channel !== 'native') {
    sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '通道不匹配', req.requestId, 410)
    return
  }

  if (meta.csrfToken !== bodyCsrf) {
    sendError(res, 'CSRF_TOKEN_INVALID', 'CSRF 令牌无效', req.requestId, 403)
    return
  }

  if (meta.provider !== provider) {
    sendError(res, Errors.BAD_REQUEST.code, 'provider 不匹配', req.requestId, 400)
    return
  }

  // Check provider not already bound
  const existingBind = await queryOne(
    `SELECT id FROM oauth_accounts WHERE userId = ? AND provider = ?`,
    [payload.sub, provider],
  )
  if (existingBind) {
    sendError(res, Errors.PROVIDER_ALREADY_BOUND.code, Errors.PROVIDER_ALREADY_BOUND.message, req.requestId, Errors.PROVIDER_ALREADY_BOUND.status)
    return
  }

  // ── 事务: 原子标记 used + 写入 oauth_accounts ──
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    // FOR UPDATE 锁定 pending token 防止并发消费 (api.md §1.6.10)
    const [lockRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id FROM auth_tokens
       WHERE id = ? AND usedAt IS NULL
       FOR UPDATE`,
      [record.id],
    )
    if ((lockRows as unknown[]).length === 0) {
      await conn.rollback()
      sendError(res, 'TOKEN_INVALID_OR_EXPIRED', 'pendingHandle 已被使用', req.requestId, 410)
      return
    }

    // 消费 pending token
    await conn.execute(`UPDATE auth_tokens SET usedAt = ? WHERE id = ? AND usedAt IS NULL`, [Date.now(), record.id])

    // FOR UPDATE 检查 OAuth 身份是否已被其他账号绑定
    const [lockOa] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id FROM oauth_accounts WHERE provider = ? AND providerUserId = ? FOR UPDATE`,
      [meta.provider, meta.providerUserId],
    )
    if ((lockOa as unknown[]).length > 0) {
      await conn.rollback()
      sendError(res, Errors.OAUTH_ALREADY_LINKED.code, '该 OAuth 身份已被绑定', req.requestId, 409)
      return
    }

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

    // 事务内写审计日志
    await writeAuditLog(req, {
      actorUserId: payload.sub, action: 'oauth.bind', resourceType: 'oauth_account',
      resourceId: payload.sub,
      after: { provider, channel: 'native' },
    })

    await conn.commit()

    sendSuccess(res, {
      userId: payload.sub,
      boundProvider: meta.provider,
      providerUsername: meta.providerUsername || null,
      boundAt: Date.now(),
    }, req.requestId)
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('native complete-binding error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '绑定失败', req.requestId, 500)
  } finally {
    conn.release()
  }
})

export default router
