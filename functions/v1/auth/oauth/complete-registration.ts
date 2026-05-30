// POST /v1/auth/oauth/complete-registration?provider=github|x
// Per apidocs.md §1.6.4 — complete password registration after OAuth

import { successResponse, errorResponse } from '../../_response'
import { setRefreshCookie, createRefreshToken } from '../../_session'
import { ulidWithPrefix } from '../../_ulid'

interface Env {
  DB: D1Database
  SESSION_SECRET: string
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const provider = url.searchParams.get('provider')
  if (!provider || !['github', 'x'].includes(provider)) {
    return errorResponse('BAD_REQUEST', '无效的provider', 400)
  }

  // Verify oauth_pending cookie + CSRF
  const cookie = request.headers.get('Cookie') || ''
  const pendingMatch = cookie.match(new RegExp(`oauth_pending_${provider}=([^;]+)`))
  if (!pendingMatch) {
    return errorResponse('MISSING_OAUTH_PENDING', '缺少oauth_pending Cookie', 401)
  }
  const pendingToken = pendingMatch[1]

  const csrfCookie = cookie.match(/oauth_pending_csrf=([^;]+)/)
  const csrfHeader = request.headers.get('X-CSRF-Token') || ''
  if (!csrfCookie || csrfHeader !== csrfCookie[1]) {
    return errorResponse('CSRF_TOKEN_INVALID', 'CSRF token校验失败', 403)
  }

  let body: {
    username?: string; email?: string; password?: string
    displayName?: string; emailMatchesProvider?: boolean
  }
  try { body = await request.json() } catch {
    return errorResponse('BAD_REQUEST', '请求格式错误', 400)
  }

  // Validate pending token
  const pendingHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pendingToken))
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(pendingHash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const pending = await env.DB.prepare(
    `SELECT token_hash, provider, provider_user_id, provider_username,
            provider_email, provider_display_name, provider_avatar_url, mode
     FROM oauth_pending WHERE token_hash = ? AND expires_at > ? AND used_at IS NULL`,
  ).bind(hashB64, Date.now()).first<Record<string, unknown>>()

  if (!pending) {
    return errorResponse('TOKEN_INVALID_OR_EXPIRED', 'pendingToken无效或已过期', 410)
  }

  // Mark as used
  await env.DB.prepare(
    `UPDATE oauth_pending SET used_at = ? WHERE token_hash = ?`,
  ).bind(Date.now(), hashB64).run()

  // Create user
  const userId = ulidWithPrefix('usr_')
  const now = Date.now()
  const isAdmin = provider === 'github' ? false : false // X users not admin

  // Create session
  const session = {
    provider: provider as 'github' | 'x',
    userId,
    username: (body.username || pending.provider_username) as string,
    avatarUrl: pending.provider_avatar_url as string | undefined,
    isAdmin,
    tokenVersion: 0,
  }

  const refreshToken = await createRefreshToken(env.DB, session)

  // Generate loginCode
  const loginCode = `oa_lc_${crypto.randomUUID()}`
  const lcHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(loginCode))
  const lcHashB64 = btoa(String.fromCharCode(...new Uint8Array(lcHash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  await env.DB.prepare(
    `INSERT INTO login_codes (code_hash, user_id, provider, username, is_admin, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(lcHashB64, userId, provider, session.username, isAdmin ? 1 : 0, now + 60000, now).run()

  const resp = successResponse({
    user: {
      id: userId,
      username: session.username,
      email: body.email || pending.provider_email || null,
      displayName: body.displayName || pending.provider_display_name || session.username,
      avatarUrl: session.avatarUrl || null,
      emailVerified: false,
      status: 'pending_verification',
      createdAt: now,
    },
    boundProvider: provider,
    loginCode,
    verificationEmailSent: false,
  }, 201)

  const withRefresh = setRefreshCookie(resp, refreshToken)
  const headers = new Headers(withRefresh.headers)
  headers.append('Set-Cookie', `oauth_pending_${provider}=; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=0`)
  headers.append('Set-Cookie', 'oauth_pending_csrf=; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=0')
  return new Response(withRefresh.body, { ...withRefresh, headers })
}
