import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get, post, patch, del } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { useAuth } from '@/context/useAuth'
import { StepUpDialog } from '@/components/StepUpDialog'
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
  const { user: authUser, accessToken, logoutAll } = useAuth()

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>('password')

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
  const [cancelToken, setCancelToken] = useState('')
  const [cancelIdentifier, setCancelIdentifier] = useState('')
  const [cancelPassword, setCancelPassword] = useState('')
  const [cancelMfaCode, setCancelMfaCode] = useState('')
  const [cancelStatus, setCancelStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [cancelError, setCancelError] = useState('')

  // ── Load profile on mount ──
  useEffect(() => {
    const load = async () => {
      const result = await get<Record<string, unknown>>('/me')
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
  }, [])

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
      if (result.ok) setSessions(result.data)
      else setSessionError(result.error.message)
      setSessionLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab])

  // When step-up completes, proceed with unbinding
  const handleUnbindAfterStepUp = useCallback(async (provider: 'github' | 'x'): Promise<void> => {
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
        const pw = prompt('请输入当前密码以确认删除账户：')
        if (!pw) return
        body.password = pw
      }
      post('/me/delete', body).then(r => {
        if (r.ok) navigate('/?toast=deletion_scheduled')
        else setCancelError(r.error?.message || '删除失败')
      })
    } else if (action?.startsWith('unbind-')) {
      const provider = action.replace('unbind-', '') as 'github' | 'x'
      handleUnbindAfterStepUp(provider)
    }
  }, [pendingAction, navigate, handleUnbindAfterStepUp])

  // ── 0. Profile Edit (api.md §2.2) ──
  const handleProfileUpdate = async () => {
    setProfileError('')
    setProfileSuccess(false)

    const dn = profileDisplayName.trim()
    if (!dn || dn.length > 50) {
      setProfileError('显示名称需 1-50 个字符')
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

  // ── Cancel Account Deletion (api.md §2.5) ──
  const handleCancelDeletion = async () => {
    setCancelError('')
    if (!cancelToken.trim() || !cancelIdentifier.trim()) {
      setCancelError('令牌和账号标识为必填项')
      return
    }
    setCancelStatus('submitting')
    const result = await post('/me/delete/cancel', {
      cancelToken: cancelToken.trim(),
      identifier: cancelIdentifier.trim(),
      password: cancelPassword || undefined,
      mfaCode: cancelMfaCode || undefined,
    })
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
      setPasswordError(t('settings.passwordMismatch') || '两次密码输入不一致')
      return
    }

    setPasswordSubmitting(true)
    const result = await post('/me/password', {
      currentPassword: currentPassword || undefined,
      newPassword,
    })
    setPasswordSubmitting(false)

    if (result.ok) {
      setPasswordSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } else {
      if (result.error.code === ERRORS.VALIDATION_ERROR) {
        setPasswordError(result.error.message)
      } else if (result.error.code === ERRORS.INVALID_CREDENTIALS) {
        setPasswordError(t('settings.currentPasswordWrong') || '当前密码错误')
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
      setTotpError(dResult.error.message || '禁用失败')
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

      // Convert base64url challenge/user.id to ArrayBuffer for the browser API
      const base64urlToBuffer = (s: string): ArrayBuffer =>
        Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer

      const base64urlToUint8Array = (s: string): Uint8Array =>
        Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

      const rawChallenge = creationOptions.challenge as unknown as string
      const rawUser = creationOptions.user as unknown as { id: string; displayName: string; name: string }
      const rawExclude = creationOptions.excludeCredentials as unknown as Array<{ id: string; type: string; transports?: AuthenticatorTransport[] }> | undefined

      const publicKey: PublicKeyCredentialCreationOptions = {
        ...creationOptions,
        challenge: base64urlToBuffer(rawChallenge) as ArrayBuffer,
        rp: creationOptions.rp as PublicKeyCredentialRpEntity,
        user: {
          id: base64urlToUint8Array(rawUser.id).buffer as ArrayBuffer,
          displayName: rawUser.displayName,
          name: rawUser.name,
        },
        pubKeyCredParams: creationOptions.pubKeyCredParams as PublicKeyCredentialParameters[],
        excludeCredentials: rawExclude?.map(c => ({
          type: c.type as PublicKeyCredentialType,
          id: base64urlToUint8Array(c.id).buffer as ArrayBuffer,
          transports: c.transports,
        })),
      }

      const cred = await navigator.credentials.create({ publicKey })

      if (!cred) {
        setPasskeyError('用户取消了操作')
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
          id: pkCred.id,
          rawId: pkCred.id,
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
      setPasskeyError(err instanceof Error ? err.message : '注册失败')
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
      setOauthError('无法获取授权链接')
    }
  }

  const handleOAuthUnbind = async (provider: 'github' | 'x') => {
    setOauthError('')

    if (!accessToken) {
      setOauthError(t('settings.stepUpRequired') || '需要二次认证')
      return
    }

    setShowStepUp(true)
    setPendingAction(`unbind-${provider}`)
  }

  // ── Helper: ArrayBuffer → base64url ──
  function arrayBufferToBase64url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  }

  // ── Render ──

  if (!authUser) {
    return (
      <main className={styles.container}>
        <div className={styles.loading}>{t('admin.verifying')}</div>
      </main>
    )
  }

  const tabs = [
    { key: 'profile' as TabId, label: '个人资料' },
    { key: 'password' as TabId, label: '密码' },
    { key: 'totp' as TabId, label: 'TOTP 验证' },
    { key: 'passkey' as TabId, label: 'Passkey' },
    { key: 'oauth' as TabId, label: 'OAuth 绑定' },
    { key: 'sessions' as TabId, label: '活跃会话' },
  ]

  return (
    <main className={styles.container}>
      <header>
        <h1 className={styles.heading}>安全设置</h1>
        <p className={styles.headingDesc}>管理密码、二步验证、Passkey 和 OAuth 绑定</p>
      </header>

      <nav className={styles.tabs}>
        {tabs.map(tab => (
          <button
            key={tab.key}
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
        <div className={styles.detailCard}>
          <h2 className={styles.detailTitle}>个人资料</h2>

          {profile && (
            <div style={{ marginBottom: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              <p>用户名：{profile.username}</p>
              <p>邮箱：{profile.email ?? '-'}</p>
              <p>邮箱已验证：{profile.emailVerified ? '是' : '否'}</p>
            </div>
          )}

          <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.75rem' }}>
            显示名称（1-50 字符）
            <input
              type="text"
              value={profileDisplayName}
              onChange={e => setProfileDisplayName(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
              className={styles.input}
              maxLength={50}
              required
            />
          </label>

          {profileSuccess && (
            <p style={{ color: '#2e7d32', fontSize: '0.9rem', marginBottom: '0.75rem' }}>资料更新成功</p>
          )}
          {profileError && (
            <p style={{ color: '#c62828', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{profileError}</p>
          )}

          <button
            className={styles.btnPrimary}
            onClick={handleProfileUpdate}
            disabled={profileSubmitting || !profileDisplayName.trim()}
          >
            {profileSubmitting ? '保存中...' : '保存修改'}
          </button>

          {/* GDPR 数据导出（api.md §2.3）*/}
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--divider-color)', paddingTop: '1.5rem' }}>
            <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>导出我的数据</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
              导出你的账号资料、投稿全文及所有关联数据。导出完成后将通过邮件下发下载链接。7 天内最多发起 2 次导出。
            </p>

            {exportStatus === 'done' && (
              <p style={{ color: '#2e7d32', fontSize: '0.9rem', marginBottom: '0.5rem' }}>导出请求已受理，请查收邮件</p>
            )}
            {exportError && (
              <p style={{ color: '#c62828', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{exportError}</p>
            )}

            <button
              className={styles.btnSecondary}
              onClick={handleExport}
              disabled={exportStatus === 'submitting'}
            >
              {exportStatus === 'submitting' ? '请求中...' : '请求导出'}
            </button>
          </div>

          {/* 撤销账户注销（api.md §2.5）*/}
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--divider-color)', paddingTop: '1.5rem' }}>
            <h3 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>撤销账户注销</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
              已在冷静期内？在收到注销邮件后，填入邮件中的撤销令牌和账号信息即可恢复账户。
            </p>

            {cancelStatus === 'success' ? (
              <p style={{ color: '#2e7d32', fontSize: '0.9rem', marginBottom: '0.5rem' }}>账户已成功撤销注销，请重新登录</p>
            ) : (
              <>
                <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.5rem' }}>
                  撤销令牌
                  <input type="text" value={cancelToken} onChange={e => setCancelToken(e.target.value)}
                    className={styles.input} style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
                    placeholder="邮件中的 cancelToken" />
                </label>
                <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.5rem' }}>
                  用户名或邮箱
                  <input type="text" value={cancelIdentifier} onChange={e => setCancelIdentifier(e.target.value)}
                    className={styles.input} style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
                    placeholder="alice@example.com" />
                </label>
                <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.5rem' }}>
                  密码（选填）
                  <input type="password" value={cancelPassword} onChange={e => setCancelPassword(e.target.value)}
                    className={styles.input} style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
                    placeholder="OAuth 账户可留空" />
                </label>
                <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.75rem' }}>
                  TOTP 验证码（选填）
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
                    placeholder="TOTP 6位数字 或 恢复码 XXXX-XXXX-XXXX" />
                </label>

                {cancelError && (
                  <p style={{ color: '#c62828', fontSize: '0.85rem', marginBottom: '0.5rem' }} role="alert">{cancelError}</p>
                )}

                <button
                  className={styles.btnSecondary}
                  onClick={handleCancelDeletion}
                  disabled={cancelStatus === 'submitting' || !cancelToken.trim() || !cancelIdentifier.trim()}
                  style={{ color: '#2e7d32', borderColor: '#81c784' }}
                >
                  {cancelStatus === 'submitting' ? '提交中...' : '撤销注销'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════
          TAB 1: PASSWORD
          ══════════════════════════════════════════ */}
      {activeTab === 'password' && (
        <div className={styles.detailCard}>
          <h2 className={styles.detailTitle}>修改密码</h2>

          {profile?.security.hasPassword === false && (
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              你当前未设置密码。请设置一个密码以增加账户安全性。
            </p>
          )}

          {passwordSuccess && (
            <p style={{ color: '#2e7d32', fontSize: '0.9rem', marginBottom: '1rem' }}>
              密码修改成功
            </p>
          )}

          {profile?.security.hasPassword && (
            <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.5rem' }}>
              当前密码
              <input
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
                className={styles.input}
              />
            </label>
          )}

          <label className={styles.headingDesc} style={{ display: 'block', marginBottom: '0.5rem' }}>
            新密码（12-128 字符）
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
            确认新密码
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
              className={styles.input}
            />
          </label>

          {passwordError && (
            <p style={{ color: '#c62828', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{passwordError}</p>
          )}

          <button
            className={styles.btnPrimary}
            onClick={handlePasswordChange}
            disabled={passwordSubmitting || !newPassword}
          >
            {passwordSubmitting ? '修改中...' : '修改密码'}
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════
          TAB 2: TOTP
          ══════════════════════════════════════════ */}
      {activeTab === 'totp' && (
        <div className={styles.detailCard}>
          <h2 className={styles.detailTitle}>TOTP 二步验证</h2>

          {profile?.security.totpEnabled ? (
            <>
              <p style={{ fontSize: '0.9rem', color: '#2e7d32', marginBottom: '1rem' }}>
                ✅ TOTP 已启用
              </p>

              {/* Disable TOTP */}
              <h3 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>禁用 TOTP</h3>
              {profile?.security.hasPassword && (
                <input
                  type="password"
                  placeholder="当前密码（如已设置）"
                  value={disableTotpPassword}
                  onChange={e => setDisableTotpPassword(e.target.value)}
                  className={styles.input}
                  style={{ display: 'block', width: '100%', marginBottom: '0.5rem' }}
                />
              )}
              <input
                type="text"
                inputMode="numeric"
                placeholder="TOTP 验证码或恢复码"
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
                {disableTotpSubmitting ? '禁用中...' : '禁用 TOTP'}
              </button>

              {/* Regenerate recovery codes */}
              <div style={{ marginTop: '2rem', borderTop: '1px solid var(--divider-color)', paddingTop: '1rem' }}>
                <h3 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>重新生成恢复码</h3>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="TOTP 验证码或一个未使用的旧恢复码"
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
                  {regenerateSubmitting ? '生成中...' : '重新生成'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                TOTP 二步验证增加账户安全性。启用后登录时需要输入认证器应用中的 6 位验证码。
              </p>

              {!totpSetupData ? (
                <button
                  className={styles.btnPrimary}
                  onClick={handleTotpSetup}
                  disabled={totpSubmitting}
                >
                  {totpSubmitting ? '准备中...' : '开始设置 TOTP'}
                </button>
              ) : (
                <div>
                  <p style={{ fontSize: '0.9rem', color: 'var(--text-main)', marginBottom: '0.5rem' }}>
                    请在认证器应用中扫描此二维码或手动输入密钥：
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
                    密钥：<code style={{ fontSize: '0.9rem', letterSpacing: '0.1em' }}>{totpSetupData.secret}</code>
                  </p>

                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="输入验证器中的 6 位验证码"
                    value={totpCode}
                    onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className={styles.input}
                    style={{ display: 'block', width: '200px', margin: '0 auto 0.75rem', textAlign: 'center', fontSize: '1.2rem', letterSpacing: '0.3em' }}
                    maxLength={6}
                    autoFocus
                  />

                  {totpError && (
                    <p style={{ color: '#c62828', fontSize: '0.85rem', textAlign: 'center', marginBottom: '0.5rem' }}>{totpError}</p>
                  )}

                  <div style={{ textAlign: 'center' }}>
                    <button
                      className={styles.btnPrimary}
                      onClick={handleTotpEnable}
                      disabled={totpSubmitting || totpCode.length < 6}
                    >
                      {totpSubmitting ? '验证中...' : '确认并启用'}
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
              background: 'rgba(0,0,0,0.5)', zIndex: 1000,
            }}>
              <div style={{
                background: 'var(--bg-color, #fff)', padding: '2rem', borderRadius: '10px',
                maxWidth: '500px', width: '90%',
              }}>
                <h3 style={{ margin: '0 0 0.5rem' }}>恢复码</h3>
                <p style={{ fontSize: '0.85rem', color: '#c62828', marginBottom: '0.75rem' }}>
                  请立即安全保存这些恢复码。它们仅在此显示一次。
                </p>
                <div style={{
                  background: '#f5f5f5', padding: '1rem', borderRadius: '8px',
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
                  我已保存
                </button>
              </div>
            </div>
          )}

          {totpError && !totpSetupData && (
            <p style={{ color: '#c62828', fontSize: '0.85rem', marginTop: '0.5rem' }}>{totpError}</p>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════
          TAB 3: PASSKEY
          ══════════════════════════════════════════ */}
      {activeTab === 'passkey' && (
        <div className={styles.detailCard}>
          <h2 className={styles.detailTitle}>Passkey</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            使用生物识别或设备 PIN 快速登录。
          </p>

          {/* Register new */}
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Passkey 名称（如 我的 iPhone）"
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
              {passkeySubmitting ? '注册中...' : '注册 Passkey'}
            </button>
          </div>

          {passkeyError && (
            <p style={{ color: '#c62828', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{passkeyError}</p>
          )}

          {/* List */}
          {passkeyLoading ? (
            <div className={styles.loading}>加载中...</div>
          ) : passkeys.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>尚未注册 Passkey</p>
          ) : (
            <ul className={styles.list}>
              {passkeys.map(pk => (
                <li key={pk.id} className={styles.item}>
                  <div className={styles.itemMain}>
                    <div className={styles.itemTitle}>{pk.name}</div>
                    <div className={styles.itemMeta}>
                      {pk.status === 'frozen' ? `❄️ 已冻结 (${pk.frozenReason || '未知原因'}) · ` : ''}
                      注册于 {formatTs(pk.createdAt)}
                      {pk.lastUsedAt ? ` · 上次使用 ${formatTs(pk.lastUsedAt)}` : ''}
                    </div>
                  </div>
                  {pk.status === 'active' && (
                    <button
                      className={styles.btnSecondary}
                      onClick={() => handlePasskeyDelete(pk.id)}
                      style={{ color: '#c62828', borderColor: '#ef9a9a' }}
                    >
                      删除
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
        <div className={styles.detailCard}>
          <h2 className={styles.detailTitle}>OAuth 账号绑定</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            绑定 GitHub 或 X（Twitter）账号以便快速登录。
          </p>

          {oauthError && (
            <p style={{ color: '#c62828', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{oauthError}</p>
          )}

          {oauthLoading ? (
            <div className={styles.loading}>加载中...</div>
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
                            @{gh.providerUsername} · 绑定于 {formatTs(gh.boundAt)}
                          </p>
                        : <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.25rem 0 0' }}>未绑定</p>
                    })()}
                  </div>
                  {oauthAccounts.find(a => a.provider === 'github')
                    ? <button className={styles.btnSecondary} onClick={() => handleOAuthUnbind('github')} style={{ color: '#c62828' }}>解绑</button>
                    : <button className={styles.btnPrimary} onClick={() => handleOAuthBind('github')}>绑定</button>
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
                            @{x.providerUsername} · 绑定于 {formatTs(x.boundAt)}
                          </p>
                        : <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.25rem 0 0' }}>未绑定</p>
                    })()}
                  </div>
                  {oauthAccounts.find(a => a.provider === 'x')
                    ? <button className={styles.btnSecondary} onClick={() => handleOAuthUnbind('x')} style={{ color: '#c62828' }}>解绑</button>
                    : <button className={styles.btnPrimary} onClick={() => handleOAuthBind('x')}>绑定</button>
                  }
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'sessions' && (
        <div className={styles.detailCard}>
          <h2 className={styles.detailTitle}>活跃会话</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            管理当前登录的设备
          </p>
          <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button className={styles.btnSecondary} onClick={async () => {
              if (!window.confirm('确定退出全部会话？包括当前会话在内的所有设备都将被登出，你需要重新登录。')) return
              const result = await logoutAll()
              if (result) {
                navigate('/login', { replace: true })
              } else {
                setSessionError('退出全部会话失败')
              }
            }} style={{ color: '#c62828', borderColor: '#ef9a9a' }}>
              退出全部会话
            </button>
          </div>
          {sessionError && (
            <p style={{ color: '#c62828', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{sessionError}</p>
          )}
          {sessionLoading && sessions.length === 0 ? (
            <div className={styles.loading}>加载中...</div>
          ) : sessions.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>无活跃会话</p>
          ) : (
            <ul className={styles.list}>
              {sessions.map(sess => (
                <li key={sess.id} className={styles.item}>
                  <div className={styles.itemMain}>
                    <div className={styles.itemTitle}>
                      {sess.current ? `🟢 当前会话` : `○ ${sess.device.browser || '-'}`}
                    </div>
                    <div className={styles.itemMeta}>
                      {sess.device.os ? `${sess.device.os} · ` : ''}
                      IP 段: {sess.ipPrefix} · 登录: {formatTs(sess.createdAt)}
                      {sess.lastUsedAt ? ` · 最后活跃: ${formatTs(sess.lastUsedAt)}` : ''}
                    </div>
                  </div>
                  {!sess.current && (
                    <button
                      className={styles.btnSecondary}
                      onClick={async () => {
                        if (!window.confirm('确定吊销该会话？')) return
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
                      style={{ color: '#c62828', borderColor: '#ef9a9a' }}
                    >
                      {sessionRevoking === sess.id ? '吊销中...' : '吊销'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
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

