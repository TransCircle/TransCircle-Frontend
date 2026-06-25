import { createContext, useEffect, useState, useCallback, useMemo, type ReactNode } from 'react'
import { get, post, setAccessToken as setClientToken, clearAuth, tryRefreshToken } from '@/api/client'
import { computePermissions } from '@/api/permissions'

interface User {
  id: string
  username: string
  email: string | null
  displayName: string
  avatarUrl: string | null
  emailVerified: boolean
  status: string
  roles: string[]
  /** 细粒度权限（鉴权权威，来自后端 IAM 快照）；旧 payload 可能缺失 */
  permissions?: string[]
  /** 是否为 IAM 账号（管理员经统一身份登录）：决定 step-up 走 IAM 代理 2FA */
  iamLinked?: boolean
  /** 是否为 Pass 账号（普通用户经 TransCircle Pass 登录）：账户由 Pass 统一管理 */
  passLinked?: boolean
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
  /** 是否可进入审核后台（拥有任一管理权限） */
  isAdmin: boolean
  permissions: string[]
  /** 手动更新 AuthContext 中的 accessToken（用于改密等需同步 token 的场景） */
  updateAccessToken: (token: string | null) => void
  /** 普通用户登录：跳转后端 /v1/auth/oauth/pass/start（TransCircle Pass，OIDC 流程同 IAM） */
  loginWithPass: () => Promise<void>
  /** IAM 统一身份登录(管理员)：provider=iam，OIDC 流程同 pass */
  loginWithIam: () => Promise<void>
  logout: () => Promise<void>
  logoutAll: () => Promise<{ revokedSessions: number } | null>
  exchangeLoginCode: (loginCode: string) => Promise<User | null>
  /** Refresh current user session — calls tryRefreshToken then fetches /v1/me. Returns User or null. */
  refreshUser: () => Promise<User | null>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [loginProvider, setLoginProvider] = useState<string | null>(null)
  // 权限权威来源 = 后端返回的 permissions（IAM 快照）；旧 payload 缺失时回退到角色派生
  const permissions = useMemo<string[]>(
    () => (Array.isArray(user?.permissions) ? user.permissions : computePermissions(user?.roles ?? [])),
    [user],
  )
  // 管理入口改为权限驱动（不再纯角色判断），以支持 editor 与 IAM 细粒度授权：
  // 拥有任一管理权限即可进入审核后台；具体页面/动作仍按各自所需权限进一步门控。
  const isAdmin = permissions.includes('*')
    || permissions.includes('contribution:read')
    || permissions.includes('user:read')
    || permissions.includes('audit:read')
  const updateAccessToken = useCallback((token: string | null) => {
    setAccessToken(token)
  }, [])

  // Try to get current user via stored token or refresh
  useEffect(() => {
    const init = async () => {
      try {
        // Try refresh to get an access token — cookie-based, must include credentials
        const token = await tryRefreshToken()
        if (token) {
          setAccessToken(token)
          // Token obtained: fetch full user profile from /v1/me (api.md §2.1)
          // If /me fails transiently, user stays null and auth-required pages redirect
          // to login — acceptable degradation. Do NOT clear the token, as the session
          // is still valid.
          const meResult = await get<Record<string, unknown>>('/me')
          if (meResult.ok) {
            setUser(normalizeUser(meResult.data))
          } else {
            // /me failed even with a valid token — likely a transient server issue.
            // The user will be redirected to login by guards, but the token remains
            // valid so a subsequent page load may succeed.
            console.warn('[auth] /me failed after successful refresh, user profile not loaded')
          }
        }
      } finally {
        // No token: user is not logged in, skip /me to avoid a pointless 401
        setLoading(false)
      }
    }
    init()
  }, [])

  // Start OAuth flow: fetch authorization URL from backend, then redirect.
  // pass = 普通用户（TransCircle Pass），iam = 管理员（统一身份）。两者均为 OIDC 跳转流程。
  const startOAuth = useCallback(async (provider: 'pass' | 'iam') => {
    setLoginProvider(provider)
    // 不要把鉴权页（/login、/register、/auth/*）作为登录后回跳目标，否则回调会回到登录页、
    // 看似未登录；此时留空，由回调按权限落地（landingPath）。
    const isAuthPage = /^\/(login|register|auth)\b/.test(window.location.pathname)
    const redirectAfter = isAuthPage ? '' : window.location.pathname + window.location.search
    const result = await get<{ authorizationUrl: string }>(
      `/auth/oauth/${provider}/start?redirectAfter=${encodeURIComponent(redirectAfter)}`,
    )
    if (result.ok && result.data.authorizationUrl) {
      window.location.href = result.data.authorizationUrl
    } else {
      window.location.href = `/auth/error?status=oauth_error&provider=${provider}`
    }
  }, [])

  const loginWithPass = useCallback(() => startOAuth('pass'), [startOAuth])
  const loginWithIam = useCallback(() => startOAuth('iam'), [startOAuth])

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
      permissions: Array.isArray(raw.permissions) ? (raw.permissions as string[]) : undefined,
      iamLinked: (raw.iamLinked as boolean) ?? false,
      passLinked: (raw.passLinked as boolean) ?? false,
      security: raw.security as User['security'] | undefined,
      createdAt: (raw.createdAt as number) ?? 0,
      lastLoginAt: (raw.lastLoginAt as number | null) ?? null,
    }
  }

  // Exchange loginCode for access token (called from callback page)
  // After exchange, fetch full /v1/me to get complete user profile
  const exchangeLoginCode = useCallback(async (loginCode: string): Promise<User | null> => {
    const result = await post<{
      accessToken?: string
      user?: Record<string, unknown>
    }>('/auth/oauth/exchange', { loginCode })

    if (!result.ok || !result.data.accessToken || !result.data.user) return null

    setClientToken(result.data.accessToken)
    setAccessToken(result.data.accessToken)

    // Fetch full profile from /v1/me to get roles/status/createdAt/security
    const meResult = await get<Record<string, unknown>>('/me')
    if (meResult.ok) {
      const u = normalizeUser(meResult.data)
      setUser(u)
      return u
    }

    // Fallback: use minimal user data from exchange response
    const u = normalizeUser(result.data.user)
    setUser(u)
    return u
  }, [])

  // Refresh current user session — calls tryRefreshToken then fetches /v1/me (api.md §1.11.3)
  const refreshUser = useCallback(async (): Promise<User | null> => {
    const newToken = await tryRefreshToken()
    if (newToken) setAccessToken(newToken)
    const meResult = await get<Record<string, unknown>>('/me')
    if (meResult.ok) {
      const u = normalizeUser(meResult.data)
      setUser(u)
      return u
    }
    setUser(null)
    return null
  }, [])

  const logout = useCallback(async () => {
    const result = await post('/auth/logout', undefined, { skipRefresh: true })
    if (!result.ok) {
      console.warn('[auth] logout API failed, clearing local state anyway', result.error)
    }
    clearAuth()
    setAccessToken(null)
    setUser(null)
    setLoginProvider(null)
  }, [])

  // Logout all sessions (api.md §1.11.4)
  const logoutAll = useCallback(async (): Promise<{ revokedSessions: number } | null> => {
    const result = await post<{ revokedSessions: number }>('/auth/logout-all')
    if (result.ok) {
      clearAuth()
      setAccessToken(null)
      setUser(null)
      setLoginProvider(null)
      return result.data
    }
    return null
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, accessToken, loginProvider, isAdmin, permissions, updateAccessToken, loginWithPass, loginWithIam, logout, logoutAll, exchangeLoginCode, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export { AuthContext, type AuthContextValue, type User }
