// POST /v1/auth/oauth/exchange — exchange loginCode for access token
// Per apidocs.md §1.6.3

import { successResponse, errorResponse } from '../../_response'
import { createAccessToken } from '../../_jwt'
import { getRefreshToken, verifyRefreshToken } from '../../_session'

interface Env {
  DB: D1Database
  SESSION_SECRET: string
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: { loginCode?: string }
  try {
    body = await request.json()
  } catch {
    return errorResponse('BAD_REQUEST', '请求格式错误', 400)
  }

  if (!body.loginCode) {
    return errorResponse('BAD_REQUEST', '缺少loginCode', 400)
  }

  // Hash the loginCode to look up in DB
  const codeHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.loginCode))
  const codeHashB64 = btoa(String.fromCharCode(...new Uint8Array(codeHash)))

  const row = await env.DB.prepare(
    `SELECT user_id, provider, username, is_admin FROM login_codes
     WHERE code_hash = ? AND expires_at > ?`
  ).bind(codeHashB64, Date.now()).first<{
    user_id: string; provider: string; username: string; is_admin: number
  }>()

  if (!row) {
    return errorResponse('TOKEN_INVALID_OR_EXPIRED', 'loginCode无效或已过期', 410)
  }

  // Verify refresh token from cookie
  const refreshToken = getRefreshToken(request)
  if (!refreshToken) {
    return errorResponse('INVALID_REFRESH_TOKEN', '缺少refresh token', 401)
  }

  const session = await verifyRefreshToken(env.DB, refreshToken)
  if (!session || session.userId !== row.user_id) {
    return errorResponse('INVALID_REFRESH_TOKEN', 'refresh token无效', 401)
  }

  // Delete used loginCode
  await env.DB.prepare('DELETE FROM login_codes WHERE code_hash = ?').bind(codeHashB64).run()

  // Generate access token
  const accessToken = await createAccessToken(env.SESSION_SECRET, {
    userId: row.user_id,
    username: row.username,
    provider: row.provider,
    isAdmin: row.is_admin === 1,
  }, session.tokenVersion)

  return successResponse({
    accessToken,
    tokenType: 'Bearer',
    expiresIn: 900,
    user: {
      id: row.user_id,
      username: row.username,
      provider: row.provider,
      isAdmin: row.is_admin === 1,
    },
  })
}
