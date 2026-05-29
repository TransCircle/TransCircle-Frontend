// GET /api/auth/github-callback — handle GitHub OAuth callback
// Exchange code → access token → fetch user → verify org → create session

import { setSessionCookie, type SessionData } from '../_session'

interface Env {
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  GITHUB_ORG: string
  SESSION_SECRET: string
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (!code) {
    return new Response(JSON.stringify({ error: '缺少授权码' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 1. Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      state,
    }),
  })

  const tokenData = await tokenRes.json() as {
    access_token?: string
    error?: string
  }

  if (!tokenData.access_token) {
    console.error('GitHub token exchange failed:', tokenData.error)
    return Response.redirect('/submit?error=oauth_failed', 302)
  }

  // 2. Fetch user info
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'User-Agent': 'TransCircle-Submit',
    },
  })
  const userData = await userRes.json() as {
    id: number
    login: string
    avatar_url: string
  }

  if (!userData.id) {
    return Response.redirect('/submit?error=oauth_failed', 302)
  }

  // 3. Check organization membership (for admin access)
  let isAdmin = false
  try {
    const orgRes = await fetch(
      `https://api.github.com/orgs/${env.GITHUB_ORG}/members/${userData.login}`,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          'User-Agent': 'TransCircle-Submit',
        },
      },
    )
    isAdmin = orgRes.status === 204
  } catch {
    // Org check failed — non-admin user
  }

  // 4. Create session
  const session: SessionData = {
    provider: 'github',
    userId: String(userData.id),
    username: userData.login,
    avatarUrl: userData.avatar_url,
    isAdmin,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  }

  const redirectUrl = isAdmin ? '/admin' : '/submit'
  const resp = Response.redirect(
    new URL(redirectUrl, request.url).toString(),
    302,
  )
  return setSessionCookie(resp, env.SESSION_SECRET, session)
}
