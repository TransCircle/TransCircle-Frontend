// GET /v1/me — return current user info from JWT
// Per apidocs.md §2.1

import { successResponse } from './_response'
import { getSession } from './_session'

interface Env {
  SESSION_SECRET: string
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await getSession(request, env.SESSION_SECRET)

  if (!session) {
    return successResponse({ user: null })
  }

  return successResponse({
    user: {
      provider: session.provider,
      username: session.username,
      avatarUrl: session.avatarUrl,
      isAdmin: session.isAdmin,
    },
  })
}
