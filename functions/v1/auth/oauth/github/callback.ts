// GET /v1/auth/oauth/github/callback — handle GitHub OAuth callback
// Per apidocs.md §1.6.2

import { setRefreshCookie, createRefreshToken } from '../../../_session'

interface Env {
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  GITHUB_ORG: string
  DB: D1Database
}

function redirectToFrontend(base: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString()
  return Response.redirect(`${base}/auth/callback?${qs}`, 302)
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    return redirectToFrontend(url.origin, { status: 'oauth_error', code: 'OAUTH_ERROR' })
  }

  // Verify OAuth state (CSRF protection)
  const cookie = request.headers.get('Cookie') || ''
  const stateMatch = cookie.match(/oauth_state=([^;]+)/)
  const storedState = stateMatch?.[1]
  if (!state || !storedState || state !== storedState) {
    return redirectToFrontend(url.origin, { status: 'bad_state', code: 'BAD_STATE' })
  }

  if (!code) {
    return redirectToFrontend(url.origin, { status: 'oauth_error', code: 'OAUTH_ERROR' })
  }

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  })

  const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
  if (!tokenData.access_token) {
    console.error('GitHub token exchange failed:', tokenData.error)
    return redirectToFrontend(url.origin, { status: 'oauth_error', code: 'OAUTH_ERROR' })
  }

  // Fetch user info
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'TransCircle-Submit' },
  })
  const userData = await userRes.json() as { id: number; login: string; avatar_url: string }
  if (!userData.id) {
    return redirectToFrontend(url.origin, { status: 'oauth_error', code: 'OAUTH_ERROR' })
  }

  const username = userData.login
  const providerUserId = String(userData.id)

  // Check if this OAuth user has an existing account
  const existingUser = await env.DB.prepare(
    `SELECT user_id, is_admin FROM refresh_tokens
     WHERE provider = 'github' AND username = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(username).first<{ user_id: string; is_admin: number }>()

  if (existingUser) {
    // ── Returning user: login_ok flow ──
    const userId = existingUser.user_id

    const refreshToken = await createRefreshToken(env.DB, {
      provider: 'github', userId, username,
      avatarUrl: userData.avatar_url,
      isAdmin: existingUser.is_admin === 1,
      tokenVersion: 0,
    })

    const loginCode = `oa_lc_${crypto.randomUUID()}`
    const lcHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(loginCode))
    const lcHashB64 = btoa(String.fromCharCode(...new Uint8Array(lcHash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    await env.DB.prepare(
      `INSERT INTO login_codes (code_hash, user_id, provider, username, is_admin, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(lcHashB64, userId, 'github', username, existingUser.is_admin, Date.now() + 60000, Date.now()).run()

    const resp = redirectToFrontend(url.origin, { status: 'login_ok', loginCode, provider: 'github' })
    const withRefresh = setRefreshCookie(resp, refreshToken)
    const headers = new Headers(withRefresh.headers)
    headers.append('Set-Cookie', 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=0')
    return new Response(withRefresh.body, { ...withRefresh, headers })
  }

  // ── New user: pending_registration flow (per §1.6.2) ──
  // Generate pending token
  const pendingToken = `oa_pend_${crypto.randomUUID()}`
  const pendingHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pendingToken))
  const pendingHashB64 = btoa(String.fromCharCode(...new Uint8Array(pendingHash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  await env.DB.prepare(
    `INSERT INTO oauth_pending
     (token_hash, provider, provider_user_id, provider_username, provider_email, provider_display_name, provider_avatar_url, mode, user_id, expires_at, created_at)
     VALUES (?, 'github', ?, ?, NULL, ?, ?, 'registration', NULL, ?, ?)`,
  ).bind(pendingHashB64, providerUserId, userData.login, userData.login, userData.avatar_url, Date.now() + 600000, Date.now()).run()

  const resp = redirectToFrontend(url.origin, { status: 'pending_registration', provider: 'github' })
  const headers = new Headers(resp.headers)
  headers.append('Set-Cookie', `oauth_pending_github=${pendingToken}; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=600`)
  headers.append('Set-Cookie', `oauth_pending_csrf=${crypto.randomUUID()}; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=600`)
  headers.append('Set-Cookie', 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=0')
  return new Response(resp.body, { ...resp, headers })
}
