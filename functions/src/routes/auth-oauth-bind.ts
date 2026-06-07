import { Router } from 'express'
import { query, exec, queryOne, getConnection } from '../Database'
import { ulid, genId } from '../utils/ulid'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { requireAuth } from '../middleware/auth'
import { hmacToken } from '../utils/session'
import { writeAuditLog } from '../utils/audit'
import { conf } from '../Config'

const router: Router = Router()
const oauthConf = conf.OAUTH as Record<string, string | undefined> | undefined
const API_URL = (conf.APP as Record<string, string | undefined> | undefined)?.API_URL || 'https://api.transcircle.org'

async function startBindFlow(provider: 'github' | 'x', userId: string, req: import('express').Request, res: import('express').Response): Promise<void> {
  let clientId: string | undefined
  let callbackUrl: string
  if (provider === 'github') {
    clientId = oauthConf?.GITHUB_CLIENT_ID
    callbackUrl = `${API_URL}/v1/auth/oauth/github/callback`
  } else {
    clientId = oauthConf?.X_CLIENT_ID
    callbackUrl = `${API_URL}/v1/auth/oauth/x/callback`
  }

  if (!clientId) {
    sendError(res, Errors.OAUTH_PROVIDER_ERROR.code, `${provider} OAuth 未配置`, req.requestId, 503)
    return
  }

  const state = genId('ost_')
  const stateHash = await hmacToken(state)
  const stateIp = req.ip || req.socket.remoteAddress || 'unknown'
  const stateUa = req.headers['user-agent'] || 'unknown'

  await exec(
    `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
     VALUES (?, ?, 'oauth_state', ?, ?, ?, ?)`,
    [ulid(), userId, stateHash,
     JSON.stringify({ provider, mode: 'bind', userId, ipHash: await hmacToken(stateIp), uaHash: await hmacToken(stateUa) }),
     Date.now() + 600_000, Date.now()],
  )

  let authorizationUrl: string
  if (provider === 'github') {
    const githubScopes = 'read:user+user:email'
    authorizationUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${githubScopes}&state=${state}`
  } else {
    const xScopes = encodeURIComponent('tweet.read users.read')
    const codeVerifier = ulid() + ulid()
    const ce = new TextEncoder()
    const cd = await crypto.subtle.digest('SHA-256', ce.encode(codeVerifier))
    const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(cd)))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    authorizationUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${xScopes}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`
  }

  sendSuccess(res, { authorizationUrl }, req.requestId)
}

// GET /me/oauth — api.md §1.7.3
router.get('/me/oauth', requireAuth, async (req, res) => {
  const accounts = await query(
    `SELECT provider, providerUsername, providerDisplayName, providerAvatarUrl, createdAt as boundAt
     FROM oauth_accounts WHERE userId = ?`,
    [req.user!.userId],
  )

  sendSuccess(res, (accounts as Array<Record<string, unknown>>).map((a) => ({
    provider: a.provider,
    providerUsername: a.providerUsername || null,
    providerDisplayName: a.providerDisplayName || null,
    providerAvatarUrl: a.providerAvatarUrl || null,
    boundAt: a.boundAt,
  })), req.requestId)
})

// DELETE /me/oauth/{provider} — api.md §1.7.2
router.delete('/me/oauth/:provider', requireAuth, async (req, res) => {
  const { provider } = req.params

  if (provider !== 'github' && provider !== 'x') {
    sendError(res, Errors.BAD_REQUEST.code, '无效的 provider', req.requestId, 400)
    return
  }

  // Check step-up (5 min)
  const session = await queryOne(
    `SELECT lastStepUpAt FROM sessions WHERE id = ?`,
    [req.user!.sessionId],
  )
  if (!session?.lastStepUpAt || Date.now() - session.lastStepUpAt > 300_000) {
    sendError(res, 'STEP_UP_REQUIRED', '需要二次认证', req.requestId, 403)
    return
  }

  const oauth = await queryOne(
    `SELECT id FROM oauth_accounts WHERE userId = ? AND provider = ?`,
    [req.user!.userId, provider],
  )
  if (!oauth) {
    sendError(res, 'OAUTH_NOT_BOUND', '该 provider 未绑定', req.requestId, 404)
    return
  }

  // Check there are other login methods (api.md §1.7.2)
  const otherProviders = await queryOne(
    `SELECT COUNT(*) as cnt FROM oauth_accounts WHERE userId = ? AND provider != ?`,
    [req.user!.userId, provider],
  )
  const hasPasswordAndVerified = await queryOne(
    `SELECT passwordHash FROM users WHERE id = ? AND passwordHash IS NOT NULL AND emailVerified = TRUE`,
    [req.user!.userId],
  )
  const hasPasskey = await queryOne(
    `SELECT COUNT(*) as cnt FROM passkeys WHERE userId = ? AND status = 'active'`,
    [req.user!.userId],
  )

  if (!hasPasswordAndVerified && !hasPasskey && (otherProviders?.cnt as number || 0) === 0) {
    sendError(res, 'LAST_LOGIN_METHOD', '解绑后将无登录方式', req.requestId, 409)
    return
  }

  const now = Date.now()
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    await conn.execute(`DELETE FROM oauth_accounts WHERE userId = ? AND provider = ?`, [req.user!.userId, provider])

    // Revoke sessions created through this OAuth provider (per api.md §1.7.2)
    await conn.execute(
      `UPDATE sessions SET revokedAt = ?, revokedReason = 'manual_revoke' WHERE userId = ? AND loginMethod = ? AND revokedAt IS NULL`,
      [now, req.user!.userId, `oauth:${provider}`],
    )
    // Revoke refresh tokens for those OAuth sessions per api.md §1.7.2
    await conn.execute(
      `UPDATE refresh_token_events SET status = 'revoked'
       WHERE sessionId IN (SELECT id FROM sessions WHERE userId = ? AND loginMethod = ?)
         AND status IN ('active', 'rotated')`,
      [req.user!.userId, `oauth:${provider}`],
    )

    // Bump tokenVersion to invalidate all access tokens
    await conn.execute(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [req.user!.userId])

    await conn.commit()

    const oauthSessions = await queryOne(
      `SELECT COUNT(*) as cnt FROM sessions WHERE userId = ? AND loginMethod = ? AND revokedAt = ?`,
      [req.user!.userId, `oauth:${provider}`, now],
    )

    sendSuccess(res, {
      provider,
      unbound: true,
      revokedSessions: (oauthSessions?.cnt as number) || 0,
    }, req.requestId)
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('OAuth unbind error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '解绑失败', req.requestId, 500)
  } finally {
    conn.release()
  }

  // Audit log outside transaction (best-effort)
  writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'oauth.unbind',
    resourceType: 'oauth_account',
    resourceId: req.user!.userId,
    after: { provider, unbound: true },
  }).catch((e: unknown) => console.error('audit error:', e))
})

// GET /me/oauth/github/bind/start — api.md §1.7.1
router.get('/me/oauth/github/bind/start', requireAuth, async (req, res) => {
  // Check provider not already bound
  const existing = await queryOne(
    `SELECT id FROM oauth_accounts WHERE userId = ? AND provider = 'github'`,
    [req.user!.userId],
  )
  if (existing) {
    sendError(res, 'PROVIDER_ALREADY_BOUND', 'GitHub 账号已绑定', req.requestId, 409)
    return
  }
  await startBindFlow('github', req.user!.userId, req, res)
})

// GET /me/oauth/x/bind/start — api.md §1.7.1
router.get('/me/oauth/x/bind/start', requireAuth, async (req, res) => {
  const existing = await queryOne(
    `SELECT id FROM oauth_accounts WHERE userId = ? AND provider = 'x'`,
    [req.user!.userId],
  )
  if (existing) {
    sendError(res, 'PROVIDER_ALREADY_BOUND', 'X 账号已绑定', req.requestId, 409)
    return
  }
  await startBindFlow('x', req.user!.userId, req, res)
})

export default router
