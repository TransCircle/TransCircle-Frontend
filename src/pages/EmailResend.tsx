import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import styles from '../App.module.css'
import formStyles from '../components/Form.module.css'

export const EmailResend = () => {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!email.trim()) {
      setError(t('emailResend.errors.emailRequired'))
      return
    }
    setSubmitting(true)
    try {
      const result = await post('/auth/email/resend', { email: email.trim() }, { idempotent: true })
      if (result.ok) {
        setSuccess(true)
      } else {
        const code = result.error.code
        if (code === ERRORS.EMAIL_NOT_FOUND) setError(t('emailResend.emailNotFound'))
        else if (code === ERRORS.EMAIL_ALREADY_VERIFIED) setError(t('emailResend.alreadyVerified'))
        else setError(result.error.message || t('emailResend.error'))
      }
    } catch {
      setError(t('emailResend.error'))
    } finally {
      setSubmitting(false)
    }
  }

  if (success) {
    return (
      <main className={styles.standalonePage}>
        <h1 className={styles.statusSuccess} style={{ fontSize: '1.5rem' }}>{t('emailResend.success')}</h1>
          <Link to="/login" className={styles.accentLink} style={{ marginTop: '1rem' }}>
            {t('login.title')}
          </Link>
      </main>
    )
  }

  return (
    <>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>{t('emailResend.title')}</h1>
        <p className={styles.subTitle}>{t('emailResend.description')}</p>
      </header>
      <form className={formStyles.form} onSubmit={handleSubmit} noValidate>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('emailResend.email')}</span>
          <input className={formStyles.input} type="email" value={email}
            onChange={e => setEmail(e.target.value)} placeholder={t('emailResend.emailPlaceholder')}
            required autoFocus maxLength={254} aria-invalid={!!error} />
        </label>
        {error && <p className={formStyles.error} role="alert">{error}</p>}
        <button type="submit" disabled={submitting}
          className={`${styles.ctaPrimary} ${formStyles.submitBtn}`}>
          {submitting ? t('emailResend.submitting') : t('emailResend.submit')}
        </button>
      </form>
    </>
  )
}
