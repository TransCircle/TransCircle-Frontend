// GET /v1/auth/oauth/pending-profile?provider=github|x
// Per apidocs.md §1.6.6 — get prefill data from pending OAuth token

import { successResponse, errorResponse } from '../../_response'

interface Env {
  DB: D1Database
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const provider = url.searchParams.get('provider')
  if (!provider || !['github', 'x'].includes(provider)) {
    return errorResponse('BAD_REQUEST', '无效的provider', 400)
  }

  // Verify oauth_pending cookie + CSRF
  const cookie = request.headers.get('Cookie') || ''
  const pendingMatch = cookie.match(new RegExp(`oauth_pending_${provider}=([^;]+)`))
  if (!pendingMatch) {
    return errorResponse('MISSING_OAUTH_PENDING', '缺少oauth_pending Cookie', 401)
  }
  const pendingToken = pendingMatch[1]

  const csrfCookie = cookie.match(/oauth_pending_csrf=([^;]+)/)
  const csrfHeader = request.headers.get('X-CSRF-Token') || ''
  if (!csrfCookie || csrfHeader !== csrfCookie[1]) {
    return errorResponse('CSRF_TOKEN_INVALID', 'CSRF token校验失败', 403)
  }

  // Look up pending token
  const pendingHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pendingToken))
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(pendingHash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const pending = await env.DB.prepare(
    `SELECT provider, provider_email, provider_display_name, mode, expires_at
     FROM oauth_pending WHERE token_hash = ? AND expires_at > ? AND used_at IS NULL`,
  ).bind(hashB64, Date.now()).first<{
    provider: string; provider_email: string | null;
    provider_display_name: string | null; mode: string; expires_at: number
  }>()

  if (!pending) {
    return errorResponse('TOKEN_INVALID_OR_EXPIRED', 'pendingToken无效或已过期', 410)
  }

  const remainingSeconds = Math.max(0, Math.floor((pending.expires_at - Date.now()) / 1000))

  return successResponse({
    provider: pending.provider,
    mode: pending.mode,
    suggestedEmail: pending.provider_email || null,
    suggestedDisplayName: pending.provider_display_name || null,
    providerEmailVerified: true,
    expiresIn: remainingSeconds,
  })
}
