// POST /v1/auth/logout-all — revoke all sessions for current user
// Per apidocs.md §1.11.4

import { successResponse, errorResponse } from '../_response'
import { clearRefreshCookie, revokeRefreshTokens, getSession } from '../_session'

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

  const resp = successResponse({ revokedSessions: 1 })
  return clearRefreshCookie(resp)
}
