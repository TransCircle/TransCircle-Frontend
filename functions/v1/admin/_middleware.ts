// Admin auth middleware — protects all /v1/admin/* routes
// Supports two auth methods (checked in order):
// 1. JWT Bearer token with isAdmin=true
// 2. TEMP_ADMIN_TOKEN via Authorization header (temporary, for initial setup)

import { getSession } from '../_session'
import { errorResponse } from '../_response'

interface Env {
  SESSION_SECRET: string
  TEMP_ADMIN_TOKEN?: string
}

export const onRequest: PagesFunction<Env> = async ({ request, env, next }) => {
  // Method 1: JWT session
  const session = await getSession(request, env.SESSION_SECRET)
  if (session?.isAdmin) return next()

  // Method 2: Temporary admin token (for setup without OAuth)
  const tempToken = env.TEMP_ADMIN_TOKEN
  if (tempToken && tempToken.length > 0) {
    const auth = request.headers.get('Authorization') || ''
    if (auth === `Bearer ${tempToken}`) return next()
  }

  return errorResponse('UNAUTHORIZED', '需要管理员权限', 403)
}
