import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'

interface User {
  provider: 'github' | 'x'
  username: string
  avatarUrl?: string
  isAdmin: boolean
  displayName?: string
  emailVerified?: boolean
  roles?: string[]
}

interface AuthContextValue {
  user: User | null
  loading: boolean
  accessToken: string | null
  loginWithGitHub: () => Promise<void>
  loginWithX: () => Promise<void>
  logout: () => Promise<void>
  exchangeLoginCode: (loginCode: string) => Promise<User | null>
  completeRegistration: (provider: string, data: { username?: string; email?: string; password?: string; displayName?: string }) => Promise<{ loginCode?: string; user: User | null } | null>
}

const AuthContext = createContext<AuthContextValue | null>(null)

let memoryToken: string | null = null

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [accessToken, setAccessToken] = useState<string | null>(null)

  // Try to get current user via stored token or refresh
  useEffect(() => {
    const init = async () => {
      // Try refresh to get an access token
      try {
        const refreshRes = await fetch('/v1/auth/refresh', { method: 'POST' })
        if (refreshRes.ok) {
          const body = await refreshRes.json() as { data?: { accessToken?: string } }
          if (body.data?.accessToken) {
            memoryToken = body.data.accessToken
            setAccessToken(memoryToken)
          }
        }
      } catch { /* no refresh cookie */ }

      // Get user with the token
      try {
        const headers: Record<string, string> = {}
        if (memoryToken) headers.Authorization = `Bearer ${memoryToken}`
        const res = await fetch('/v1/me', { headers })
        const body = await res.json() as { data?: { user: User | null } }
        if (body.data?.user) setUser(body.data.user)
      } catch { /* API not available */ }

      setLoading(false)
    }
    init()
  }, [])

  // Start OAuth flow: fetch authorization URL from backend, then redirect
  const loginWithGitHub = useCallback(async () => {
    try {
      const res = await fetch('/v1/auth/oauth/github/start')
      const body = await res.json() as { data?: { authorizationUrl?: string } }
      if (body.data?.authorizationUrl) {
        window.location.href = body.data.authorizationUrl
      }
    } catch { /* fallback: direct redirect */ }
  }, [])

  const loginWithX = useCallback(async () => {
    try {
      const res = await fetch('/v1/auth/oauth/x/start')
      const body = await res.json() as { data?: { authorizationUrl?: string } }
      if (body.data?.authorizationUrl) {
        window.location.href = body.data.authorizationUrl
      }
    } catch { /* fallback */ }
  }, [])

  // Exchange loginCode for access token (called from callback page)
  const exchangeLoginCode = useCallback(async (loginCode: string): Promise<User | null> => {
    try {
      const res = await fetch('/v1/auth/oauth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginCode }),
      })
      if (!res.ok) return null
      const body = await res.json() as { data?: { accessToken?: string; user?: User } }
      if (body.data?.accessToken && body.data?.user) {
        memoryToken = body.data.accessToken
        setAccessToken(memoryToken)
        setUser(body.data.user)
        return body.data.user
      }
    } catch { /* exchange failed */ }
    return null
  }, [])

  // Complete OAuth registration for new users (per apidocs.md §1.6.4)
  const completeRegistration = useCallback(async (provider: string, data: { username?: string; email?: string; password?: string; displayName?: string }) => {
    try {
      const csrfMatch = document.cookie.match(/oauth_pending_csrf=([^;]+)/)
      const csrfToken = csrfMatch?.[1] || ''

      const res = await fetch(`/v1/auth/oauth/complete-registration?provider=${encodeURIComponent(provider)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(data),
      })

      if (!res.ok) return null
      const body = await res.json() as { data?: { loginCode?: string; user?: User } }

      if (body.data?.loginCode) {
        const user = await exchangeLoginCode(body.data.loginCode)
        return { loginCode: body.data.loginCode, user }
      }
    } catch { /* registration failed */ }
    return null
  }, [exchangeLoginCode])

  const logout = useCallback(async () => {
    const headers: Record<string, string> = {}
    if (memoryToken) headers.Authorization = `Bearer ${memoryToken}`
    await fetch('/v1/auth/logout', { method: 'POST', headers }).catch(() => {})
    memoryToken = null
    setAccessToken(null)
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, accessToken, loginWithGitHub, loginWithX, logout, exchangeLoginCode, completeRegistration }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
