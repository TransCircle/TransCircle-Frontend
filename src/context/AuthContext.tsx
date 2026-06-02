import { createContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { API_BASE } from '@/config'

interface User {
  id: string
  username: string
  email: string | null
  displayName: string
  avatarUrl: string | null
  emailVerified: boolean
  status: string
  roles: string[]
  security?: {
    hasPassword: boolean
    totpEnabled: boolean
    passkeyCount: number
    oauthProviders: string[]
  }
  createdAt: number
  lastLoginAt: number | null
}

interface AuthContextValue {
  user: User | null
  loading: boolean
  accessToken: string | null
  loginProvider: string | null
  isAdmin: boolean
  loginWithPassword: (identifier: string, password: string) => Promise<User | null>
  loginWithGitHub: () => Promise<void>
  loginWithX: () => Promise<void>
  logout: () => Promise<void>
  exchangeLoginCode: (loginCode: string) => Promise<User | null>
  completeRegistration: (provider: string, data: { username?: string; email?: string; password?: string; displayName?: string; emailMatchesProvider?: boolean }) => Promise<{ loginCode?: string; user: User | null } | null>
}

const AuthContext = createContext<AuthContextValue | null>(null)

let memoryToken: string | null = null

function _logRequestId(label: string, body: { requestId?: string }): void {
  if (body.requestId) {
    console.debug(`[api] ${label} requestId=${body.requestId}`)
  }
}

// Refresh promise queue: prevents concurrent refresh requests when multiple callers
// request a token refresh at the same time (e.g., rapid page navigation).
let _refreshPromise: Promise<string | null> | null = null

async function doRefresh(): Promise<string | null> {
  // If a refresh is already in-flight, reuse its promise (race-grace prevention)
  if (_refreshPromise) return _refreshPromise

  _refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })

      if (res.status === 401) {
        // REFRESH_TOKEN_REVOKED or INVALID_REFRESH_TOKEN — clear stale state
        memoryToken = null
        return null
      }

      if (!res.ok) return null

      const body = await res.json() as { data?: { accessToken?: string }; requestId?: string }
      _logRequestId('auth/refresh', body)

      if (body.data?.accessToken) {
        memoryToken = body.data.accessToken
        return memoryToken
      }
      return null
    } catch {
      return null
    } finally {
      _refreshPromise = null
    }
  })()

  return _refreshPromise
}

function setMemoryToken(token: string | null): void {
  memoryToken = token
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [loginProvider, setLoginProvider] = useState<string | null>(null)
  const isAdmin = user ? user.roles.includes('reviewer') : false

  // Try to get current user via stored token or refresh
  useEffect(() => {
    const init = async () => {
      // Try refresh to get an access token — cookie-based, must include credentials
      const token = await doRefresh()
      if (token) setAccessToken(token)

      // Get full user profile from /v1/me (per api.md §2.1)
      try {
        const headers: Record<string, string> = {}
        const tk = memoryToken
        if (tk) headers.Authorization = `Bearer ${tk}`
        const res = await fetch(`${API_BASE}/me`, { headers })
        const body = await res.json() as { data?: Record<string, unknown>; requestId?: string }
        _logRequestId('me', body)
        if (body.data) {
          const u = normalizeUser(body.data)
          setUser(u)
        }
      } catch { /* API not available */ }

      setLoading(false)
    }
    init()
  }, [])

  // Start OAuth flow: fetch authorization URL from backend, then redirect
  const loginWithGitHub = useCallback(async () => {
    setLoginProvider('github')
    const redirectAfter = window.location.pathname + window.location.search
    try {
      const res = await fetch(`${API_BASE}/auth/oauth/github/start?redirectAfter=${encodeURIComponent(redirectAfter)}`)
      const body = await res.json() as { data?: { authorizationUrl?: string } }
      if (body.data?.authorizationUrl) {
        window.location.href = body.data.authorizationUrl
      }
    } catch { /* fallback: direct redirect */ }
  }, [])

  const loginWithX = useCallback(async () => {
    setLoginProvider('x')
    const redirectAfter = window.location.pathname + window.location.search
    try {
      const res = await fetch(`${API_BASE}/auth/oauth/x/start?redirectAfter=${encodeURIComponent(redirectAfter)}`)
      const body = await res.json() as { data?: { authorizationUrl?: string } }
      if (body.data?.authorizationUrl) {
        window.location.href = body.data.authorizationUrl
      }
    } catch { /* fallback */ }
  }, [])

  // Password login (api.md §1.3): POST /v1/auth/login
  const loginWithPassword = useCallback(async (identifier: string, password: string): Promise<User | null> => {
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
        credentials: 'include',
      })

      if (!res.ok) {
        // Let the caller handle errors based on status/code
        return null
      }

      const body = await res.json() as {
        data?: { accessToken?: string; user?: Record<string, unknown>; mfaRequired?: boolean }
        requestId?: string
      }
      _logRequestId('auth/login', body)

      const d = body.data
      if (!d) return null

      // MFA required — not yet handled in MVP
      if (d.mfaRequired) return null

      if (d.accessToken && d.user) {
        setMemoryToken(d.accessToken)
        setAccessToken(d.accessToken)
        setLoginProvider(null)

        // Fetch full profile from /v1/me for roles/status/security
        try {
          const meRes = await fetch(`${API_BASE}/me`, {
            headers: { Authorization: `Bearer ${d.accessToken}` },
          })
          if (meRes.ok) {
            const meBody = await meRes.json() as { data?: Record<string, unknown>; requestId?: string }
            _logRequestId('me', meBody)
            if (meBody.data) {
              const u = normalizeUser(meBody.data)
              setUser(u)
              return u
            }
          }
        } catch { /* fallback to login user data */ }

        const u = normalizeUser(d.user)
        setUser(u)
        return u
      }
    } catch { /* login failed */ }
    return null
  }, [])

  // Normalize user data from different API response shapes into the canonical User type
  // GET /v1/me returns full profile; OAuth exchange returns minimal profile as fallback
  function normalizeUser(raw: Record<string, unknown>): User {
    return {
      id: (raw.id as string) ?? '',
      username: (raw.username as string) ?? '',
      email: (raw.email as string | null) ?? null,
      displayName: (raw.displayName as string) ?? '',
      avatarUrl: (raw.avatarUrl as string | null) ?? null,
      emailVerified: (raw.emailVerified as boolean) ?? false,
      status: (raw.status as string) ?? 'active',
      roles: Array.isArray(raw.roles) ? (raw.roles as string[]) : [],
      security: raw.security as User['security'] | undefined,
      createdAt: (raw.createdAt as number) ?? 0,
      lastLoginAt: (raw.lastLoginAt as number | null) ?? null,
    }
  }

  // Exchange loginCode for access token (called from callback page)
  // After exchange, fetch full /v1/me to get complete user profile
  const exchangeLoginCode = useCallback(async (loginCode: string): Promise<User | null> => {
    try {
      const res = await fetch(`${API_BASE}/auth/oauth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ loginCode }),
      })
      if (!res.ok) return null
      const body = await res.json() as { data?: { accessToken?: string; user?: Record<string, unknown> }; requestId?: string }
      _logRequestId('auth/oauth/exchange', body)
      if (body.data?.accessToken && body.data?.user) {
        setMemoryToken(body.data.accessToken)
        setAccessToken(body.data.accessToken)
        // Fetch full profile from /v1/me to get roles/status/createdAt/security
        try {
          const meRes = await fetch(`${API_BASE}/me`, {
            headers: { Authorization: `Bearer ${body.data.accessToken}` },
          })
          if (meRes.ok) {
            const meBody = await meRes.json() as { data?: Record<string, unknown>; requestId?: string }
            _logRequestId('me', meBody)
            if (meBody.data) {
              const u = normalizeUser(meBody.data)
              setUser(u)
              return u
            }
          }
        } catch { /* fallback to exchange user data */ }
        // Fallback: use minimal user data from exchange response
        const u = normalizeUser(body.data.user)
        setUser(u)
        return u
      }
    } catch { /* exchange failed */ }
    return null
  }, [])

  // Complete OAuth registration for new users (per apidocs.md §1.6.4)
  const completeRegistration = useCallback(async (provider: string, data: { username?: string; email?: string; password?: string; displayName?: string; emailMatchesProvider?: boolean }) => {
    try {
      const csrfMatch = document.cookie.match(/oauth_pending_csrf=([^;]+)/)
      const csrfToken = csrfMatch?.[1] || ''

      const res = await fetch(`${API_BASE}/auth/oauth/complete-registration?provider=${encodeURIComponent(provider)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
          'Idempotency-Key': crypto.randomUUID(),
        },
        credentials: 'include',
        body: JSON.stringify(data),
      })

      if (!res.ok) return null
      const body = await res.json() as { data?: { loginCode?: string; user?: Record<string, unknown> }; requestId?: string }
      _logRequestId('auth/oauth/complete-registration', body)

      if (body.data?.loginCode) {
        const u = await exchangeLoginCode(body.data.loginCode)
        return { loginCode: body.data.loginCode, user: u }
      }
    } catch { /* registration failed */ }
    return null
  }, [exchangeLoginCode])

  const logout = useCallback(async () => {
    const headers: Record<string, string> = {}
    const tk = memoryToken
    if (tk) headers.Authorization = `Bearer ${tk}`
    try {
      const res = await fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers, credentials: 'include' })
      // 204 No Content — parse requestId from header if available
      const reqId = res.headers.get('X-Request-Id')
      if (reqId) console.debug(`[api] auth/logout requestId=${reqId}`)
    } catch { /* logout best-effort */ }
    _refreshPromise = null
    setMemoryToken(null)
    setAccessToken(null)
    setUser(null)
    setLoginProvider(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, accessToken, loginProvider, isAdmin, loginWithPassword, loginWithGitHub, loginWithX, logout, exchangeLoginCode, completeRegistration }}>
      {children}
    </AuthContext.Provider>
  )
}

export { AuthContext, type AuthContextValue, type User }
