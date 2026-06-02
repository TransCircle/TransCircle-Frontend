import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { API_BASE } from '@/config'
import styles from '../App.module.css'
import formStyles from './Register.module.css'

export const Login = () => {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { loginWithPassword, loginWithGitHub, loginWithX } = useAuth()

  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // MFA state
  const [mfaRequired, setMfaRequired] = useState(false)
  const [mfaChallengeToken, setMfaChallengeToken] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaSubmitting, setMfaSubmitting] = useState(false)

  const canSubmit = useMemo(() => {
    return identifier.trim().length >= 3 && password.length >= 12
  }, [identifier, password])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim(), password }),
        credentials: 'include',
      })

      if (!res.ok) {
        const body = await res.json() as { error?: { code?: string; message?: string } }
        if (body.error?.code === 'ACCOUNT_BANNED') {
          setError(t('login.errors.banned'))
        } else if (body.error?.code === 'ACCOUNT_MERGED') {
          setError(t('login.errors.merged'))
        } else if (body.error?.code === 'ACCOUNT_PENDING_DELETION') {
          setError(t('login.errors.pendingDeletion'))
        } else {
          setError(body.error?.message || t('login.errors.invalidCredentials'))
        }
        return
      }

      const body = await res.json() as {
        data?: { mfaRequired?: boolean; mfaChallengeToken?: string; accessToken?: string; user?: Record<string, unknown> }
        requestId?: string
      }

      const d = body.data
      if (!d) { setError(t('login.errors.serverError')); return }

      if (d.mfaRequired) {
        setMfaRequired(true)
        setMfaChallengeToken(d.mfaChallengeToken || '')
        return
      }

      if (d.accessToken && d.user) {
        const user = await loginWithPassword(identifier.trim(), password)
        if (user) {
          navigate(user.roles.includes('reviewer') ? '/admin' : '/submit', { replace: true })
        } else {
          setError(t('login.errors.serverError'))
        }
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
      const res = await fetch(`${API_BASE}/auth/mfa/totp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mfaChallengeToken, code: mfaCode }),
      })

      if (!res.ok) {
        const body = await res.json() as { error?: { code?: string; message?: string } }
        setError(body.error?.message || t('login.errors.invalidCredentials'))
        return
      }

      const body = await res.json() as { data?: { accessToken?: string; user?: Record<string, unknown> } }
      if (body.data?.accessToken) {
        navigate('/submit', { replace: true })
      }
    } catch {
      setError(t('login.errors.serverError'))
    } finally {
      setMfaSubmitting(false)
    }
  }

  if (mfaRequired) {
    return (
      <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2rem' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>{t('login.mfaTitle')}</h1>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          {t('login.mfaDescription')}
        </p>
        <input
          type="text"
          inputMode="numeric"
          value={mfaCode}
          onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="123456"
          style={{ width: '200px', padding: '0.5rem', textAlign: 'center', fontSize: '1.2rem', letterSpacing: '0.5em' }}
          maxLength={6}
          autoFocus
        />
        {error && <p style={{ color: '#c62828', fontSize: '0.85rem', marginTop: '0.5rem' }}>{error}</p>}
        <button
          onClick={handleMfaSubmit}
          disabled={mfaSubmitting || mfaCode.length < 6}
          style={{ marginTop: '1rem', padding: '0.5rem 2rem', background: 'var(--accent-pink)', color: '#fff', border: 'none', borderRadius: '50px' }}
        >
          {mfaSubmitting ? t('login.submitting') : t('login.submit')}
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

      <div style={{
        marginTop: '2rem', paddingTop: '1.5rem',
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
        </div>
      </div>
    </>
  )
}
