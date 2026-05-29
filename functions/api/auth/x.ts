// GET /api/auth/x — initiate X (Twitter) OAuth 2.0 with PKCE

interface Env {
  X_CLIENT_ID: string
}

function generateCodeVerifier(): string {
  const buf = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const enc = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = crypto.randomUUID()

  const url = new URL(request.url)
  const redirectUri = `${url.origin}/api/auth/x-callback`

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.X_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'users.read',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  const authUrl = `https://x.com/i/oauth2/authorize?${params.toString()}`

  // Store code_verifier in a short-lived cookie for the callback
  const resp = Response.redirect(authUrl, 302)
  const headers = new Headers(resp.headers)
  headers.set(
    'Set-Cookie',
    `x_pkce=${codeVerifier}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=600`,
  )
  return new Response(resp.body, { ...resp, headers })
}
