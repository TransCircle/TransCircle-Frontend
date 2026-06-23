import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get, post, patch, del, clearAuth, setAccessToken as setClientToken } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { useAuth } from '@/context/useAuth'
import { StepUpDialog } from '@/components/StepUpDialog'
import { arrayBufferToBase64url, base64urlToArrayBuffer } from '@/utils/string'
import styles from './Admin.module.css'

// ─── Types ───────────────────────────────────────────────────

interface OAuthAccount {
  provider: 'github' | 'x'
  providerUsername: string | null
  providerDisplayName: string | null
  providerAvatarUrl: string | null
  boundAt: number
}

interface PasskeyEntry {
  id: string
  name: string
  credentialId: string
  transports: string[]
  status: 'active' | 'frozen'
  frozenReason: string | null
  signCountSupported: boolean
  createdAt: number
  lastUsedAt: number | null
}

interface UserSecurity {
  hasPassword: boolean
  totpEnabled: boolean
  passkeyCount: number
  oauthProviders: string[]
}

interface UserProfile {
  id: string
  username: string
  email: string | null
  displayName: string
  avatarUrl: string | null
  emailVerified: boolean
  status: string
  roles: string[]
  security: UserSecurity
  createdAt: number
  lastLoginAt: number | null
}

interface SessionEntry {
  id: string
  current: boolean
  device: {
    browser: string | null
    os: string | null
    type: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown'
  }
  ipPrefix: string
  createdAt: number
  lastUsedAt: number
  expiresAt: number
}

type TabId = 'profile' | 'password' | 'totp' | 'passkey' | 'oauth' | 'sessions'

// ─── Helpers ──────────────────────────────────────────────────

function formatTs(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

// ─── Component ────────────────────────────────────────────────

export const SettingsSecurity = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user: authUser, accessToken, logoutAll, loading: authLoading, updateAccessToken } = useAuth()
  // IAM 账号的凭据/账户由统一身份管理，本页所有安全操作（密码/Passkey/TOTP/OAuth 绑定/注销删除）一律禁用
  const isIam = !!authUser?.iamLinked

  const [profile, setProfile] = useState<UserProfile | null>(null)
  // 从 URL ?tab= 读取初始标签（如 OAuth 绑定成功后跳转，#13b）
  const initialTab = (searchParams.get('tab') as TabId) || 'profile'
  const [activeTab, setActiveTab] = useState<TabId>(initialTab)

  // ── Password state ──
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [passwordSubmitting, setPasswordSubmitting] = useState(false)
  const [passwordSuccess, setPasswordSuccess] = useState(false)

  // ── TOTP state ──
  const [totpSetupData, setTotpSetupData] = useState<{
    setupId: string, secret: string, qrCodeImage: string | null
  } | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [totpError, setTotpError] = useState('')
  const [totpSubmitting, setTotpSubmitting] = useState(false)
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [showRecoveryCodes, setShowRecoveryCodes] = useState(false)

  // Disable TOTP
  const [disableTotpPassword, setDisableTotpPassword] = useState('')
  const [disableTotpCode, setDisableTotpCode] = useState('')
  const [disableTotpSubmitting, setDisableTotpSubmitting] = useState(false)

  // Regenerate recovery codes
  const [regenerateCode, setRegenerateCode] = useState('')
  const [regenerateSubmitting, setRegenerateSubmitting] = useState(false)

  // ── Passkey state ──
  const [passkeys, setPasskeys] = useState<PasskeyEntry[]>([])
  const [passkeyLoading, setPasskeyLoading] = useState(false)
  const [passkeyName, setPasskeyName] = useState('')
  const [passkeySubmitting, setPasskeySubmitting] = useState(false)
  const [passkeyError, setPasskeyError] = useState('')

  // ── OAuth state ──
  const [oauthAccounts, setOauthAccounts] = useState<OAuthAccount[]>([])
  const [oauthLoading, setOauthLoading] = useState(false)
  const [oauthError, setOauthError] = useState('')

  // ── Session state ──
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [sessionCursor, setSessionCursor] = useState<string | null>(null)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionRevoking, setSessionRevoking] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState('')

  // ── Step-up state ──
  const [showStepUp, setShowStepUp] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)

  // ── Profile edit state (api.md §2.2) ──
  const [profileDisplayName, setProfileDisplayName] = useState('')
  const [profileError, setProfileError] = useState('')
  const [profileSubmitting, setProfileSubmitting] = useState(false)
  const [profileSuccess, setProfileSuccess] = useState(false)

  // ── GDPR export state (api.md §2.3) ──
  const [exportStatus, setExportStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle')
  const [exportError, setExportError] = useState('')

  // ── Cancel deletion state (api.md §2.5) ──
  const location = useLocation()
  const [cancelToken, setCancelToken] = useState<string>(
    (location.state as Record<string, unknown> | null)?.cancelToken as string ?? ''
  )
  const [cancelIdentifier, setCancelIdentifier] = useState('')
  const [cancelPassword, setCancelPassword] = useState('')
  const [cancelMfaCode, setCancelMfaCode] = useState('')
  const [cancelStatus, setCancelStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [cancelError, setCancelError] = useState('')
  const [cancelPasskeyAssertion, setCancelPasskeyAssertion] = useState<Record<string, unknown> | null>(null)
  const [cancelPasskeyProcessing, setCancelPasskeyProcessing] = useState(false)

  // ── Delete account password input (替换原生 prompt()) ──
  const [deletePassword, setDeletePassword] = useState('')
  const [deletePasswordNeeded, setDeletePasswordNeeded] = useState(false)
  const [deletePasswordError, setDeletePasswordError] = useState('')
  const [deletePasswordSubmitting, setDeletePasswordSubmitting] = useState(false)
  /** Delete-account API 错误（用于无密码用户的步骤升级流程）*/
  const [deleteAccountError, setDeleteAccountError] = useState('')

  // ── Load profile on mount ──
  useEffect(() => {
    if (authLoading || !authUser) return
    let cancelled = false
    const load = async () => {
      const result = await get<Record<string, unknown>>('/me')
      if (cancelled) return
      if (result.ok) {
        const d = result.data
        setProfile({
          id: d.id as string,
          username: d.username as string,
          email: (d.email as string) ?? null,
          displayName: d.displayName as string,
          avatarUrl: (d.avatarUrl as string) ?? null,
          emailVerified: !!(d.emailVerified),
          status: d.status as string,
          roles: Array.isArray(d.roles) ? d.roles as string[] : [],
          security: d.security as UserSecurity,
          createdAt: d.createdAt as number,
          lastLoginAt: (d.lastLoginAt as number) ?? null,
        })
        setProfileDisplayName((d.displayName as string) ?? '')
      }
    }
    load()
    return () => { cancelled = true }
  }, [authLoading, authUser])

  // IAM 账号只允许停留在 profile 标签（其余安全标签隐藏）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isIam && activeTab !== 'profile') setActiveTab('profile')
  }, [isIam, activeTab])

  // ── Load OAuth accounts ──
  useEffect(() => {
    if (activeTab !== 'oauth') return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOauthLoading(true)
    let cancelled = false
    get<OAuthAccount[]>('/me/oauth').then(result => {
      if (cancelled) return
      if (result.ok) setOauthAccounts(result.data)
      else setOauthError(result.error.message)
      setOauthLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab])

  // ── Load passkeys ──
  useEffect(() => {
    if (activeTab !== 'passkey') return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPasskeyLoading(true)
    let cancelled = false
    get<PasskeyEntry[]>('/me/passkeys').then(result => {
      if (cancelled) return
      if (result.ok) setPasskeys(result.data)
      setPasskeyLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab])

  // ── Load sessions ──
  useEffect(() => {
    if (activeTab !== 'sessions') return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessionLoading(true)
    setSessionError('')
    let cancelled = false
    get<SessionEntry[]>('/me/sessions?limit=20').then(result => {
      if (cancelled) return
      if (result.ok) {
        setSessions(result.data)
        setSessionCursor(result.pagination?.nextCursor || null)
      }
      else setSessionError(result.error.message)
      setSessionLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab])

  const loadMoreSessions = async () => {
    if (!sessionCursor) return
     
    setSessionLoading(true)
    const result = await get<SessionEntry[]>(`/me/sessions?limit=20&cursor=${encodeURIComponent(sessionCursor)}`)
    if (result.ok) {
      setSessions(prev => [...prev, ...result.data])
      setSessionCursor(result.pagination?.nextCursor || null)
    } else {
      setSessionError(result.error.message)
    }
    setSessionLoading(false)
  }

  // When step-up completes, proceed with unbinding
  const handleUnbindAfterStepUp = useCallback(async (provider: 'github' | 'x'): Promise<void> => {
    setOauthError('')
    const result = await del<{ provider: string; unbound: boolean; revokedSessions: number }>(
      `/me/oauth/${provider}`,
    )
    if (result.ok) {
      const r = await get<OAuthAccount[]>('/me/oauth')
      if (r.ok) setOauthAccounts(r.data)
    } else {
      setOauthError(result.error.message)
    }
  }, [])

  // ── Step-up callback ──
  const handleStepUpSuccess = useCallback(() => {
    setShowStepUp(false)
    const action = pendingAction
    setPendingAction(null)

    if (action === 'delete-account') {
      const body: Record<string, unknown> = { confirmation: 'DELETE-MY-ACCOUNT' }
      if (profile?.security.hasPassword) {
        setDeletePassword('')
        setDeletePasswordNeeded(true)
        setDeletePasswordError('')
        return // render 中的内联密码输入框将接管
      }
      post('/me/delete', body).then(r => {
        if (r.ok) {
          clearAuth()
          navigate('/?toast=deletion_scheduled', { replace: true })
        } else {
          setDeleteAccountError(r.error?.message || t('settings.serverError'))
        }
      })
    } else if (action?.startsWith('unbind-')) {
      const provider = action.replace('unbind-', '') as 'github' | 'x'
      handleUnbindAfterStepUp(provider)
    }
  }, [pendingAction, navigate, handleUnbindAfterStepUp, profile, t])

  // Clean up TOTP sensitive data when leaving the TOTP tab (L4)
  const prevTab = useRef<TabId>(activeTab)
  useEffect(() => {
    if (prevTab.current === 'totp' && activeTab !== 'totp') {
      setTotpSetupData(null)
      setRecoveryCodes(null)
      setShowRecoveryCodes(false)
    }
    prevTab.current = activeTab
  }, [activeTab])

  // ── 0. Profile Edit (api.md §2.2) ──
  const handleProfileUpdate = async () => {
    setProfileError('')
    setProfileSuccess(false)

    const dn = profileDisplayName.trim()
    if (!dn || dn.length > 50) {
      setProfileError(t('settings.displayNameError'))
      return
    }

    setProfileSubmitting(true)
    const result = await patch<Record<string, unknown>>('/me', { displayName: dn })
    setProfileSubmitting(false)

    if (result.ok) {
      setProfileSuccess(true)
      setProfile(prev => prev ? { ...prev, displayName: dn } : prev)
    } else {
      setProfileError(result.error.message)
    }
  }

  // ── GDPR Export (api.md §2.3) ──
  const handleExport = async () => {
    setExportError('')
    setExportStatus('submitting')
    const result = await post('/me/export')
    if (result.ok) {
      setExportStatus('done')
    } else {
      setExportStatus('error')
      setExportError(result.error.message)
    }
  }

  // ── Passkey assertion for cancel deletion (api.md §2.5 OAuth-only) ──
  const handleCancelPasskey = async () => {
    // 取消删除的 Passkey 挑战由专用端点 /me/delete/cancel/passkey/start 签发，且绑定 cancelToken
    if (!cancelToken.trim()) {
      setCancelError(t('settings.cancelRequired'))
      return
    }
    setCancelPasskeyProcessing(true)
    setCancelError('')
    try {
      const startResult = await post<{
        challengeId: string
        challenge: {
          challenge: string
          rpId?: string
          userVerification?: string
          allowCredentials?: Array<{ id: string; type?: string; transports?: string[] }>
        }
      }>('/me/delete/cancel/passkey/start', { cancelToken: cancelToken.trim() })

      if (!startResult.ok) {
        setCancelError(t('settings.cancelPasskeyError'))
        setCancelPasskeyProcessing(false)
        return
      }

      const { challengeId, challenge } = startResult.data

      const allowCreds = challenge.allowCredentials?.map(c => ({
        type: 'public-key' as PublicKeyCredentialType,
        id: base64urlToArrayBuffer(c.id),
        transports: (c.transports ?? []) as AuthenticatorTransport[],
      }))

      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: base64urlToArrayBuffer(challenge.challenge),
          rpId: challenge.rpId,
          userVerification: (challenge.userVerification as UserVerificationRequirement) ?? 'required',
          allowCredentials: allowCreds,
        },
      })

      if (!credential) {
        setCancelPasskeyProcessing(false)
        return
      }

      const pkCred = credential as PublicKeyCredential
      const response = pkCred.response as AuthenticatorAssertionResponse

      // 后端 /me/delete/cancel 读取顶层 challengeId + 扁平的 passkeyAssertion（直接作为 WebAuthn 断言）
      setCancelPasskeyAssertion({
        challengeId,
        assertion: {
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
      })
    } catch {
      setCancelError(t('settings.cancelPasskeyError'))
    } finally {
      setCancelPasskeyProcessing(false)
    }
  }

  // ── Delete account — confirm with password (replaces native prompt()) ──
  const handleDeleteWithPassword = useCallback(async () => {
    if (!deletePassword || deletePasswordSubmitting) return
    setDeletePasswordSubmitting(true)
    setDeletePasswordError('')
    const body: Record<string, unknown> = { confirmation: 'DELETE-MY-ACCOUNT', password: deletePassword }
    try {
      const r = await post('/me/delete', body)
      if (r.ok) {
        clearAuth()
        navigate('/?toast=deletion_scheduled', { replace: true })
      } else {
        setDeletePasswordError(r.error?.message || t('settings.serverError'))
        setDeletePasswordSubmitting(false)
      }
    } catch {
      setDeletePasswordError(t('settings.serverError'))
      setDeletePasswordSubmitting(false)
    }
  }, [deletePassword, deletePasswordSubmitting, t, navigate])
  const handleCancelDeletion = async () => {
    setCancelError('')
    if (!cancelToken.trim() || !cancelIdentifier.trim()) {
      setCancelError(t('settings.cancelRequired'))
      return
    }
    setCancelStatus('submitting')
    const body: Record<string, unknown> = {
      cancelToken: cancelToken.trim(),
      identifier: cancelIdentifier.trim(),
      mfaCode: cancelMfaCode || undefined,
    }
    // api.md §2.5: OAuth-only 账户省略 password，密码账户传实际值
    if (profile?.security.hasPassword !== false) {
      if (!cancelPassword) {
        setCancelStatus('error')
        setCancelError(t('settings.passwordRequired'))
        return
      }
      body.password = cancelPassword
    }
    if (cancelPasskeyAssertion) {
      // challengeId 必须在 body 顶层，passkeyAssertion 为扁平 WebAuthn 断言（api.md §2.5）
      body.challengeId = cancelPasskeyAssertion.challengeId
      body.passkeyAssertion = cancelPasskeyAssertion.assertion
    }
    const result = await post('/me/delete/cancel', body, { idempotent: true })
    if (result.ok) {
      setCancelStatus('success')
    } else {
      setCancelStatus('error')
      setCancelError(result.error.message)
    }
  }

  // ── 1. Change Password ──
  const handlePasswordChange = async () => {
    setPasswordError('')
    setPasswordSuccess(false)

    if (newPassword !== confirmPassword) {
      setPasswordError(t('settings.passwordMismatch'))
      return
    }

    setPasswordSubmitting(true)
    const result = await post<{
      passwordChanged?: boolean
      revokedSessions?: number
      accessToken?: string
    }>('/me/password', {
      currentPassword: currentPassword || undefined,
      newPassword,
    })
    setPasswordSubmitting(false)

    if (result.ok) {
      if (result.data.accessToken) {
        setClientToken(result.data.accessToken)
        updateAccessToken(result.data.accessToken)
      }
      setPasswordSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
    } else {
      if (result.error.code === ERRORS.VALIDATION_ERROR) {
        setPasswordError(result.error.message)
      } else if (result.error.code === ERRORS.INVALID_CREDENTIALS) {
        setPasswordError(t('settings.currentPasswordWrong'))
      } else {
        setPasswordError(result.error.message || t('settings.serverError'))
      }
    }
  }

  // ── 2. TOTP Setup ──
  const handleTotpSetup = async () => {
    setTotpError('')
    setTotpSetupData(null)

    setTotpSubmitting(true)
    const result = await post<{
      setupId: string
      secret: string
      otpauthUrl: string
      qrCodeImage: string | null
      expiresIn: number
    }>('/me/mfa/totp/setup')
    setTotpSubmitting(false)

    if (result.ok) {
      setTotpSetupData({
        setupId: result.data.setupId,
        secret: result.data.secret,
        qrCodeImage: result.data.qrCodeImage,
      })
    } else {
      setTotpError(result.error.message)
    }
  }

  const handleTotpEnable = async () => {
    if (!totpSetupData || !totpCode) return
    setTotpError('')
    setTotpSubmitting(true)

    const result = await post<{ totpEnabled: boolean; recoveryCodes: string[] }>(
      '/me/mfa/totp/enable',
      { setupId: totpSetupData.setupId, code: totpCode },
    )
    setTotpSubmitting(false)

    if (result.ok) {
      setRecoveryCodes(result.data.recoveryCodes)
      setShowRecoveryCodes(true)
      setTotpSetupData(null)
      setTotpCode('')
      // Refresh profile
      const p = await get<Record<string, unknown>>('/me')
      if (p.ok) setProfile(prev => prev ? { ...prev, security: p.data.security as UserSecurity } : prev)
    } else {
      setTotpError(result.error.message)
    }
  }

  const handleTotpDisable = async () => {
    setTotpError('')
    setDisableTotpSubmitting(true)

    const dResult = await del<Record<string, unknown>>('/me/mfa/totp', {
      password: disableTotpPassword || undefined,
      code: disableTotpCode,
    })
    setDisableTotpSubmitting(false)

    if (dResult.ok) {
      setDisableTotpCode('')
      setDisableTotpPassword('')
      const p = await get<Record<string, unknown>>('/me')
      if (p.ok) setProfile(prev => prev ? { ...prev, security: p.data.security as UserSecurity } : prev)
    } else {
      setTotpError(dResult.error.message || t('settings.totpDisableError'))
    }
  }

  const handleRegenerateRecoveryCodes = async () => {
    setTotpError('')
    setRegenerateSubmitting(true)

    const result = await post<{ recoveryCodes: string[] }>(
      '/me/mfa/recovery-codes/regenerate',
      { code: regenerateCode },
    )
    setRegenerateSubmitting(false)

    if (result.ok) {
      setRecoveryCodes(result.data.recoveryCodes)
      setShowRecoveryCodes(true)
      setRegenerateCode('')
    } else {
      setTotpError(result.error.message)
    }
  }

  // ── 3. Passkey Register ──
  const handlePasskeyRegister = async () => {
    if (!passkeyName.trim()) return
    setPasskeyError('')
    setPasskeySubmitting(true)

    try {
      // Step 1: start registration
      const startResult = await post<{
        registrationId: string
        publicKey: PublicKeyCredentialCreationOptions
      }>('/me/passkeys/register/start')

      if (!startResult.ok) {
        setPasskeyError(startResult.error.message)
        setPasskeySubmitting(false)
        return
      }

      // Step 2: call browser WebAuthn API
      const { registrationId, publicKey: creationOptions } = startResult.data

      const rawChallenge = creationOptions.challenge as unknown as string
      const rawUser = creationOptions.user as unknown as { id: string; displayName: string; name: string }
      const rawExclude = creationOptions.excludeCredentials as unknown as Array<{ id: string; type: string; transports?: AuthenticatorTransport[] }> | undefined

      const publicKey: PublicKeyCredentialCreationOptions = {
        ...creationOptions,
        challenge: base64urlToArrayBuffer(rawChallenge),
        rp: creationOptions.rp as PublicKeyCredentialRpEntity,
        user: {
          id: new Uint8Array(base64urlToArrayBuffer(rawUser.id)),
          displayName: rawUser.displayName,
          name: rawUser.name,
        },
        pubKeyCredParams: creationOptions.pubKeyCredParams as PublicKeyCredentialParameters[],
        excludeCredentials: rawExclude?.map(c => ({
          type: c.type as PublicKeyCredentialType,
          id: base64urlToArrayBuffer(c.id),
          transports: c.transports,
        })),
      }

      const cred = await navigator.credentials.create({ publicKey })

      if (!cred) {
        setPasskeyError(t('settings.passkeyCancel'))
        setPasskeySubmitting(false)
        return
      }

      const pkCred = cred as PublicKeyCredential
      const response = pkCred.response as AuthenticatorAttestationResponse

      // Step 3: finish registration
      const finishResult = await post('/me/passkeys/register/finish', {
        registrationId,
        name: passkeyName.trim(),
        credential: {
          id: arrayBufferToBase64url(pkCred.rawId),
          rawId: arrayBufferToBase64url(pkCred.rawId),
          type: pkCred.type,
          response: {
            clientDataJSON: arrayBufferToBase64url(pkCred.response.clientDataJSON),
            attestationObject: arrayBufferToBase64url(response.attestationObject),
            transports: response.getTransports?.() || [],
          },
          clientExtensionResults: pkCred.getClientExtensionResults(),
        },
      })

      setPasskeySubmitting(false)

      if (finishResult.ok) {
        setPasskeyName('')
        get<PasskeyEntry[]>('/me/passkeys').then(r => { if (r.ok) setPasskeys(r.data) })
      } else {
        setPasskeyError(finishResult.error.message)
      }
    } catch (err) {
      setPasskeySubmitting(false)
      setPasskeyError(err instanceof Error ? err.message : t('settings.passkeyRegisterError'))
    }
  }

  const handlePasskeyDelete = async (id: string) => {
    const result = await del(`/me/passkeys/${id}`)
    if (result.ok) {
      get<PasskeyEntry[]>('/me/passkeys').then(r => { if (r.ok) setPasskeys(r.data) })
    } else {
      setPasskeyError(result.error.message)
    }
  }

  // ── 4. OAuth Bind/Unbind ──
  const handleOAuthBind = async (provider: 'github' | 'x') => {
    const result = await get<{ authorizationUrl: string }>(`/me/oauth/${provider}/bind/start`)
    if (result.ok && result.data.authorizationUrl) {
      window.location.href = result.data.authorizationUrl
    } else if (!result.ok) {
      setOauthError(result.error.message)
    } else {
      setOauthError(t('settings.oauthFetchLinkError'))
    }
  }

  const handleOAuthUnbind = async (provider: 'github' | 'x') => {
    setOauthError('')

    if (!accessToken) {
      setOauthError(t('settings.stepUpRequired'))
      return
    }

    setShowStepUp(true)
    setPendingAction(`unbind-${provider}`)
  }

  // ── Helper: ArrayBuffer → base64url (from shared utils/string.ts)

  // Not loading and not logged in — redirect to login
  useEffect(() => {
    if (!authUser && !authLoading) {
      navigate('/login', { replace: true })
    }
  }, [authUser, authLoading, navigate])

  if (!authUser) {
    if (authLoading) {
      return (
        <main className={styles.container}>
          <div className={styles.loading}>{t('admin.verifying')}</div>
        </main>
      )
    }
    return null
  }

  // IAM 账号仅保留「资料」标签（含改名/数据导出），隐藏全部安全设置标签
  const tabs = isIam
    ? [{ key: 'profile' as TabId, label: t('settings.tabProfile') }]
    : [
        { key: 'profile' as TabId, label: t('settings.tabProfile') },
        { key: 'password' as TabId, label: t('settings.tabPassword') },
        { key: 'totp' as TabId, label: t('settings.tabTotp') },
        { key: 'passkey' as TabId, label: t('settings.tabPasskey') },
        { key: 'oauth' as TabId, label: t('settings.tabOauth') },
        { key: 'sessions' as TabId, label: t('settings.tabSessions') },
      ]

  return (
    <main className={styles.container}>
      <header>
        <h1 className={styles.heading}>{t('settings.pageTitle')}</h1>
        <p className={styles.headingDesc}>{t('settings.pageDescription')}</p>
      </header>

      {isIam && (
        <div className={styles.detailCard} style={{ borderColor: 'var(--accent-pink)', marginBottom: '1rem' }}>
          <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            {t('settings.iamManagedNotice')}
          </p>
        </div>
      )}

      <nav className={styles.tabs} role="tablist">
        {tabs.map(tab => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeTab === tab.key}
            className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* ══════════════════════════════════════════
          TAB 0: PROFILE (api.md §2.2)
          ══════════════════════════════════════════ */}
      {activeTab === 'profile' && (
        <div className={styles.detailCard} role="tabpanel" aria-labelledby="tab-profile">
          <h2 className={styles.detailTitle}>{t('settings.profileHeading')}</h2>

          {profile && (
            <div style={{ marginBottom: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              <p>{t('settings.username')}：{profile.username}</p>
              <p>{t('settings.email')}：{profile.email ?? '-'}</p>
              <p>{t('settings.emailVerified')}：{profile.emailVerified ? t('settings.yes') : t('settings.no')}</p>
            </div>
          )}

          <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.75rem' }}>
            {t('settings.displayNameLabel')}
            <input
              type="text"
              value={profileDisplayName}
              onChange={e => setProfileDisplayName(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
              className={styles.input}
              maxLength={50}
              required
              aria-describedby={profileError ? 'profile-error' : undefined}
            />
          </label>

          {profileSuccess && (
            <p style={{ color: 'var(--success-color)', fontSize: '0.9rem', marginBottom: '0.75rem' }}>{t('settings.profileUpdated')}</p>
          )}
          {profileError && (
            <p id="profile-error" style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{profileError}</p>
          )}

          <button
            className={styles.btnPrimary}
            onClick={handleProfileUpdate}
            disabled={profileSubmitting || !profileDisplayName.trim()}
          >
            {profileSubmitting ? t('settings.saving') : t('settings.saveProfile')}
          </button>

          {/* GDPR 数据导出（api.md §2.3）*/}
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--divider-color)', paddingTop: '1.5rem' }}>
            <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>{t('settings.exportHeading')}</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
              {t('settings.exportDescription')}
            </p>

            {exportStatus === 'done' && (
              <p style={{ color: 'var(--success-color)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>{t('settings.exportDone')}</p>
            )}
            {exportError && (
              <p style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{exportError}</p>
            )}

            <button
              className={styles.btnSecondary}
              onClick={handleExport}
              disabled={exportStatus === 'submitting'}
            >
              {exportStatus === 'submitting' ? t('settings.requesting') : t('settings.requestExport')}
            </button>
          </div>

          {/* 撤销账户注销（api.md §2.5）—— IAM 账号不可用（账户生命周期由 IAM 管理）*/}
          {!isIam && (
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--divider-color)', paddingTop: '1.5rem' }}>
            <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>{t('settings.cancelDeletionHeading')}</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
              {t('settings.cancelDeletionDescription')}
            </p>

            {cancelStatus === 'success' ? (
              <p style={{ color: 'var(--success-color)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>{t('settings.cancelSuccess')}</p>
            ) : (
              <>
                <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.5rem' }}>
                  {t('settings.cancelToken')}
                  <input type="text" value={cancelToken} onChange={e => setCancelToken(e.target.value)}
                    className={styles.input} style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
                    placeholder={t('settings.cancelTokenPlaceholder')} />
                </label>
                <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.5rem' }}>
                  {t('settings.cancelIdentifier')}
                  <input type="text" value={cancelIdentifier} onChange={e => setCancelIdentifier(e.target.value)}
                    className={styles.input} style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
                    placeholder={t('settings.cancelIdentifierPlaceholder')} />
                </label>
                <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.5rem' }}>
                  {t('settings.cancelPassword')}
                  <input type="password" value={cancelPassword} onChange={e => setCancelPassword(e.target.value)}
                    className={styles.input} style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
                    placeholder={t('settings.cancelPasswordPlaceholder')} />
                </label>
                <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.75rem' }}>
                  {t('settings.cancelMfa')}
                  <input type="text" inputMode="text" value={cancelMfaCode}
                    onChange={e => {
                      const raw = e.target.value.toUpperCase()
                      if (/[A-Z-]/.test(raw)) {
                        setCancelMfaCode(raw.replace(/[^A-Z0-9-]/g, '').slice(0, 14))
                      } else {
                        setCancelMfaCode(raw.replace(/\D/g, '').slice(0, 6))
                      }
                    }}
                    className={styles.input} style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
                    placeholder={t('settings.cancelMfaPlaceholder')} />
                </label>

                {/* OAuth-only 账户：使用 Passkey 代替密码（api.md §2.5）*/}
                {profile?.security.hasPassword === false && (
                  <div style={{ marginBottom: '0.75rem' }}>
                    {cancelPasskeyAssertion ? (
                      <p style={{ fontSize: '0.85rem', color: 'var(--success-color)' }}>{t('settings.cancelPasskeyReady')}</p>
                    ) : (
                      <button
                        type="button"
                        className={styles.btnSecondary}
                        onClick={handleCancelPasskey}
                        disabled={cancelPasskeyProcessing || !cancelIdentifier.trim()}
                        style={{ color: 'var(--accent-pink)', borderColor: 'var(--accent-pink)' }}
                      >
                        {cancelPasskeyProcessing ? t('settings.cancelPasskeyProcessing') : t('settings.cancelPasskeyButton')}
                      </button>
                    )}
                  </div>
                )}

                {cancelError && (
                  <p style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{cancelError}</p>
                )}

                <button
                  className={styles.btnSecondary}
                  onClick={handleCancelDeletion}
                  disabled={cancelStatus === 'submitting' || !cancelToken.trim() || !cancelIdentifier.trim() || (!cancelPassword && !cancelPasskeyAssertion && profile?.security.hasPassword === false)}
                  style={{ color: 'var(--success-color)', borderColor: 'var(--accent-pink)' }}
                >
                  {cancelStatus === 'submitting' ? t('settings.submitting') : t('settings.cancelDeletionButton')}
                </button>
              </>
            )}
          </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════
          TAB 1: PASSWORD
          ══════════════════════════════════════════ */}
      {activeTab === 'password' && (
        <div className={styles.detailCard} role="tabpanel" aria-labelledby="tab-password">
          <h2 className={styles.detailTitle}>{t('settings.passwordHeading')}</h2>

          {profile?.security.hasPassword === false && (
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              {t('settings.passwordNotSet')}
            </p>
          )}

          {passwordSuccess && (
            <p style={{ color: 'var(--success-color)', fontSize: '0.9rem', marginBottom: '1rem' }}>
              {t('settings.passwordChanged')}
            </p>
          )}

          {profile?.security.hasPassword && (
            <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.5rem' }}>
              {t('settings.currentPassword')}
              <input
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
                className={styles.input}
                aria-describedby={passwordError ? 'password-error' : undefined}
              />
            </label>
          )}

          <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.5rem' }}>
            {t('settings.newPassword')}
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
              className={styles.input}
              minLength={12}
              maxLength={128}
            />
          </label>

          <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.75rem' }}>
            {t('settings.confirmPassword')}
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
              className={styles.input}
            />
          </label>

          {passwordError && (
            <p id="password-error" style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{passwordError}</p>
          )}

          <button
            className={styles.btnPrimary}
            onClick={handlePasswordChange}
            disabled={passwordSubmitting || !newPassword}
          >
            {passwordSubmitting ? t('settings.changing') : t('settings.changePassword')}
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════
          TAB 2: TOTP
          ══════════════════════════════════════════ */}
      {activeTab === 'totp' && (
        <div className={styles.detailCard} role="tabpanel" aria-labelledby="tab-totp">
          <h2 className={styles.detailTitle}>{t('settings.totpHeading')}</h2>

          {profile?.security.totpEnabled ? (
            <>
              <p style={{ fontSize: '0.9rem', color: 'var(--success-color)', marginBottom: '1rem' }}>
                {t('settings.totpEnabled')}
              </p>

              {/* Disable TOTP */}
              <h3 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>{t('settings.totpDisableTitle')}</h3>
              {profile?.security.hasPassword && (
                <input
                  type="password"
                  placeholder={t('settings.totpDisablePlaceholder')}
                  value={disableTotpPassword}
                  onChange={e => setDisableTotpPassword(e.target.value)}
                  className={styles.input}
                  style={{ display: 'block', width: '100%', marginBottom: '0.5rem' }}
                />
              )}
              <input
                type="text"
                inputMode="numeric"
                placeholder={t('settings.totpCodePlaceholder')}
                value={disableTotpCode}
                onChange={e => setDisableTotpCode(e.target.value)}
                className={styles.input}
                style={{ display: 'block', width: '100%', marginBottom: '0.75rem' }}
              />
              <button
                className={styles.btnPrimary}
                onClick={handleTotpDisable}
                disabled={disableTotpSubmitting || !disableTotpCode}
              >
                {disableTotpSubmitting ? t('settings.totpDisabling') : t('settings.totpDisableButton')}
              </button>

              {/* Regenerate recovery codes */}
              <div style={{ marginTop: '2rem', borderTop: '1px solid var(--divider-color)', paddingTop: '1rem' }}>
                <h3 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>{t('settings.recoveryRegenerateHeading')}</h3>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder={t('settings.recoveryRegeneratePlaceholder')}
                  value={regenerateCode}
                  onChange={e => setRegenerateCode(e.target.value)}
                  className={styles.input}
                  style={{ display: 'block', width: '100%', marginBottom: '0.75rem' }}
                />
                <button
                  className={styles.btnSecondary}
                  onClick={handleRegenerateRecoveryCodes}
                  disabled={regenerateSubmitting || !regenerateCode}
                >
                  {regenerateSubmitting ? t('settings.recoveryRegenerating') : t('settings.recoveryRegenerateButton')}
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                {t('settings.totpSetupDescription')}
              </p>

              {!totpSetupData ? (
                <button
                  className={styles.btnPrimary}
                  onClick={handleTotpSetup}
                  disabled={totpSubmitting}
                >
                  {totpSubmitting ? t('settings.totpPreparing') : t('settings.totpSetupButton')}
                </button>
              ) : (
                <div>
                  <p style={{ fontSize: '0.9rem', color: 'var(--text-main)', marginBottom: '0.5rem' }}>
                    {t('settings.totpScanHint')}
                  </p>

                  {totpSetupData.qrCodeImage && (
                    <div style={{ textAlign: 'center', margin: '1rem 0' }}>
                      <img
                        src={totpSetupData.qrCodeImage}
                        alt="TOTP QR Code"
                        style={{ width: '200px', height: '200px', borderRadius: '8px' }}
                      />
                    </div>
                  )}

                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center', marginBottom: '1rem' }}>
                    {t('settings.secretLabel')}<code style={{ fontSize: '0.9rem', letterSpacing: '0.1em' }}>{totpSetupData.secret}</code>
                  </p>

                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder={t('settings.totpCodeInputPlaceholder')}
                    value={totpCode}
                    onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className={styles.input}
                    style={{ display: 'block', width: '200px', margin: '0 auto 0.75rem', textAlign: 'center', fontSize: '1.2rem', letterSpacing: '0.3em' }}
                    maxLength={6}
                    autoFocus
                    aria-describedby={totpError ? 'totp-error' : undefined}
                  />

                  {totpError && (
                    <p id="totp-error" style={{ color: 'var(--error-color)', fontSize: '0.85rem', textAlign: 'center', marginBottom: '0.5rem' }} role="alert">{totpError}</p>
                  )}

                  <div style={{ textAlign: 'center' }}>
                    <button
                      className={styles.btnPrimary}
                      onClick={handleTotpEnable}
                      disabled={totpSubmitting || totpCode.length < 6}
                    >
                      {totpSubmitting ? t('settings.totpVerifying') : t('settings.totpConfirmButton')}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Recovery codes modal */}
          {showRecoveryCodes && recoveryCodes && recoveryCodes.length > 0 && (
            <div style={{
              position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--overlay-bg)', zIndex: 1000,
            }}>
              <div role="dialog" aria-modal="true" aria-labelledby="recovery-codes-title" style={{
                background: 'var(--bg-color, #fff)', padding: '2rem', borderRadius: '10px',
                maxWidth: '500px', width: '90%',
              }}>
                <h3 id="recovery-codes-title" style={{ margin: '0 0 0.5rem' }}>{t('settings.recoveryCodesTitle')}</h3>
                <p style={{ fontSize: '0.85rem', color: 'var(--error-color)', marginBottom: '0.75rem' }}>
                  {t('settings.recoveryCodesHint')}
                </p>
                <div style={{
                  background: 'var(--hover-bg)', padding: '1rem', borderRadius: '8px',
                  fontFamily: 'monospace', fontSize: '0.9rem', lineHeight: 2,
                }}>
                  {recoveryCodes.map((code, i) => (
                    <div key={i}>{code}</div>
                  ))}
                </div>
                <button
                  className={styles.btnPrimary}
                  onClick={() => { setShowRecoveryCodes(false); setRecoveryCodes(null) }}
                  style={{ marginTop: '1rem' }}
                >
                  {t('settings.recoveryCodesSaved')}
                </button>
              </div>
            </div>
          )}

          {totpError && !totpSetupData && (
            <p style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{totpError}</p>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════
          TAB 3: PASSKEY
          ══════════════════════════════════════════ */}
      {activeTab === 'passkey' && (
        <div className={styles.detailCard} role="tabpanel" aria-labelledby="tab-passkey">
          <h2 className={styles.detailTitle}>{t('settings.passkeyHeading')}</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            {t('settings.passkeyDescription')}
          </p>

          {/* Register new */}
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', alignItems: 'center' }}>
            <input
              type="text"
              placeholder={t('settings.passkeyNamePlaceholder')}
              value={passkeyName}
              onChange={e => setPasskeyName(e.target.value)}
              className={styles.input}
              style={{ flex: 1 }}
              maxLength={50}
            />
            <button
              className={styles.btnPrimary}
              onClick={handlePasskeyRegister}
              disabled={passkeySubmitting || !passkeyName.trim()}
            >
              {passkeySubmitting ? t('settings.passkeyRegistering') : t('settings.passkeyRegisterButton')}
            </button>
          </div>

          {passkeyError && (
            <p style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{passkeyError}</p>
          )}

          {/* List */}
          {passkeyLoading ? (
            <div className={styles.loading}>{t('settings.loading')}</div>
          ) : passkeys.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('settings.passkeyEmpty')}</p>
          ) : (
            <ul className={styles.list}>
              {passkeys.map(pk => (
                <li key={pk.id} className={styles.item}>
                  <div className={styles.itemMain}>
                    <div className={styles.itemTitle}>{pk.name}</div>
                    <div className={styles.itemMeta}>
                      {pk.status === 'frozen' ? `❄️ ${t('settings.passkeyFrozen')} (${pk.frozenReason || t('settings.passkeyUnknownReason')}) · ` : ''}
                      {t('settings.passkeyRegisteredAt')} {formatTs(pk.createdAt)}
                      {pk.lastUsedAt ? ` · ${t('settings.passkeyLastUsed')} ${formatTs(pk.lastUsedAt)}` : ''}
                    </div>
                  </div>
                  {pk.status === 'active' && (
                    <button
                      className={styles.btnSecondary}
                      onClick={() => handlePasskeyDelete(pk.id)}
                      style={{ color: 'var(--error-color)', borderColor: 'var(--divider-color)' }}
                    >
                      {t('settings.passkeyDelete')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════
          TAB 4: OAUTH BINDING
          ══════════════════════════════════════════ */}
      {activeTab === 'oauth' && (
        <div className={styles.detailCard} role="tabpanel" aria-labelledby="tab-oauth">
          <h2 className={styles.detailTitle}>{t('settings.oauthHeading')}</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            {t('settings.oauthDescription')}
          </p>

          {oauthError && (
            <p style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{oauthError}</p>
          )}

          {oauthLoading ? (
            <div className={styles.loading}>{t('settings.loading')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* GitHub */}
              <div className={styles.detailCard} style={{ border: '1px solid var(--divider-color)', margin: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>GitHub</strong>
                    {(() => {
                      const gh = oauthAccounts.find(a => a.provider === 'github')
                      return gh
                        ? <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0.25rem 0 0' }}>
                            @{gh.providerUsername} · {t('settings.oauthBoundAt')} {formatTs(gh.boundAt)}
                          </p>
                        : <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.25rem 0 0' }}>{t('settings.oauthNotBound')}</p>
                    })()}
                  </div>
                  {oauthAccounts.find(a => a.provider === 'github')
                    ? <button className={styles.btnSecondary} onClick={() => handleOAuthUnbind('github')} style={{ color: 'var(--error-color)' }}>{t('settings.oauthUnbind')}</button>
                    : <button className={styles.btnPrimary} onClick={() => handleOAuthBind('github')}>{t('settings.oauthBind')}</button>
                  }
                </div>
              </div>

              {/* X */}
              <div className={styles.detailCard} style={{ border: '1px solid var(--divider-color)', margin: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>X (Twitter)</strong>
                    {(() => {
                      const x = oauthAccounts.find(a => a.provider === 'x')
                      return x
                        ? <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0.25rem 0 0' }}>
                            @{x.providerUsername} · {t('settings.oauthBoundAt')} {formatTs(x.boundAt)}
                          </p>
                        : <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.25rem 0 0' }}>{t('settings.oauthNotBound')}</p>
                    })()}
                  </div>
                  {oauthAccounts.find(a => a.provider === 'x')
                    ? <button className={styles.btnSecondary} onClick={() => handleOAuthUnbind('x')} style={{ color: 'var(--error-color)' }}>{t('settings.oauthUnbind')}</button>
                    : <button className={styles.btnPrimary} onClick={() => handleOAuthBind('x')}>{t('settings.oauthBind')}</button>
                  }
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'sessions' && (
        <div className={styles.detailCard} role="tabpanel" aria-labelledby="tab-sessions">
          <h2 className={styles.detailTitle}>{t('settings.sessionsHeading')}</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            {t('settings.sessionsDescription')}
          </p>
          <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button className={styles.btnSecondary} onClick={async () => {
              if (!window.confirm(t('settings.sessionsLogoutAllConfirm'))) return
              const result = await logoutAll()
              if (result) {
                navigate('/login', { replace: true })
              } else {
                setSessionError(t('settings.sessionsLogoutAllError'))
              }
            }} style={{ color: 'var(--error-color)', borderColor: 'var(--divider-color)' }}>
              {t('settings.sessionsLogoutAll')}
            </button>
          </div>
          {sessionError && (
            <p style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{sessionError}</p>
          )}
          {sessionLoading && sessions.length === 0 ? (
            <div className={styles.loading}>{t('settings.loading')}</div>
          ) : sessions.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('settings.sessionsEmpty')}</p>
          ) : (
            <ul className={styles.list}>
              {sessions.map(sess => (
                <li key={sess.id} className={styles.item}>
                  <div className={styles.itemMain}>
                    <div className={styles.itemTitle}>
                      {sess.current ? `🟢 ${t('settings.sessionsCurrent')}` : `○ ${sess.device.browser || '-'}`}
                    </div>
                    <div className={styles.itemMeta}>
                      {sess.device.os ? `${sess.device.os} · ` : ''}
                      {t('settings.sessionsIpPrefix')}: {sess.ipPrefix} · {t('settings.sessionsLoggedIn')}: {formatTs(sess.createdAt)}
                      {sess.lastUsedAt ? ` · ${t('settings.sessionsLastActive')}: ${formatTs(sess.lastUsedAt)}` : ''}
                    </div>
                  </div>
                  {!sess.current && (
                    <button
                      className={styles.btnSecondary}
                      onClick={async () => {
                        if (!window.confirm(t('settings.sessionsRevokeConfirm'))) return
                        setSessionRevoking(sess.id)
                        const result = await del(`/me/sessions/${sess.id}`)
                        if (result.ok) {
                          setSessions(prev => prev.filter(s => s.id !== sess.id))
                        } else {
                          setSessionError(result.error.message)
                        }
                        setSessionRevoking(null)
                      }}
                      disabled={sessionRevoking === sess.id}
                      style={{ color: 'var(--error-color)', borderColor: 'var(--divider-color)' }}
                    >
                      {sessionRevoking === sess.id ? t('settings.sessionsRevoking') : t('settings.sessionsRevoke')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {sessionCursor && (
            <button
              className={styles.btnSecondary}
              onClick={loadMoreSessions}
              disabled={sessionLoading}
              style={{ display: 'block', margin: '1rem auto' }}
            >
              {sessionLoading ? t('settings.loading') : t('settings.sessionsLoadMore')}
            </button>
          )}
        </div>
      )}

      {/* Delete account section — only on the profile tab (was rendering under every tab);
          hidden for IAM accounts (deletion is managed by IAM). */}
      {activeTab === 'profile' && !isIam && (
      <div className={styles.detailCard} style={{ marginTop: '1rem', borderColor: 'var(--divider-color)' }}>
        <h2 className={styles.detailTitle} style={{ color: 'var(--error-color)' }}>{t('settings.deleteAccount.heading')}</h2>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          {t('settings.deleteAccount.description')}
        </p>
        {cancelError && (
          <p style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{cancelError}</p>
        )}
        {deleteAccountError && (
          <p style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{deleteAccountError}</p>
        )}
        <button
          className={styles.btnSecondary}
          onClick={() => {
            if (!window.confirm(t('settings.deleteAccount.confirm'))) return
            setPendingAction('delete-account')
            setShowStepUp(true)
          }}
          style={{ color: 'var(--error-color)', borderColor: 'var(--divider-color)' }}
        >
          {t('settings.deleteAccount.button')}
        </button>
      </div>
      )}

      {/* Delete account password prompt (L10 — inline form replaces native prompt()) */}
      {deletePasswordNeeded && !deletePasswordSubmitting && (
        <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid var(--divider-color)', borderRadius: '8px', background: 'var(--hover-bg)' }}>
          <p style={{ margin: '0 0 0.5rem', color: 'var(--text-main)', fontWeight: 500 }}>
            {t('settings.deleteAccount.passwordPrompt')}
          </p>
          {deletePasswordError && <p style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{deletePasswordError}</p>}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="password"
              value={deletePassword}
              onChange={e => setDeletePassword(e.target.value)}
              placeholder={t('settings.passwordPlaceholder')}
              autoFocus
              style={{ flex: 1, padding: '0.4rem 0.6rem', border: '1.5px solid var(--divider-color)', borderRadius: '8px', fontSize: '0.85rem', fontFamily: 'inherit' }}
              onKeyDown={e => { if (e.key === 'Enter') handleDeleteWithPassword() }}
            />
            <button
              disabled={!deletePassword || deletePasswordSubmitting}
              style={{ padding: '0.4rem 0.75rem', cursor: deletePassword ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}
              onClick={handleDeleteWithPassword}
            >
              {deletePasswordSubmitting ? t('settings.submitting') : t('settings.confirm')}
            </button>
            <button
              onClick={() => { setDeletePasswordNeeded(false); setDeletePassword(''); setDeletePasswordError('') }}
              style={{ padding: '0.4rem 0.75rem', cursor: 'pointer', fontFamily: 'inherit', background: 'none', border: '1px solid var(--divider-color)', borderRadius: '8px' }}
            >
              {t('settings.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Step-up dialog */}
      {showStepUp && (
        <StepUpDialog
          onSuccess={handleStepUpSuccess}
          onCancel={() => { setShowStepUp(false); setPendingAction(null) }}
          accessToken={accessToken ?? ''}
        />
      )}
    </main>
  )
}

