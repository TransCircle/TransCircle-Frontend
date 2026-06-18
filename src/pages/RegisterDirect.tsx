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
  // 服务端返回的字段级错误（L8）
  const [serverFieldErrors, setServerFieldErrors] = useState<Record<string, string>>({})

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

  // 合并客户端 + 服务端字段错误（服务端优先覆盖）
  const allFieldErrors = useMemo(() => ({
    ...fieldErrors,
    ...serverFieldErrors,
  }), [fieldErrors, serverFieldErrors])

  // 用户编辑字段时清除该字段的服务端错误
  const handleFieldChange = (field: string, setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setter(e.target.value)
    if (serverFieldErrors[field]) {
      setServerFieldErrors(prev => {
        const next = { ...prev }
        delete next[field]
        return next
      })
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (Object.keys(allFieldErrors).length > 0) {
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
        const nextAction = result.error.data?.nextAction as string | undefined
        if (code === ERRORS.USERNAME_TAKEN) {
          if (nextAction === 'choose_other_username') setError(t('registerDirect.errors.usernameTaken'))
          else setError(t('registerDirect.errors.usernameTaken'))
        } else if (code === ERRORS.EMAIL_TAKEN) {
          if (nextAction === 'password_forgot') setError(t('registerDirect.errors.emailTaken') + ' ' + t('registerDirect.errors.tryForgotPassword'))
          else if (nextAction === 'try_login') setError(t('registerDirect.errors.emailTaken') + ' ' + t('registerDirect.errors.tryLogin'))
          else setError(t('registerDirect.errors.emailTaken'))
        } else if (code === ERRORS.VALIDATION_ERROR && result.error.details) {
          // 映射服务端字段错误到表单字段（L8）
          const newFieldErrors: Record<string, string> = {}
          let genericMsg = ''
          for (const d of result.error.details) {
            if (['username', 'email', 'password', 'displayName'].includes(d.field)) {
              newFieldErrors[d.field] = d.reason
            } else {
              genericMsg += (genericMsg ? '；' : '') + `${d.field}: ${d.reason}`
            }
          }
          setServerFieldErrors(newFieldErrors)
          setError(genericMsg || result.error.message || t('registerDirect.errors.validationFailed'))
        } else if (code === ERRORS.RATE_LIMITED) {
          setError(result.error.message || t('registerDirect.errors.failed'))
        } else setError(result.error.message || t('registerDirect.errors.failed'))
        return
      }

      setSuccess(true)
    } catch {
      setError(t('registerDirect.errors.failed'))
    } finally {
      setIntentKey(null)
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
            onChange={handleFieldChange('username', setUsername)} placeholder={t('registerDirect.usernamePlaceholder')}
            required autoFocus maxLength={32} aria-invalid={!!allFieldErrors.username} />
          {allFieldErrors.username && <span className={formStyles.error} role="alert">{allFieldErrors.username}</span>}
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('registerDirect.email')}</span>
          <input className={formStyles.input} type="email" value={email}
            onChange={handleFieldChange('email', setEmail)} placeholder={t('registerDirect.emailPlaceholder')}
            required maxLength={254} aria-invalid={!!allFieldErrors.email} />
          {allFieldErrors.email && <span className={formStyles.error} role="alert">{allFieldErrors.email}</span>}
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('registerDirect.password')}</span>
          <input className={formStyles.input} type="password" value={password}
            onChange={handleFieldChange('password', setPassword)} placeholder={t('registerDirect.passwordPlaceholder')}
            required minLength={12} maxLength={128} aria-invalid={!!allFieldErrors.password} />
          {allFieldErrors.password && <span className={formStyles.error} role="alert">{allFieldErrors.password}</span>}
        </label>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('registerDirect.displayName')}</span>
          <input className={formStyles.input} type="text" value={displayName}
            onChange={handleFieldChange('displayName', setDisplayName)} placeholder={t('registerDirect.displayNamePlaceholder')}
            required maxLength={50} aria-invalid={!!allFieldErrors.displayName} />
          {allFieldErrors.displayName && <span className={formStyles.error} role="alert">{allFieldErrors.displayName}</span>}
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

