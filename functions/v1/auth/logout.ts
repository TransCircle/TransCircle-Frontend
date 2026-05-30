// POST /v1/auth/logout — clear refresh_token cookie
// Per apidocs.md §1.11.3

import { errorResponse } from '../_response'
import { clearRefreshCookie, clearSessionCookie, revokeRefreshTokens, getSession } from '../_session'

interface Env {
  DB: D1Database
  SESSION_SECRET: string
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const session = await getSession(request, env.SESSION_SECRET)
  if (!session) {
    return errorResponse('UNAUTHORIZED', '未登录', 401)
  }

  await revokeRefreshTokens(env.DB, session.userId)

  let resp = new Response(null, { status: 204 })
  resp = clearRefreshCookie(resp)
  resp = clearSessionCookie(resp)
  return resp
}
