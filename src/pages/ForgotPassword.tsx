import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import styles from '../App.module.css'
import formStyles from '../components/Form.module.css'

export const ForgotPassword = () => {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!email.trim()) {
      setError(t('forgotPassword.errors.emailRequired'))
      return
    }
    setSubmitting(true)
    try {
      const result = await post('/auth/password/forgot', { email: email.trim() })
      if (result.ok) {
        setSuccess(true)
      } else {
        const code = result.error.code
        if (code === ERRORS.EMAIL_NOT_FOUND) setError(t('forgotPassword.emailNotFound'))
        else if (code === ERRORS.ACCOUNT_BANNED) setError(t('forgotPassword.accountBanned'))
        else setError(result.error.message || t('forgotPassword.error'))
      }
    } catch {
      setError(t('forgotPassword.error'))
    } finally {
      setSubmitting(false)
    }
  }

  if (success) {
    return (
      <main className={styles.standalonePage}>
        <h1 className={styles.statusSuccess} style={{ fontSize: '1.5rem' }}>{t('forgotPassword.success')}</h1>
          <Link to="/login" className={styles.accentLink} style={{ marginTop: '1rem' }}>
            {t('common.backToLogin')}
          </Link>
      </main>
    )
  }

  return (
    <>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>{t('forgotPassword.title')}</h1>
        <p className={styles.subTitle}>{t('forgotPassword.description')}</p>
      </header>
      <form className={formStyles.form} onSubmit={handleSubmit} noValidate>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('forgotPassword.email')}</span>
          <input className={formStyles.input} type="email" value={email}
            onChange={e => setEmail(e.target.value)} placeholder={t('forgotPassword.emailPlaceholder')}
            required autoFocus maxLength={254} />
        </label>
        {error && <p className={formStyles.error} role="alert">{error}</p>}
        <button type="submit" disabled={submitting}
          className={`${styles.ctaPrimary} ${formStyles.submitBtn}`}>
          {submitting ? t('forgotPassword.submitting') : t('forgotPassword.submit')}
        </button>
        <p style={{ textAlign: 'center', marginTop: '0.75rem', fontSize: '0.85rem' }}>
          <Link to="/login" style={{ color: 'var(--text-muted)' }}>{t('common.backToLogin')}</Link>
        </p>
      </form>
    </>
  )
}
