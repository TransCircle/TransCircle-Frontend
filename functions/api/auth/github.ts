// GET /api/auth/github — initiate GitHub OAuth flow

interface Env {
  GITHUB_CLIENT_ID: string
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const redirectUri = `${url.origin}/api/auth/github-callback`
  const state = crypto.randomUUID()

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'read:user',
    state,
  })

  const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`
  return Response.redirect(authUrl, 302)
}
