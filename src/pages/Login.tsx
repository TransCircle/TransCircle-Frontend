import { useState, useMemo, useEffect, useRef } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import styles from '../App.module.css'
import formStyles from './Register.module.css'

export const Login = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const { loginWithPassword, loginWithGitHub, loginWithX, loginWithPasskey, mfaVerify, user: authUser, loading: authLoading } = useAuth()
  const justLoggedInRef = useRef(false)

  // Navigate after auth context loads full profile (with roles) from /v1/me
  // 优先消费 ?redirect= 深链参数（从 RequireAdminLayout 等守卫跳转而来）
  useEffect(() => {
    if (justLoggedInRef.current && authUser && !authLoading) {
      justLoggedInRef.current = false
      const redirect = searchParams.get('redirect')
      if (redirect) {
        navigate(redirect, { replace: true })
        return
      }
      const isAdmin = authUser.roles?.includes('admin') || authUser.roles?.includes('reviewer')
      navigate(isAdmin ? '/admin' : '/submit', { replace: true })
    }
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
      <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2rem' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>{t('login.mfaTitle')}</h1>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          {t('login.mfaDescription')}
        </p>
        {hasTotp && (
          <input
            type="text"
            inputMode="text"
            value={mfaCode}
            onChange={(e) => {
              const raw = e.target.value.toUpperCase()
              if (/[A-Z-]/.test(raw)) {
                setMfaCode(raw.replace(/[^A-Z0-9-]/g, '').slice(0, 14))
              } else {
                setMfaCode(raw.replace(/\D/g, '').slice(0, 6))
              }
            }}
            placeholder={t('login.totpPlaceholder')}
            style={{ width: '200px', padding: '0.5rem', textAlign: 'center', fontSize: '1.2rem', letterSpacing: '0.5em' }}
            maxLength={14}
            autoFocus
          />
        )}
        {/* TOTP/recovery code confirm button */}
        {hasTotp && (
          <button
            onClick={handleMfaSubmit}
            disabled={mfaSubmitting || (mfaCode.length !== 6 && mfaCode.length !== 14)}
            style={{ marginTop: '1rem', padding: '0.5rem 2rem', background: 'var(--accent-pink)', color: '#fff', border: 'none', borderRadius: '50px' }}
          >
            {mfaSubmitting ? t('login.submitting') : t('login.submit')}
          </button>
        )}

        {hasPasskey && (
          <div style={{ textAlign: 'center', marginTop: '1rem', borderTop: hasTotp ? '1px solid var(--divider-color)' : 'none', paddingTop: hasTotp ? '1rem' : 0, width: '100%' }}>
            {hasTotp && <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{t('login.mfaOrPasskey')}</p>}
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
              {t('login.passkeyMfaDescription')}
            </p>
            <button
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
              disabled={mfaSubmitting}
              style={{ padding: '0.5rem 2rem', background: 'var(--accent-pink)', color: '#fff', border: 'none', borderRadius: '50px', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              {mfaSubmitting ? t('login.submitting') : t('login.passkeyMfaButton')}
            </button>
          </div>
        )}

        {error && <p style={{ color: 'var(--error-color)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{error}</p>}
        <button
          onClick={() => { setMfaRequired(false); setMfaCode(''); setMfaMethods([]); setError('') }}
          style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          {t('login.backToLogin')}
        </button>
      </main>
    )
  }

  return (
    <>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>{t('login.title')}</h1>
        <p className={styles.subTitle}>{t('login.description')}</p>
      </header>

      <form className={formStyles.form} onSubmit={handleSubmit} noValidate>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('login.identifier')}</span>
          <input
            className={formStyles.input}
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={t('login.identifierPlaceholder')}
            required
            autoFocus
            minLength={3}
            maxLength={254}
          />
        </label>

        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('login.password')}</span>
          <input
            className={formStyles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('login.passwordPlaceholder')}
            required
            minLength={12}
            maxLength={128}
          />
          <div style={{ textAlign: 'right', marginTop: '0.25rem' }}>
            <Link to="/auth/password/forgot" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {t('login.forgotPassword')}
            </Link>
          </div>
        </label>

        {error && <p className={formStyles.error} role="alert">{error}</p>}

        <button
          type="submit"
          disabled={!canSubmit || submitting}
          className={`${styles.ctaPrimary} ${formStyles.submitBtn}`}
        >
          {submitting ? t('login.submitting') : t('login.submit')}
        </button>
      </form>

      <p style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.85rem' }}>
        {t('login.noAccount')}{' '}
        <Link to="/register-direct" style={{ color: 'var(--accent-pink)' }}>{t('login.registerNow')}</Link>
      </p>

      <div style={{
        marginTop: '1.5rem', paddingTop: '1.5rem',
        borderTop: '1px solid var(--divider-color)', textAlign: 'center',
      }}>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
          {t('login.oauthAlternative')}
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
          <button type="button" onClick={loginWithGitHub} style={{
            background: 'none', border: '1px solid var(--primary-pink)',
            color: 'var(--primary-pink)', padding: '0.4rem 1rem', borderRadius: '50px',
            fontSize: '0.85rem', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
          }}>{t('submit.loginWithGithub')}</button>
          <button type="button" onClick={loginWithX} style={{
            background: 'none', border: '1px solid var(--primary-pink)',
            color: 'var(--primary-pink)', padding: '0.4rem 1rem', borderRadius: '50px',
            fontSize: '0.85rem', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
          }}>{t('submit.loginWithX')}</button>
          <button type="button" onClick={async () => {
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
          }} style={{
            background: 'none', border: '1px solid var(--primary-pink)',
            color: 'var(--primary-pink)', padding: '0.4rem 1rem', borderRadius: '50px',
            fontSize: '0.85rem', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
          }}>{t('login.passkeyLogin')}</button>
        </div>
      </div>
    </>
  )
}
