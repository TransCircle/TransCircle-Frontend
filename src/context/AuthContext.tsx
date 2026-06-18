import { createContext, useEffect, useState, useCallback, useMemo, type ReactNode } from 'react'
import { get, post, setAccessToken as setClientToken, clearAuth, tryRefreshToken } from '@/api/client'
import { computePermissions, type Permission } from '@/api/permissions'

function arrayBufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

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

export interface LoginResult {
  user: User | null
  /** Non-null when MFA is required — contains the MFA challenge details */
  mfaChallengeToken?: string
  mfaAvailableMethods?: string[]
  /** Error code when login fails (null if successful) */
  errorCode?: string
}

interface AuthContextValue {
  user: User | null
  loading: boolean
  accessToken: string | null
  loginProvider: string | null
  isAdmin: boolean
  isFullAdmin: boolean
  permissions: Permission[]
  /** 手动更新 AuthContext 中的 accessToken（用于改密等需同步 token 的场景） */
  updateAccessToken: (token: string | null) => void
  loginWithPassword: (identifier: string, password: string) => Promise<LoginResult>
  loginWithGitHub: () => Promise<void>
  loginWithX: () => Promise<void>
  logout: () => Promise<void>
  logoutAll: () => Promise<{ revokedSessions: number } | null>
  exchangeLoginCode: (loginCode: string) => Promise<User | null>
  completeRegistration: (provider: string, data: { username?: string; email?: string; password?: string; displayName?: string; emailMatchesProvider?: boolean }) => Promise<{ loginCode?: string; user: User | null; errorCode?: string; errorMessage?: string }>
  /** MFA TOTP verification — saves token to context and fetches user profile (api.md §1.9.4) */
  mfaVerify: (mfaChallengeToken: string, code: string) => Promise<{ user: User | null; errorCode?: string }>
  /** Passkey login — full WebAuthn flow (api.md §1.10.5); pass mfaChallengeToken for MFA context */
    loginWithPasskey: (mfaChallengeToken?: string) => Promise<LoginResult>
  /** Refresh current user session — calls tryRefreshToken then fetches /v1/me. Returns User or null. */
  refreshUser: () => Promise<User | null>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [loginProvider, setLoginProvider] = useState<string | null>(null)
  const isAdmin = user ? (user.roles.includes('admin') || user.roles.includes('reviewer')) : false
  const isFullAdmin = user ? user.roles.includes('admin') : false
  const permissions = useMemo(() => computePermissions(user?.roles ?? []), [user])
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
          const meResult = await get<Record<string, unknown>>('/me')
          if (meResult.ok) {
            setUser(normalizeUser(meResult.data))
          }
        }
      } finally {
        // No token: user is not logged in, skip /me to avoid a pointless 401
        setLoading(false)
      }
    }
    init()
  }, [])

  // Start OAuth flow: fetch authorization URL from backend, then redirect
  const startOAuth = useCallback(async (provider: 'github' | 'x') => {
    setLoginProvider(provider)
    const redirectAfter = window.location.pathname + window.location.search
    const result = await get<{ authorizationUrl: string }>(
      `/auth/oauth/${provider}/start?redirectAfter=${encodeURIComponent(redirectAfter)}`,
    )
    if (result.ok && result.data.authorizationUrl) {
      window.location.href = result.data.authorizationUrl
    } else {
      window.location.href = `/auth/error?status=oauth_error&provider=${provider}`
    }
  }, [])

  const loginWithGitHub = useCallback(() => startOAuth('github'), [startOAuth])
  const loginWithX = useCallback(() => startOAuth('x'), [startOAuth])

  // Password login (api.md §1.3): POST /v1/auth/login
  const loginWithPassword = useCallback(async (identifier: string, password: string): Promise<LoginResult> => {
    const result = await post<{
      accessToken?: string
      user?: Record<string, unknown>
      mfaRequired?: boolean
      mfaChallengeToken?: string
      availableMethods?: string[]
    }>('/auth/login', { identifier, password })

    if (!result.ok) {
      return { user: null, errorCode: result.error.code }
    }

    const d = result.data

    // MFA required — return challenge details so caller handles without second API call
    if (d.mfaRequired) {
      return {
        user: null,
        mfaChallengeToken: d.mfaChallengeToken || '',
        mfaAvailableMethods: d.availableMethods || [],
      }
    }

    if (d.accessToken && d.user) {
      setClientToken(d.accessToken)
      setAccessToken(d.accessToken)
      setLoginProvider(null)

      // Fetch full profile from /v1/me first to get accurate roles/security fields
      const meResult = await get<Record<string, unknown>>('/me')
      if (meResult.ok) {
        const u = normalizeUser(meResult.data)
        setUser(u)
        return { user: u }
      }

      // Fallback: use minimal user data from login response
      const u = normalizeUser(d.user)
      setUser(u)
      return { user: u }
    }

    return { user: null }
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

  // Complete OAuth registration for new users (api.md §1.6.4)
  const completeRegistration = useCallback(async (
    provider: string,
    data: { username?: string; email?: string; password?: string; displayName?: string; emailMatchesProvider?: boolean },
  ) => {
    const payload: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data)) {
      if (k === 'emailMatchesProvider') {
        if (v !== undefined) payload[k] = v
      } else if (v !== undefined) {
        payload[k] = v
      }
    }

    const result = await post<{
      loginCode?: string
      user?: Record<string, unknown>
    }>(`/auth/oauth/complete-registration?provider=${encodeURIComponent(provider)}`, payload, {
      csrf: true,
      idempotent: true,
    })

    if (!result.ok) {
      return { user: null, errorCode: result.error.code, errorMessage: result.error.message }
    }

    if (result.data.loginCode) {
      const u = await exchangeLoginCode(result.data.loginCode)
      return { loginCode: result.data.loginCode, user: u }
    }
    return { user: null }
  }, [exchangeLoginCode])

  // MFA TOTP verification (api.md §1.9.4): /v1/auth/mfa/totp/verify
  const mfaVerify = useCallback(async (mfaChallengeToken: string, code: string): Promise<{ user: User | null; errorCode?: string }> => {
    const result = await post<{
      accessToken?: string
      user?: Record<string, unknown>
    }>('/auth/mfa/totp/verify', { mfaChallengeToken, code })

    if (!result.ok) {
      return { user: null, errorCode: result.error.code }
    }

    if (!result.data.accessToken) {
      return { user: null }
    }

    setClientToken(result.data.accessToken)
    setAccessToken(result.data.accessToken)

    // Fetch full profile from /v1/me
    const meResult = await get<Record<string, unknown>>('/me')
    if (meResult.ok) {
      const u = normalizeUser(meResult.data)
      setUser(u)
      return { user: u }
    }

    // Fallback: minimal user
    if (result.data.user) {
      const u = normalizeUser(result.data.user)
      setUser(u)
      return { user: u }
    }
    return { user: null }
  }, [])

  // ── Passkey Login (api.md §1.10.5) ──
  const loginWithPasskey = useCallback(async (mfaChallengeToken?: string): Promise<LoginResult> => {
    const startResult = await post<{
      challengeId: string
      publicKey: {
        challenge: string
        rpId: string
        timeout: number
        userVerification: string
        allowCredentials?: Array<{ type: string; id: string; transports: string[] }>
      }
      expiresIn: number
    }>('/auth/passkey/login/start', { identifier: undefined })

    if (!startResult.ok) {
      return { user: null, errorCode: startResult.error.code }
    }

    const { challengeId, publicKey } = startResult.data

    try {
      const allowCreds: PublicKeyCredentialDescriptor[] | undefined =
        publicKey.allowCredentials?.map((c: { type: string; id: string; transports: string[] }) => ({
          type: 'public-key' as const,
          id: Uint8Array.from(
            atob(c.id.replace(/-/g, '+').replace(/_/g, '/')),
            (cc: string) => cc.charCodeAt(0),
          ).buffer as ArrayBuffer,
          transports: c.transports as AuthenticatorTransport[],
        }))
      const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
        challenge: Uint8Array.from(
          atob(publicKey.challenge.replace(/-/g, '+').replace(/_/g, '/')),
          (c: string) => c.charCodeAt(0),
        ).buffer as ArrayBuffer,
        rpId: publicKey.rpId,
        userVerification: publicKey.userVerification as UserVerificationRequirement,
        allowCredentials: allowCreds,
      }
      const credential = await navigator.credentials.get({ publicKey: publicKeyCredentialRequestOptions })

      if (!credential) {
        return { user: null, errorCode: 'PASSKEY_CANCELLED' }
      }

      const pkCred = credential as PublicKeyCredential
      const response = pkCred.response as AuthenticatorAssertionResponse

      const finishBody: Record<string, unknown> = {
        challengeId,
        credential: {
          id: arrayBufferToBase64url(pkCred.rawId),
          rawId: arrayBufferToBase64url(pkCred.rawId),
          type: pkCred.type,
          response: {
            clientDataJSON: arrayBufferToBase64url(response.clientDataJSON),
            authenticatorData: arrayBufferToBase64url(response.authenticatorData),
            signature: arrayBufferToBase64url(response.signature),
            userHandle: response.userHandle ? arrayBufferToBase64url(response.userHandle) : null,
          },
          clientExtensionResults: pkCred.getClientExtensionResults(),
        },
      }
      if (mfaChallengeToken) finishBody.mfaChallengeToken = mfaChallengeToken

      const finishResult = await post<{
        accessToken?: string
        user?: Record<string, unknown>
        mfaRequired?: boolean
        mfaChallengeToken?: string
        availableMethods?: string[]
      }>('/auth/passkey/login/finish', finishBody)

      if (!finishResult.ok) {
        return { user: null, errorCode: finishResult.error.code }
      }

      if (finishResult.data.mfaRequired) {
        return {
          user: null,
          mfaChallengeToken: finishResult.data.mfaChallengeToken || '',
          mfaAvailableMethods: finishResult.data.availableMethods || [],
        }
      }

      if (!finishResult.data.accessToken) {
        return { user: null }
      }

      setClientToken(finishResult.data.accessToken)
      setAccessToken(finishResult.data.accessToken)
      setLoginProvider(null)

      const meResult = await get<Record<string, unknown>>('/me')
      if (meResult.ok) {
        const u = normalizeUser(meResult.data)
        setUser(u)
        return { user: u }
      }

      if (finishResult.data.user) {
        const u = normalizeUser(finishResult.data.user)
        setUser(u)
        return { user: u }
      }

      return { user: null }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        return { user: null, errorCode: 'PASSKEY_CANCELLED' }
      }
      return { user: null, errorCode: 'PASSKEY_VERIFICATION_FAILED' }
    }
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
    <AuthContext.Provider value={{ user, loading, accessToken, loginProvider, isAdmin, isFullAdmin, permissions, updateAccessToken, loginWithPassword, loginWithGitHub, loginWithX, loginWithPasskey, logout, logoutAll, exchangeLoginCode, completeRegistration, mfaVerify, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export { AuthContext, type AuthContextValue, type User }
