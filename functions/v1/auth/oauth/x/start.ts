// GET /v1/auth/oauth/x/start — return X (Twitter) authorization URL
// Per apidocs.md §1.6.1

import { successResponse } from '../../../_response'

interface Env {
  X_CLIENT_ID: string
}

function generateCodeVerifier(): string {
  const buf = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = crypto.randomUUID()

  const url = new URL(request.url)
  const redirectUri = `${url.origin}/v1/auth/oauth/x/callback`

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.X_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'users.read',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  const authorizationUrl = `https://x.com/i/oauth2/authorize?${params.toString()}`

  const resp = successResponse({ authorizationUrl, stateExpiresIn: 600 })
  const headers = new Headers(resp.headers)
  headers.append(
    'Set-Cookie',
    `x_pkce=${codeVerifier}; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=600`,
  )
  headers.append(
    'Set-Cookie',
    `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/oauth; Max-Age=600`,
  )
  return new Response(resp.body, { ...resp, headers })
}
