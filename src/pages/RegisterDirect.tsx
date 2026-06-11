import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post, setIntentKey } from '@/api/client'
import { ERRORS } from '@/api/errors'
import styles from '../App.module.css'
import formStyles from './Register.module.css'

const USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/
const UPPER_RE = /[A-Z]/
const LOWER_RE = /[a-z]/
const DIGIT_RE = /\d/
const SYMBOL_RE = /[!-/:-@[-`{-~]|[\p{P}\p{S}]/u

function checkPasswordStrength(pw: string): number {
  let s = 0
  if (UPPER_RE.test(pw)) s++
  if (LOWER_RE.test(pw)) s++
  if (DIGIT_RE.test(pw)) s++
  if (SYMBOL_RE.test(pw)) s++
  return s
}

function validateEmail(email: string): boolean {
  const parts = email.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  if (!local || !domain) return false
  if (email.length > 254) return false
  return true
}

export const RegisterDirect = () => {
  const { t } = useTranslation()

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  const fieldErrors = useMemo(() => {
    const errs: Record<string, string> = {}
    if (!username.trim()) errs.username = t('registerDirect.errors.usernameRequired')
    else if (!USERNAME_RE.test(username.trim())) errs.username = t('registerDirect.errors.usernameInvalid')
    if (!email.trim()) errs.email = t('registerDirect.errors.emailRequired')
    else if (!validateEmail(email.trim())) errs.email = t('registerDirect.errors.emailInvalid')
    const pw = password || ''
    if (pw.length < 12 || pw.length > 128) errs.password = t('registerDirect.errors.passwordLength')
    else if (checkPasswordStrength(pw) < 3) errs.password = t('registerDirect.errors.passwordStrength')
    else {
      // api.md §1.1: password must not contain username or email local part (case-insensitive)
      const lowerPw = pw.toLowerCase()
      if (username.trim() && lowerPw.includes(username.trim().toLowerCase())) errs.password = t('registerDirect.errors.passwordContainsUsername') || '密码不能包含用户名'
      else if (email.trim()) {
        const emailLocal = email.trim().split('@')[0]
        if (emailLocal && lowerPw.includes(emailLocal.toLowerCase())) errs.password = t('registerDirect.errors.passwordContainsEmail') || '密码不能包含邮箱地址'
      }
    }
    if (!displayName.trim()) errs.displayName = t('registerDirect.errors.displayNameRequired')
    else if (displayName.trim().length > 50) errs.displayName = t('registerDirect.errors.displayNameTooLong')
    return errs
  }, [username, email, password, displayName, t])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (Object.keys(fieldErrors).length > 0) {
      setError(t('registerDirect.errors.validationFailed'))
      return
    }
    setSubmitting(true)
    try {
      setIntentKey(crypto.randomUUID())  // Per-intent idempotency-key (M9)
      const result = await post('/auth/register', {
        username: username.trim(),
        email: email.trim(),
        password,
        displayName: displayName.trim(),
      }, { idempotent: true })

      if (!result.ok) {
        const code = result.error.code
        if (code === ERRORS.USERNAME_TAKEN) setError(t('registerDirect.errors.usernameTaken'))
        else if (code === ERRORS.EMAIL_TAKEN) setError(t('registerDirect.errors.emailTaken'))
        else setError(result.error.message || t('registerDirect.errors.failed'))
        return
      }

      setSuccess(true)
      setIntentKey(null)
    } catch {
      setError(t('registerDirect.errors.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  if (success) {
    return (
      <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem', color: 'var(--text-main)' }}>{t('registerDirect.success')}</h1>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
          {t('emailVerify.redirectToLogin')}
        </p>
        <Link to="/login" style={{ marginTop: '1rem', color: 'var(--accent-pink)' }}>{t('emailVerify.redirectToLogin')}</Link>
      </main>
    )
  }

  return (
    <>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>{t('registerDirect.title')}</h1>
        <p className={styles.subTitle}>{t('registerDirect.description')}</p>
      </header>
      <form className={formStyles.form} onSubmit={handleSubmit} noValidate>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('registerDirect.username')}</span>
          <input className={formStyles.input} type="text" value={username}
            onChange={e => setUsername(e.target.value)} placeholder={t('registerDirect.usernamePlaceholder')}
            required autoFocus maxLength={32} aria-invalid={!!fieldErrors.username} />
          {fieldErrors.username && <span className={formStyles.error} role="alert">{fieldErrors.username}</span>}
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('registerDirect.email')}</span>
          <input className={formStyles.input} type="email" value={email}
            onChange={e => setEmail(e.target.value)} placeholder={t('registerDirect.emailPlaceholder')}
            required maxLength={254} aria-invalid={!!fieldErrors.email} />
          {fieldErrors.email && <span className={formStyles.error} role="alert">{fieldErrors.email}</span>}
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('registerDirect.password')}</span>
          <input className={formStyles.input} type="password" value={password}
            onChange={e => setPassword(e.target.value)} placeholder={t('registerDirect.passwordPlaceholder')}
            required minLength={12} maxLength={128} aria-invalid={!!fieldErrors.password} />
          {fieldErrors.password && <span className={formStyles.error} role="alert">{fieldErrors.password}</span>}
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('registerDirect.displayName')}</span>
          <input className={formStyles.input} type="text" value={displayName}
            onChange={e => setDisplayName(e.target.value)} placeholder={t('registerDirect.displayNamePlaceholder')}
            required maxLength={50} aria-invalid={!!fieldErrors.displayName} />
          {fieldErrors.displayName && <span className={formStyles.error} role="alert">{fieldErrors.displayName}</span>}
        </label>
        {error && <p className={formStyles.error} role="alert">{error}</p>}
        <button type="submit" disabled={submitting}
          className={`${styles.ctaPrimary} ${formStyles.submitBtn}`}>
          {submitting ? t('registerDirect.submitting') : t('registerDirect.submit')}
        </button>
      </form>
    </>
  )
}

