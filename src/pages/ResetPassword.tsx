import { useState, useMemo } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post } from '@/api/client'
import styles from '../App.module.css'
import { ERRORS } from '@/api/errors'
import { checkPasswordStrength } from '@/utils/string'
import styles from '../App.module.css'
import formStyles from '../components/Form.module.css'

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
    if (checkPasswordStrength(newPassword) < 3) return t('registerDirect.errors.passwordStrength')
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
      <main className={styles.standalonePage}>
        <h1 className={styles.statusSuccess} style={{ fontSize: '1.5rem' }}>{t('resetPassword.success')}</h1>
        <Link to="/login" className={styles.accentLink} style={{ marginTop: '1rem' }}>{t('emailVerify.redirectToLogin')}</Link>
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
