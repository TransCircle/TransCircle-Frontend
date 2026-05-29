// GET /api/auth/me — return current user info from session cookie

import { getSession } from '../_session'

interface Env {
  SESSION_SECRET: string
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await getSession(request, env.SESSION_SECRET)

  if (!session || Date.now() > session.exp * 1000) {
    return new Response(JSON.stringify({ user: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({
    user: {
      provider: session.provider,
      username: session.username,
      avatarUrl: session.avatarUrl,
      isAdmin: session.isAdmin,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
