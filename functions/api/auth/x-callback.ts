// GET /api/auth/x-callback — handle X OAuth 2.0 callback with PKCE

import { setSessionCookie, type SessionData } from '../_session'

interface Env {
  X_CLIENT_ID: string
  X_CLIENT_SECRET: string
  SESSION_SECRET: string
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  // Retrieve PKCE code_verifier from cookie
  const cookie = request.headers.get('Cookie') || ''
  const verifierMatch = cookie.match(/x_pkce=([^;]+)/)
  const codeVerifier = verifierMatch?.[1] || ''

  if (!code) {
    return new Response(JSON.stringify({ error: '缺少授权码' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const redirectUri = `${url.origin}/api/auth/x-callback`

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

  const tokenData = await tokenRes.json() as {
    access_token?: string
    error?: string
  }

  if (!tokenData.access_token) {
    console.error('X token exchange failed:', tokenData.error)
    return Response.redirect('/submit?error=oauth_failed', 302)
  }

  // Fetch X user info
  const userRes = await fetch('https://api.x.com/2/users/me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const userData = await userRes.json() as {
    data?: { id: string; username: string; profile_image_url?: string }
  }

  if (!userData.data) {
    return Response.redirect('/submit?error=oauth_failed', 302)
  }

  const session: SessionData = {
    provider: 'x',
    userId: userData.data.id,
    username: userData.data.username,
    avatarUrl: userData.data.profile_image_url,
    isAdmin: false, // X users are not admins by default
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  }

  const resp = Response.redirect('/submit', 302)
  return setSessionCookie(resp, env.SESSION_SECRET, session)
}
