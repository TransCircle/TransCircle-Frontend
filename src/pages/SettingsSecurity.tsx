import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get, post, patch, del, clearAuth, setAccessToken as setClientToken } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { useAuth } from '@/context/useAuth'
import { StepUpDialog } from '@/components/StepUpDialog'
import { arrayBufferToBase64url, base64urlToArrayBuffer } from '@/utils/string'
import {
  AdminButton,
  Alert,
  Card,
  ConfirmDialog,
  DescriptionList,
  Modal,
  PageHeader,
  Pill,
  Spinner,
  StatusBadge,
  Tabs,
  TextField,
  type TabItem,
} from '@/components/ui'
import { PERMISSION_LABEL_KEYS, ROLE_LABEL_KEYS } from '@/api/permissions'
import { useFormatTs } from '@/utils/datetime'
import shell from './Page.module.css'
import s from './SettingsSecurity.module.css'

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

type ConfirmKind =
  | { kind: 'logoutAll' }
  | { kind: 'revoke'; sessionId: string }
  | { kind: 'deleteAccount' }

// ─── Component ────────────────────────────────────────────────

export const SettingsSecurity = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user: authUser, accessToken, logoutAll, loading: authLoading, updateAccessToken } = useAuth()
  // IAM 账号的凭据/账户由统一身份管理，本页所有安全操作（密码/Passkey/TOTP/OAuth 绑定/注销删除）一律禁用
  const isIam = !!authUser?.iamLinked
  // 「我的权限」概览：角色 + 细粒度权限。严格展示后端 /me 返回的权限快照本身（authUser.permissions），
  // 不用 useAuth().permissions 的角色派生回退，避免在展示层臆造权限。仅对实际拥有角色/权限的账号展示。
  const roles = authUser?.roles ?? []
  const permissions = authUser?.permissions ?? []
  const hasWildcard = permissions.includes('*')
  const hasAnyGrant = roles.length > 0 || permissions.length > 0
  const formatTs = useFormatTs()

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

  // ── Destructive-action confirmation (replaces window.confirm) ──
  const [confirmAction, setConfirmAction] = useState<ConfirmKind | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)

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
      window.location.assign(result.data.authorizationUrl)
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

  // ── Destructive confirm runner (logout-all / revoke session / delete-account) ──
  const runConfirm = async () => {
    if (!confirmAction) return
    if (confirmAction.kind === 'deleteAccount') {
      // Confirmation only gates the step-up flow; no API call here.
      setConfirmAction(null)
      setPendingAction('delete-account')
      setShowStepUp(true)
      return
    }
    setConfirmBusy(true)
    if (confirmAction.kind === 'logoutAll') {
      const result = await logoutAll()
      setConfirmBusy(false)
      setConfirmAction(null)
      if (result) {
        navigate('/login', { replace: true })
      } else {
        setSessionError(t('settings.sessionsLogoutAllError'))
      }
    } else {
      const sid = confirmAction.sessionId
      setSessionRevoking(sid)
      const result = await del(`/me/sessions/${sid}`)
      if (result.ok) {
        setSessions(prev => prev.filter(s => s.id !== sid))
      } else {
        setSessionError(result.error.message)
      }
      setSessionRevoking(null)
      setConfirmBusy(false)
      setConfirmAction(null)
    }
  }

  const confirmCopy: Record<ConfirmKind['kind'], { title: string; message: string; cta: string }> = {
    logoutAll: { title: t('settings.sessionsLogoutAll'), message: t('settings.sessionsLogoutAllConfirm'), cta: t('settings.sessionsLogoutAll') },
    revoke: { title: t('settings.sessionsRevoke'), message: t('settings.sessionsRevokeConfirm'), cta: t('settings.sessionsRevoke') },
    deleteAccount: { title: t('settings.deleteAccount.heading'), message: t('settings.deleteAccount.confirm'), cta: t('settings.deleteAccount.button') },
  }

  // Not loading and not logged in — redirect to login
  useEffect(() => {
    if (!authUser && !authLoading) {
      navigate('/login', { replace: true })
    }
  }, [authUser, authLoading, navigate])

  if (!authUser) {
    if (authLoading) {
      return (
        <div className={`${shell.page} ${shell.pageNarrow}`}>
          <Spinner size="lg" label={t('admin.verifying')} />
        </div>
      )
    }
    return null
  }

  // IAM 账号仅保留「资料」标签（含改名/数据导出），隐藏全部安全设置标签
  const tabs: TabItem<TabId>[] = isIam
    ? [{ key: 'profile', label: t('settings.tabProfile') }]
    : [
        { key: 'profile', label: t('settings.tabProfile') },
        { key: 'password', label: t('settings.tabPassword') },
        { key: 'totp', label: t('settings.tabTotp') },
        { key: 'passkey', label: t('settings.tabPasskey') },
        { key: 'oauth', label: t('settings.tabOauth') },
        { key: 'sessions', label: t('settings.tabSessions') },
      ]

  return (
    <div className={`${shell.page} ${shell.pageNarrow}`}>
      <PageHeader title={t('settings.pageTitle')} description={t('settings.pageDescription')} />

      {isIam && <Alert tone="info">{t('settings.iamManagedNotice')}</Alert>}

      <Tabs
        items={tabs}
        value={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('settings.pageTitle')}
        panelId="settings-panel"
      />

      <div id="settings-panel" role="tabpanel" aria-labelledby={`tab-${activeTab}`} className={shell.tabpanel}>

      {/* ══════════════════════════════════════════
          TAB 0: PROFILE (api.md §2.2)
          ══════════════════════════════════════════ */}
      {activeTab === 'profile' && (
        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>{t('settings.profileHeading')}</h2>

            {profile && (
              <DescriptionList
                columns={1}
                items={[
                  { term: t('settings.username'), value: profile.username },
                  { term: t('settings.email'), value: profile.email ?? '-' },
                  { term: t('settings.emailVerified'), value: profile.emailVerified ? t('settings.yes') : t('settings.no') },
                ]}
              />
            )}

            <TextField
              label={t('settings.displayNameLabel')}
              value={profileDisplayName}
              onChange={e => setProfileDisplayName(e.target.value)}
              maxLength={50}
              required
              autoComplete="nickname"
            />

            {profileSuccess && <Alert tone="success">{t('settings.profileUpdated')}</Alert>}
            {profileError && <Alert tone="error">{profileError}</Alert>}

            <div className={shell.actions}>
              <AdminButton variant="primary" loading={profileSubmitting} disabled={!profileDisplayName.trim()} onClick={handleProfileUpdate}>
                {t('settings.saveProfile')}
              </AdminButton>
            </div>

            {/* GDPR 数据导出（api.md §2.3）*/}
            <div className={s.section}>
              <h3 className={s.subHeading}>{t('settings.exportHeading')}</h3>
              <p className={s.note}>{t('settings.exportDescription')}</p>
              {exportStatus === 'done' && <Alert tone="success">{t('settings.exportDone')}</Alert>}
              {exportError && <Alert tone="error">{exportError}</Alert>}
              <div className={shell.actions}>
                <AdminButton variant="secondary" loading={exportStatus === 'submitting'} onClick={handleExport}>
                  {t('settings.requestExport')}
                </AdminButton>
              </div>
            </div>

            {/* 撤销账户注销（api.md §2.5）—— IAM 账号不可用（账户生命周期由 IAM 管理）*/}
            {!isIam && (
              <div className={s.section}>
                <h3 className={s.subHeading}>{t('settings.cancelDeletionHeading')}</h3>
                <p className={s.note}>{t('settings.cancelDeletionDescription')}</p>

                {cancelStatus === 'success' ? (
                  <Alert tone="success">{t('settings.cancelSuccess')}</Alert>
                ) : (
                  <div className={shell.stackSm}>
                    <TextField label={t('settings.cancelToken')} value={cancelToken} onChange={e => setCancelToken(e.target.value)} placeholder={t('settings.cancelTokenPlaceholder')} />
                    <TextField label={t('settings.cancelIdentifier')} value={cancelIdentifier} onChange={e => setCancelIdentifier(e.target.value)} placeholder={t('settings.cancelIdentifierPlaceholder')} autoComplete="username" />
                    <TextField label={t('settings.cancelPassword')} type="password" value={cancelPassword} onChange={e => setCancelPassword(e.target.value)} placeholder={t('settings.cancelPasswordPlaceholder')} autoComplete="current-password" />
                    <TextField
                      label={t('settings.cancelMfa')}
                      value={cancelMfaCode}
                      onChange={e => {
                        const raw = e.target.value.toUpperCase()
                        if (/[A-Z-]/.test(raw)) {
                          setCancelMfaCode(raw.replace(/[^A-Z0-9-]/g, '').slice(0, 14))
                        } else {
                          setCancelMfaCode(raw.replace(/\D/g, '').slice(0, 6))
                        }
                      }}
                      placeholder={t('settings.cancelMfaPlaceholder')}
                    />

                    {/* OAuth-only 账户：使用 Passkey 代替密码（api.md §2.5）*/}
                    {profile?.security.hasPassword === false && (
                      cancelPasskeyAssertion ? (
                        <Alert tone="success">{t('settings.cancelPasskeyReady')}</Alert>
                      ) : (
                        <div className={shell.actions}>
                          <AdminButton variant="secondary" loading={cancelPasskeyProcessing} disabled={!cancelIdentifier.trim()} onClick={handleCancelPasskey}>
                            {t('settings.cancelPasskeyButton')}
                          </AdminButton>
                        </div>
                      )
                    )}

                    {cancelError && <Alert tone="error">{cancelError}</Alert>}

                    <div className={shell.actions}>
                      <AdminButton
                        variant="primary"
                        loading={cancelStatus === 'submitting'}
                        disabled={!cancelToken.trim() || !cancelIdentifier.trim() || (!cancelPassword && !cancelPasskeyAssertion && profile?.security.hasPassword === false)}
                        onClick={handleCancelDeletion}
                      >
                        {t('settings.cancelDeletionButton')}
                      </AdminButton>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ══════════════════════════════════════════
          MY PERMISSIONS (我的权限) — 仅在拥有角色/权限时展示，
          让经 IAM 登录的管理员清楚自己被授予了哪些权限
          ══════════════════════════════════════════ */}
      {activeTab === 'profile' && hasAnyGrant && (
        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>{t('settings.permissionsHeading')}</h2>
            <p className={s.note}>{isIam ? t('settings.permissionsDescriptionIam') : t('settings.permissionsDescription')}</p>

            {roles.length > 0 && (
              <div className={s.permGroup}>
                <p className={s.permGroupLabel}>{t('settings.permissionsRoles')}</p>
                <div className={s.chips}>
                  {roles.map(r => {
                    const key = ROLE_LABEL_KEYS[r]
                    return <Pill key={r} tone="accent">{key ? t(key) : r}</Pill>
                  })}
                </div>
              </div>
            )}

            <div className={s.permGroup}>
              <p className={s.permGroupLabel}>{t('settings.permissionsList')}</p>
              {hasWildcard ? (
                <div className={s.chips}>
                  <Pill tone="accent">{t('settings.permissionsWildcard')}</Pill>
                </div>
              ) : permissions.length === 0 ? (
                <p className={s.note}>{t('settings.permissionsNone')}</p>
              ) : (
                <div className={s.chips}>
                  {permissions.map(p => {
                    const key = PERMISSION_LABEL_KEYS[p]
                    return <Pill key={p}>{key ? t(key) : p}</Pill>
                  })}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* ══════════════════════════════════════════
          TAB 1: PASSWORD
          ══════════════════════════════════════════ */}
      {activeTab === 'password' && (
        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>{t('settings.passwordHeading')}</h2>

            {profile?.security.hasPassword === false && <Alert tone="info">{t('settings.passwordNotSet')}</Alert>}
            {passwordSuccess && <Alert tone="success">{t('settings.passwordChanged')}</Alert>}

            {profile?.security.hasPassword && (
              <TextField
                label={t('settings.currentPassword')}
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            )}

            <TextField
              label={t('settings.newPassword')}
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
            />

            <TextField
              label={t('settings.confirmPassword')}
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />

            {passwordError && <Alert tone="error">{passwordError}</Alert>}

            <div className={shell.actions}>
              <AdminButton variant="primary" loading={passwordSubmitting} disabled={!newPassword} onClick={handlePasswordChange}>
                {t('settings.changePassword')}
              </AdminButton>
            </div>
          </div>
        </Card>
      )}

      {/* ══════════════════════════════════════════
          TAB 2: TOTP
          ══════════════════════════════════════════ */}
      {activeTab === 'totp' && (
        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>{t('settings.totpHeading')}</h2>

            {profile?.security.totpEnabled ? (
              <>
                <Alert tone="success">{t('settings.totpEnabled')}</Alert>

                {/* Disable TOTP */}
                <div className={shell.stackSm}>
                  <h3 className={s.subHeading}>{t('settings.totpDisableTitle')}</h3>
                  {profile?.security.hasPassword && (
                    <TextField
                      type="password"
                      placeholder={t('settings.totpDisablePlaceholder')}
                      value={disableTotpPassword}
                      onChange={e => setDisableTotpPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                  )}
                  <TextField
                    inputMode="numeric"
                    placeholder={t('settings.totpCodePlaceholder')}
                    value={disableTotpCode}
                    onChange={e => setDisableTotpCode(e.target.value)}
                  />
                  <div className={shell.actions}>
                    <AdminButton variant="primary" loading={disableTotpSubmitting} disabled={!disableTotpCode} onClick={handleTotpDisable}>
                      {t('settings.totpDisableButton')}
                    </AdminButton>
                  </div>
                </div>

                {/* Regenerate recovery codes */}
                <div className={s.section}>
                  <h3 className={s.subHeading}>{t('settings.recoveryRegenerateHeading')}</h3>
                  <div className={shell.stackSm}>
                    <TextField
                      inputMode="numeric"
                      placeholder={t('settings.recoveryRegeneratePlaceholder')}
                      value={regenerateCode}
                      onChange={e => setRegenerateCode(e.target.value)}
                    />
                    <div className={shell.actions}>
                      <AdminButton variant="secondary" loading={regenerateSubmitting} disabled={!regenerateCode} onClick={handleRegenerateRecoveryCodes}>
                        {t('settings.recoveryRegenerateButton')}
                      </AdminButton>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <p className={s.note}>{t('settings.totpSetupDescription')}</p>

                {!totpSetupData ? (
                  <div className={shell.actions}>
                    <AdminButton variant="primary" loading={totpSubmitting} onClick={handleTotpSetup}>
                      {t('settings.totpSetupButton')}
                    </AdminButton>
                  </div>
                ) : (
                  <div className={shell.stackSm}>
                    <p className={s.note}>{t('settings.totpScanHint')}</p>

                    {totpSetupData.qrCodeImage && (
                      <img src={totpSetupData.qrCodeImage} alt="TOTP QR Code" className={s.qr} />
                    )}

                    <p className={s.secretLine}>
                      {t('settings.secretLabel')}<code className={s.secret}>{totpSetupData.secret}</code>
                    </p>

                    <div className={s.codeNarrow}>
                      <TextField
                        className={s.codeInput}
                        inputMode="numeric"
                        placeholder={t('settings.totpCodeInputPlaceholder')}
                        value={totpCode}
                        onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        maxLength={6}
                        autoFocus
                      />
                    </div>

                    {totpError && <Alert tone="error">{totpError}</Alert>}

                    <div className={s.centerActions}>
                      <AdminButton variant="primary" loading={totpSubmitting} disabled={totpCode.length < 6} onClick={handleTotpEnable}>
                        {t('settings.totpConfirmButton')}
                      </AdminButton>
                    </div>
                  </div>
                )}
              </>
            )}

            {totpError && !totpSetupData && <Alert tone="error">{totpError}</Alert>}
          </div>
        </Card>
      )}

      {/* ══════════════════════════════════════════
          TAB 3: PASSKEY
          ══════════════════════════════════════════ */}
      {activeTab === 'passkey' && (
        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>{t('settings.passkeyHeading')}</h2>
            <p className={s.note}>{t('settings.passkeyDescription')}</p>

            {/* Register new */}
            <div className={s.inlineRow}>
              <TextField
                fieldClassName={s.grow}
                aria-label={t('settings.passkeyNamePlaceholder')}
                placeholder={t('settings.passkeyNamePlaceholder')}
                value={passkeyName}
                onChange={e => setPasskeyName(e.target.value)}
                maxLength={50}
              />
              <AdminButton variant="primary" loading={passkeySubmitting} disabled={!passkeyName.trim()} onClick={handlePasskeyRegister}>
                {t('settings.passkeyRegisterButton')}
              </AdminButton>
            </div>

            {passkeyError && <Alert tone="error">{passkeyError}</Alert>}

            {/* List */}
            {passkeyLoading ? (
              <Spinner size="lg" label={t('settings.loading')} />
            ) : passkeys.length === 0 ? (
              <p className={s.note}>{t('settings.passkeyEmpty')}</p>
            ) : (
              <ul className={shell.list}>
                {passkeys.map(pk => (
                  <li key={pk.id}>
                    <div className={shell.rowStatic}>
                      <span className={shell.rowMain}>
                        <span className={shell.rowTitle}>{pk.name}</span>
                        <span className={shell.rowMeta}>
                          <span>{t('settings.passkeyRegisteredAt')} {formatTs(pk.createdAt)}</span>
                          {pk.lastUsedAt && (
                            <>
                              <span className={shell.rowMetaSep}>·</span>
                              <span>{t('settings.passkeyLastUsed')} {formatTs(pk.lastUsedAt)}</span>
                            </>
                          )}
                          {pk.status === 'frozen' && (
                            <>
                              <span className={shell.rowMetaSep}>·</span>
                              <span>{pk.frozenReason || t('settings.passkeyUnknownReason')}</span>
                            </>
                          )}
                        </span>
                      </span>
                      <span className={shell.rowRight}>
                        {pk.status === 'frozen' ? (
                          <StatusBadge tone="muted" label={t('settings.passkeyFrozen')} size="sm" />
                        ) : (
                          <AdminButton variant="danger" size="sm" onClick={() => handlePasskeyDelete(pk.id)}>
                            {t('settings.passkeyDelete')}
                          </AdminButton>
                        )}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      {/* ══════════════════════════════════════════
          TAB 4: OAUTH BINDING
          ══════════════════════════════════════════ */}
      {activeTab === 'oauth' && (
        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>{t('settings.oauthHeading')}</h2>
            <p className={s.note}>{t('settings.oauthDescription')}</p>

            {oauthError && <Alert tone="error">{oauthError}</Alert>}

            {oauthLoading ? (
              <Spinner size="lg" label={t('settings.loading')} />
            ) : (
              <ul className={shell.list}>
                {(['github', 'x'] as const).map(provider => {
                  const acct = oauthAccounts.find(a => a.provider === provider)
                  const name = provider === 'github' ? 'GitHub' : 'X (Twitter)'
                  return (
                    <li key={provider}>
                      <div className={shell.rowStatic}>
                        <span className={shell.rowMain}>
                          <span className={shell.rowTitle}>{name}</span>
                          <span className={shell.rowMeta}>
                            {acct ? (
                              <>
                                <span>@{acct.providerUsername}</span>
                                <span className={shell.rowMetaSep}>·</span>
                                <span>{t('settings.oauthBoundAt')} {formatTs(acct.boundAt)}</span>
                              </>
                            ) : (
                              <span>{t('settings.oauthNotBound')}</span>
                            )}
                          </span>
                        </span>
                        <span className={shell.rowRight}>
                          {acct ? (
                            <AdminButton variant="danger" size="sm" onClick={() => handleOAuthUnbind(provider)}>{t('settings.oauthUnbind')}</AdminButton>
                          ) : (
                            <AdminButton variant="primary" size="sm" onClick={() => handleOAuthBind(provider)}>{t('settings.oauthBind')}</AdminButton>
                          )}
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </Card>
      )}

      {activeTab === 'sessions' && (
        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>{t('settings.sessionsHeading')}</h2>
            <p className={s.note}>{t('settings.sessionsDescription')}</p>
            <div className={shell.actions}>
              <AdminButton variant="danger" onClick={() => setConfirmAction({ kind: 'logoutAll' })}>
                {t('settings.sessionsLogoutAll')}
              </AdminButton>
            </div>
            {sessionError && <Alert tone="error">{sessionError}</Alert>}
            {sessionLoading && sessions.length === 0 ? (
              <Spinner size="lg" label={t('settings.loading')} />
            ) : sessions.length === 0 ? (
              <p className={s.note}>{t('settings.sessionsEmpty')}</p>
            ) : (
              <>
                <ul className={shell.list}>
                  {sessions.map(sess => (
                    <li key={sess.id}>
                      <div className={shell.rowStatic}>
                        <span className={shell.rowMain}>
                          <span className={shell.rowTitle}>{sess.device.browser || '-'}</span>
                          <span className={shell.rowMeta}>
                            {sess.device.os && (
                              <>
                                <span>{sess.device.os}</span>
                                <span className={shell.rowMetaSep}>·</span>
                              </>
                            )}
                            <span>{t('settings.sessionsIpPrefix')}: {sess.ipPrefix}</span>
                            <span className={shell.rowMetaSep}>·</span>
                            <span>{t('settings.sessionsLoggedIn')}: {formatTs(sess.createdAt)}</span>
                            {sess.lastUsedAt && (
                              <>
                                <span className={shell.rowMetaSep}>·</span>
                                <span>{t('settings.sessionsLastActive')}: {formatTs(sess.lastUsedAt)}</span>
                              </>
                            )}
                          </span>
                        </span>
                        <span className={shell.rowRight}>
                          {sess.current ? (
                            <StatusBadge tone="green" label={t('settings.sessionsCurrent')} size="sm" />
                          ) : (
                            <AdminButton
                              variant="danger"
                              size="sm"
                              loading={sessionRevoking === sess.id}
                              onClick={() => setConfirmAction({ kind: 'revoke', sessionId: sess.id })}
                            >
                              {t('settings.sessionsRevoke')}
                            </AdminButton>
                          )}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                {sessionCursor && (
                  <div className={shell.loadMoreWrap}>
                    <AdminButton variant="secondary" loading={sessionLoading} onClick={loadMoreSessions}>
                      {t('settings.sessionsLoadMore')}
                    </AdminButton>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>
      )}

        {/* Delete account section — only on the profile tab; hidden for IAM accounts. */}
        {activeTab === 'profile' && !isIam && (
          <Card>
            <div className={shell.stack}>
              <h2 className={shell.detailTitle}>{t('settings.deleteAccount.heading')}</h2>
              <p className={s.note}>{t('settings.deleteAccount.description')}</p>
              {cancelError && <Alert tone="error">{cancelError}</Alert>}
              {deleteAccountError && <Alert tone="error">{deleteAccountError}</Alert>}
              <div className={shell.actions}>
                <AdminButton variant="danger" onClick={() => setConfirmAction({ kind: 'deleteAccount' })}>
                  {t('settings.deleteAccount.button')}
                </AdminButton>
              </div>
            </div>
          </Card>
        )}
      </div>

      {/* Recovery codes — shown after enabling TOTP / regenerating */}
      <Modal
        open={showRecoveryCodes && !!recoveryCodes && recoveryCodes.length > 0}
        /* Codes are shown once — only the explicit "saved" button dismisses;
           Escape/backdrop are no-ops so an accidental tap can't lose them. */
        onClose={() => {}}
        closeOnOverlayClick={false}
        title={t('settings.recoveryCodesTitle')}
        footer={
          <AdminButton variant="primary" onClick={() => { setShowRecoveryCodes(false); setRecoveryCodes(null) }}>
            {t('settings.recoveryCodesSaved')}
          </AdminButton>
        }
      >
        <Alert tone="error">{t('settings.recoveryCodesHint')}</Alert>
        <div className={s.recoveryCodes}>
          {recoveryCodes?.map((code, i) => <div key={i}>{code}</div>)}
        </div>
      </Modal>

      {/* Delete account — password confirmation (replaces native prompt) */}
      <Modal
        open={deletePasswordNeeded}
        onClose={() => { setDeletePasswordNeeded(false); setDeletePassword(''); setDeletePasswordError('') }}
        title={t('settings.deleteAccount.passwordPrompt')}
        footer={
          <>
            <AdminButton variant="secondary" onClick={() => { setDeletePasswordNeeded(false); setDeletePassword(''); setDeletePasswordError('') }}>
              {t('settings.cancel')}
            </AdminButton>
            <AdminButton variant="danger" loading={deletePasswordSubmitting} disabled={!deletePassword} onClick={handleDeleteWithPassword}>
              {t('settings.confirm')}
            </AdminButton>
          </>
        }
      >
        <TextField
          type="password"
          value={deletePassword}
          onChange={e => setDeletePassword(e.target.value)}
          placeholder={t('settings.passwordPlaceholder')}
          autoComplete="current-password"
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') handleDeleteWithPassword() }}
        />
        {deletePasswordError && <Alert tone="error">{deletePasswordError}</Alert>}
      </Modal>

      {/* Destructive confirmation (logout-all / revoke session / delete-account) */}
      {confirmAction && (
        <ConfirmDialog
          open
          title={confirmCopy[confirmAction.kind].title}
          message={confirmCopy[confirmAction.kind].message}
          confirmText={confirmCopy[confirmAction.kind].cta}
          cancelText={t('settings.cancel')}
          variant="danger"
          confirmLoading={confirmBusy}
          onConfirm={runConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {/* Step-up dialog */}
      {showStepUp && (
        <StepUpDialog
          onSuccess={handleStepUpSuccess}
          onCancel={() => { setShowStepUp(false); setPendingAction(null) }}
          accessToken={accessToken ?? ''}
        />
      )}
    </div>
  )
}

