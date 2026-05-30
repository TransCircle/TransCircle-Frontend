// GET /v1/auth/oauth/github/start — return authorization URL (JSON, not redirect)
// Per apidocs.md §1.6.1

import { successResponse } from '../../../_response'

interface Env {
  GITHUB_CLIENT_ID: string
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)

  const redirectUri = `${url.origin}/v1/auth/oauth/github/callback`
  const state = crypto.randomUUID()

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'read:user',
    state,
  })

  const authorizationUrl = `https://github.com/login/oauth/authorize?${params.toString()}`

  // Store state in HttpOnly cookie for CSRF verification in callback
  const resp = successResponse({ authorizationUrl, stateExpiresIn: 600 })
  const headers = new Headers(resp.headers)
  headers.append(
    'Set-Cookie',
    `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=600`,
  )
  return new Response(resp.body, { ...resp, headers })
}
