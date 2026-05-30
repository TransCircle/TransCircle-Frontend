// POST /v1/auth/refresh — exchange refresh_token cookie for new access token
// Per apidocs.md §1.11.2 (with rotation + reuse detection)

import { successResponse, errorResponse } from '../_response'
import { createAccessToken } from '../_jwt'
import { getRefreshToken, verifyRefreshToken, rotateRefreshToken, setRefreshCookie, revokeRefreshTokens } from '../_session'

interface Env {
  DB: D1Database
  SESSION_SECRET: string
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const oldToken = getRefreshToken(request)
  if (!oldToken) {
    return errorResponse('INVALID_REFRESH_TOKEN', 'refresh token无效或已过期', 401)
  }

  const session = await verifyRefreshToken(env.DB, oldToken)
  if (!session) {
    // Check if this is a reuse case (token exists but is rotated/revoked)
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(oldToken))
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    const tokenRow = await env.DB.prepare(
      `SELECT status FROM refresh_tokens WHERE token_hash = ?`
    ).bind(hashB64).first<{ status: string }>()

    if (tokenRow && tokenRow.status !== 'active') {
      // Token was already used — potential replay attack
      await revokeRefreshTokens(env.DB, '')
      return errorResponse('REFRESH_TOKEN_REVOKED', 'refresh token已被吊销，请重新登录', 401)
    }
    return errorResponse('INVALID_REFRESH_TOKEN', 'refresh token无效或已过期', 401)
  }

  // Generate new access token
  const accessToken = await createAccessToken(env.SESSION_SECRET, {
    userId: session.userId,
    username: session.username,
    provider: session.provider,
    isAdmin: session.isAdmin,
  }, session.tokenVersion)

  // Rotate refresh token
  const newRefreshToken = await rotateRefreshToken(env.DB, oldToken, session)
  if (!newRefreshToken) {
    return errorResponse('INVALID_REFRESH_TOKEN', 'refresh token rotation failed', 401)
  }

  const resp = successResponse({
    accessToken,
    tokenType: 'Bearer',
    expiresIn: 900,
  })

  return setRefreshCookie(resp, newRefreshToken)
}
