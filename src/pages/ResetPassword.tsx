import { useState, useMemo } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import styles from '../App.module.css'
import formStyles from './Register.module.css'

const UPPER_RE = /[A-Z]/
const LOWER_RE = /[a-z]/
const DIGIT_RE = /\d/
const SYMBOL_RE = /[!-/:-@[-`{-~]|[\p{P}\p{S}]/u

function checkStrength(pw: string): number {
  let s = 0
  if (UPPER_RE.test(pw)) s++
  if (LOWER_RE.test(pw)) s++
  if (DIGIT_RE.test(pw)) s++
  if (SYMBOL_RE.test(pw)) s++
  return s
}

export const ResetPassword = () => {
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const token = searchParams.get('token') || ''
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  const pwError = useMemo(() => {
    if (!newPassword) return ''
    if (newPassword.length < 12 || newPassword.length > 128) return t('registerDirect.errors.passwordLength')
    if (checkStrength(newPassword) < 3) return t('registerDirect.errors.passwordStrength')
    return ''
  }, [newPassword, t])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!token) {
      setError(t('resetPassword.tokenInvalid'))
      return
    }
    if (pwError) {
      setError(t('resetPassword.validationError'))
      return
    }
    setSubmitting(true)
    try {
      const result = await post('/auth/password/reset', { token, newPassword })
      if (result.ok) {
        setSuccess(true)
      } else {
        const code = result.error.code
        if (code === ERRORS.TOKEN_INVALID_OR_EXPIRED) setError(t('resetPassword.tokenInvalid'))
        else if (code === ERRORS.VALIDATION_ERROR) setError(t('resetPassword.validationError'))
        else setError(result.error.message || t('resetPassword.error'))
      }
    } catch {
      setError(t('resetPassword.error'))
    } finally {
      setSubmitting(false)
    }
  }

  if (success) {
    return (
      <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem', color: 'var(--success-color)' }}>{t('resetPassword.success')}</h1>
        <Link to="/login" style={{ marginTop: '1rem', color: 'var(--accent-pink)' }}>{t('emailVerify.redirectToLogin')}</Link>
      </main>
    )
  }

  return (
    <>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>{t('resetPassword.title')}</h1>
        <p className={styles.subTitle}>{t('resetPassword.description')}</p>
      </header>
      <form className={formStyles.form} onSubmit={handleSubmit} noValidate>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('resetPassword.newPassword')}</span>
          <input className={formStyles.input} type="password" value={newPassword}
            onChange={e => setNewPassword(e.target.value)} placeholder={t('resetPassword.newPasswordPlaceholder')}
            required minLength={12} maxLength={128} autoFocus aria-invalid={!!pwError} />
          {pwError && <span className={formStyles.error} role="alert">{pwError}</span>}
        </label>
        {error && <p className={formStyles.error} role="alert">{error}</p>}
        <button type="submit" disabled={submitting || !newPassword || !!pwError}
          className={`${styles.ctaPrimary} ${formStyles.submitBtn}`}>
          {submitting ? t('resetPassword.submitting') : t('resetPassword.submit')}
        </button>
      </form>
    </>
  )
}
