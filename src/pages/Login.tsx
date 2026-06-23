import { useState, useMemo, useEffect, useRef } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { get } from '@/api/client'
import { computePermissions, landingPath } from '@/api/permissions'
import { AdminButton, Alert, CenteredCard, PageHeader, TextField } from '@/components/ui'
import auth from './Auth.module.css'

export const Login = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const { loginWithPassword, loginWithGitHub, loginWithX, loginWithIam, loginWithPasskey, mfaVerify, user: authUser, loading: authLoading } = useAuth()
  const justLoggedInRef = useRef(false)

  // 仅当后端启用 IAM（配置完整）时才展示「统一身份登录(管理员)」按钮
  const [iamEnabled, setIamEnabled] = useState(false)
  useEffect(() => {
    let active = true
    get<{ providers: string[] }>('/auth/oauth/providers').then(r => {
      if (active && r.ok) setIamEnabled(r.data.providers.includes('iam'))
    })
    return () => { active = false }
  }, [])

  // Navigate after auth context loads full profile (with roles) from /v1/me
  // 优先消费 ?redirect= 深链参数（从 RequireAdminLayout 等守卫跳转而来）
  // 注意：redirect 必须通过白名单校验，防止开放重定向
  useEffect(() => {
    if (justLoggedInRef.current && authUser && !authLoading) {
      justLoggedInRef.current = false
      const redirect = searchParams.get('redirect')
      if (redirect && isValidRedirect(redirect)) {
        navigate(redirect, { replace: true })
        return
      }
      // 权限驱动跳转：进入「确实有权访问」的首个管理页，避免被各页守卫拒绝
      const perms = Array.isArray(authUser.permissions)
        ? authUser.permissions
        : computePermissions(authUser.roles ?? [])
      navigate(landingPath(perms), { replace: true })
    }
  }, [authUser, authLoading, navigate, searchParams])

  // 路由保护：已登录用户访问 /login 直接重定向走（修复 OAuth 回调 redirectAfter=/login
  // 时回到登录页、看似未登录的问题）。优先消费安全的 ?redirect=，否则前往个人资料页。
  useEffect(() => {
    if (authLoading || justLoggedInRef.current || !authUser) return
    const redirect = searchParams.get('redirect')
    const safe = redirect && redirect.startsWith('/') && !redirect.startsWith('//') && !/^\/(login|register)\b/.test(redirect)
      ? redirect
      : '/settings/security?tab=profile'
    navigate(safe, { replace: true })
  }, [authUser, authLoading, navigate, searchParams])

  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // MFA state
  const [mfaRequired, setMfaRequired] = useState(false)
  const [mfaChallengeToken, setMfaChallengeToken] = useState('')
  const [mfaMethods, setMfaMethods] = useState<string[]>([])
  const [mfaCode, setMfaCode] = useState('')
  const [mfaSubmitting, setMfaSubmitting] = useState(false)
  // Tracks whether the current input contains recovery-code characters.
  // Updated in onChange; React handles the re-render so the keyboard switches
  // before the next paint (M2).
  const [isRecoveryCode, setIsRecoveryCode] = useState(false)

  const canSubmit = useMemo(() => {
    return identifier.trim().length >= 3 && password.length >= 12 && password.length <= 128
  }, [identifier, password])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      // Single login call (api.md §1.3) — LoginResult eliminates redundant second call
      const result = await loginWithPassword(identifier.trim(), password)
      if (result.user) {
        justLoggedInRef.current = true
      } else if (result.mfaChallengeToken) {
        setMfaRequired(true)
        setMfaChallengeToken(result.mfaChallengeToken)
        setMfaMethods(result.mfaAvailableMethods || ['totp'])
      } else {
        const code = result.errorCode
        if (code === 'ACCOUNT_BANNED') setError(t('login.errors.banned'))
        else if (code === 'ACCOUNT_MERGED') setError(t('login.errors.merged'))
        else if (code === 'ACCOUNT_PENDING_DELETION') setError(t('login.errors.pendingDeletion'))
        else if (code === 'ACCOUNT_LOCKED') setError(t('login.errors.locked'))
        else if (code === 'ACCOUNT_DELETED') setError(t('login.errors.deleted'))
        else if (code === 'INVALID_CREDENTIALS') setError(t('login.errors.invalidCredentials'))
        else setError(t('login.errors.serverError'))
      }
    } catch {
      setError(t('login.errors.serverError'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleMfaSubmit = async () => {
    if (!mfaCode || mfaCode.length < 6) return
    setMfaSubmitting(true)
    setError('')

    try {
      const result = await mfaVerify(mfaChallengeToken, mfaCode)
      if (result.user) {
        justLoggedInRef.current = true
      } else if (result.errorCode === 'TOKEN_INVALID_OR_EXPIRED') {
        setError(t('login.mfaExpired'))
      } else if (result.errorCode === 'MFA_CHALLENGE_EXHAUSTED') {
        setError(t('login.mfaExhausted'))
      } else if (result.errorCode === 'INVALID_TOTP_CODE') {
        setError(t('login.mfaInvalidCode'))
      } else if (result.errorCode === 'TOTP_CODE_REPLAY') {
        setError(t('login.mfaCodeReplay'))
      } else {
        setError(result.errorCode || t('login.mfaVerifyFailed'))
      }
    } catch {
      setError(t('login.errors.serverError'))
    } finally {
      setMfaSubmitting(false)
    }
  }

  if (mfaRequired) {
    const hasTotp = mfaMethods.includes('totp')
    const hasPasskey = mfaMethods.includes('passkey')

    return (
      <CenteredCard>
        <PageHeader title={t('login.mfaTitle')} description={t('login.mfaDescription')} align="center" />

        {hasTotp && (
          <div className={auth.form}>
            <TextField
              label={t('login.mfaCodeLabel')}
              placeholder={t('login.totpPlaceholder')}
              className={auth.mfaCode}
              type="text"
              inputMode={isRecoveryCode ? 'text' : 'numeric'}
              value={mfaCode}
              onChange={(e) => {
                const raw = e.target.value.toUpperCase()
                const hasLetters = /[A-Z-]/.test(raw)
                if (hasLetters) {
                  setMfaCode(raw.replace(/[^A-Z0-9-]/g, '').slice(0, 14))
                } else {
                  setMfaCode(raw.replace(/\D/g, '').slice(0, 6))
                }
                // Update isRecoveryCode on next render so inputMode is correct (M2)
                if (hasLetters !== isRecoveryCode) setIsRecoveryCode(hasLetters)
              }}
              maxLength={14}
              autoFocus
            />
            <AdminButton
              variant="primary"
              fullWidth
              loading={mfaSubmitting}
              disabled={mfaCode.length !== 6 && mfaCode.length !== 14}
              onClick={handleMfaSubmit}
            >
              {t('login.submit')}
            </AdminButton>
          </div>
        )}

        {hasPasskey && (
          <div className={auth.form}>
            {hasTotp && <div className={auth.divider}>{t('login.mfaOrPasskey')}</div>}
            <p className={auth.aside}>{t('login.passkeyMfaDescription')}</p>
            {mfaSubmitting && (
              <p className={auth.aside} role="status" aria-live="polite">{t('login.passkeyAwaiting')}</p>
            )}
            <AdminButton
              variant="primary"
              fullWidth
              loading={mfaSubmitting}
              onClick={async () => {
                setMfaSubmitting(true)
                try {
                  const result = await loginWithPasskey(mfaChallengeToken || undefined)
                  if (result.user) {
                    justLoggedInRef.current = true
                  } else if (result.errorCode) {
                    setError(result.errorCode === 'PASSKEY_CANCELLED' ? '' : t('login.errors.serverError'))
                  }
                } catch {
                  setError(t('login.errors.serverError'))
                } finally {
                  setMfaSubmitting(false)
                }
              }}
            >
              {t('login.passkeyMfaButton')}
            </AdminButton>
          </div>
        )}

        {error && <Alert tone="error">{error}</Alert>}

        <AdminButton
          variant="ghost"
          fullWidth
          onClick={() => { setMfaRequired(false); setMfaCode(''); setMfaMethods([]); setError(''); setIsRecoveryCode(false) }}
        >
          {t('login.backToLogin')}
        </AdminButton>
      </CenteredCard>
    )
  }

  return (
    <CenteredCard>
      <PageHeader title={t('login.title')} description={t('login.description')} align="center" />

      <form className={auth.form} onSubmit={handleSubmit} noValidate>
        <TextField
          label={t('login.identifier')}
          type="text"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder={t('login.identifierPlaceholder')}
          autoFocus
          minLength={3}
          maxLength={254}
          autoComplete="username"
        />

        <div className={auth.fieldGroup}>
          <TextField
            label={t('login.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('login.passwordPlaceholder')}
            minLength={12}
            maxLength={128}
            autoComplete="current-password"
          />
          <div className={auth.forgotRow}>
            <Link to="/auth/password/forgot" className={auth.forgotLink}>{t('login.forgotPassword')}</Link>
          </div>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <AdminButton type="submit" variant="primary" fullWidth loading={submitting} disabled={!canSubmit}>
          {t('login.submit')}
        </AdminButton>
      </form>

      <p className={auth.aside}>
        {t('login.noAccount')}{' '}
        <Link to="/register-direct" className={auth.link}>{t('login.registerNow')}</Link>
      </p>

      <div className={auth.oauthSection}>
        <div className={auth.divider}>{t('login.oauthAlternative')}</div>
        <div className={auth.oauthRow}>
          <AdminButton type="button" variant="secondary" fullWidth onClick={loginWithGitHub}>{t('submit.loginWithGithub')}</AdminButton>
          <AdminButton type="button" variant="secondary" fullWidth onClick={loginWithX}>{t('submit.loginWithX')}</AdminButton>
          <AdminButton
            type="button"
            variant="secondary"
            fullWidth
            onClick={async () => {
              setSubmitting(true); setError('')
              try {
                const result = await loginWithPasskey()
                if (result.user) {
                  justLoggedInRef.current = true
                } else if (result.mfaChallengeToken) {
                  setMfaRequired(true)
                  setMfaChallengeToken(result.mfaChallengeToken)
                  setMfaMethods(result.mfaAvailableMethods || [])
                } else if (result.errorCode === 'PASSKEY_CANCELLED') {
                  // user cancelled
                } else {
                  setError(t('login.errors.serverError'))
                }
              } catch { setError(t('login.errors.serverError')) }
              finally { setSubmitting(false) }
            }}
          >
            {t('login.passkeyLogin')}
          </AdminButton>
          {iamEnabled && (
            <AdminButton type="button" variant="primary" fullWidth onClick={loginWithIam} aria-label={t('oauth.providerIam')}>
              {t('oauth.providerIam')}
            </AdminButton>
          )}
        </div>
      </div>
    </CenteredCard>
  )
}

/** 校验重定向 URL 防止开放重定向：仅允许站内相对路径 */
function isValidRedirect(url: string): boolean {
  if (!url.startsWith('/')) return false
  if (url.startsWith('//')) return false
  try {
    // 用 URL 确保不包含非法协议结构
    new URL(url, 'http://localhost')
    return true
  } catch {
    return false
  }
}
