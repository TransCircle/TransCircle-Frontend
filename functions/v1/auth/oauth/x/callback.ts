// GET /v1/auth/oauth/x/callback — handle X OAuth callback with PKCE
// Per apidocs.md §1.6.2

import { setRefreshCookie, createRefreshToken } from '../../../_session'

interface Env {
  X_CLIENT_ID: string
  X_CLIENT_SECRET: string
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

  // Retrieve PKCE code_verifier and state from cookies
  const cookie = request.headers.get('Cookie') || ''
  const verifierMatch = cookie.match(/x_pkce=([^;]+)/)
  const codeVerifier = verifierMatch?.[1] || ''
  const stateMatch = cookie.match(/oauth_state=([^;]+)/)
  const storedState = stateMatch?.[1]

  // Verify OAuth state (CSRF protection)
  if (!state || !storedState || state !== storedState) {
    return redirectToFrontend(url.origin, { status: 'bad_state', code: 'BAD_STATE' })
  }

  if (!code) {
    return redirectToFrontend(url.origin, { status: 'oauth_error', code: 'OAUTH_ERROR' })
  }

  const redirectUri = `${url.origin}/v1/auth/oauth/x/callback`

  // Exchange code for token
  const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  })

  const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
  if (!tokenData.access_token) {
    console.error('X token exchange failed:', tokenData.error)
    return redirectToFrontend(url.origin, { status: 'oauth_error', code: 'OAUTH_ERROR' })
  }

  // Fetch X user info
  const userRes = await fetch('https://api.x.com/2/users/me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const userData = await userRes.json() as { data?: { id: string; username: string; profile_image_url?: string } }
  if (!userData.data) {
    return redirectToFrontend(url.origin, { status: 'oauth_error', code: 'OAUTH_ERROR' })
  }

  const username = userData.data.username
  const providerUserId = userData.data.id

  // Check if this OAuth user has an existing account
  const existingUser = await env.DB.prepare(
    `SELECT user_id FROM refresh_tokens
     WHERE provider = 'x' AND username = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(username).first<{ user_id: string }>()

  if (existingUser) {
    // ── Returning user: login_ok flow ──
    const userId = existingUser.user_id

    const refreshToken = await createRefreshToken(env.DB, {
      provider: 'x', userId, username,
      avatarUrl: userData.data.profile_image_url,
      isAdmin: false, tokenVersion: 0,
    })

    const loginCode = `oa_lc_${crypto.randomUUID()}`
    const lcHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(loginCode))
    const lcHashB64 = btoa(String.fromCharCode(...new Uint8Array(lcHash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    await env.DB.prepare(
      `INSERT INTO login_codes (code_hash, user_id, provider, username, is_admin, expires_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).bind(lcHashB64, userId, 'x', username, Date.now() + 60000, Date.now()).run()

    const resp = redirectToFrontend(url.origin, { status: 'login_ok', loginCode, provider: 'x' })
    const withRefresh = setRefreshCookie(resp, refreshToken)
    const headers = new Headers(withRefresh.headers)
    headers.append('Set-Cookie', 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=0')
    headers.append('Set-Cookie', 'x_pkce=; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=0')
    return new Response(withRefresh.body, { ...withRefresh, headers })
  }

  // ── New user: pending_registration flow ──
  const pendingToken = `oa_pend_${crypto.randomUUID()}`
  const pendingHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pendingToken))
  const pendingHashB64 = btoa(String.fromCharCode(...new Uint8Array(pendingHash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  await env.DB.prepare(
    `INSERT INTO oauth_pending
     (token_hash, provider, provider_user_id, provider_username, provider_email, provider_display_name, provider_avatar_url, mode, user_id, expires_at, created_at)
     VALUES (?, 'x', ?, ?, NULL, ?, ?, 'registration', NULL, ?, ?)`,
  ).bind(pendingHashB64, providerUserId, username, username, userData.data.profile_image_url || null, Date.now() + 600000, Date.now()).run()

  const resp = redirectToFrontend(url.origin, { status: 'pending_registration', provider: 'x' })
  const headers = new Headers(resp.headers)
  headers.append('Set-Cookie', `oauth_pending_x=${pendingToken}; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=600`)
  headers.append('Set-Cookie', `oauth_pending_csrf=${crypto.randomUUID()}; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=600`)
  headers.append('Set-Cookie', 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=0')
  headers.append('Set-Cookie', 'x_pkce=; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=0')
  return new Response(resp.body, { ...resp, headers })
}
