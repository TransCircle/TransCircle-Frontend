import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { AdminButton, Alert, CenteredCard, PageHeader, StatusScreen, TextField } from '@/components/ui'
import auth from './Auth.module.css'

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
      <StatusScreen
        kind="success"
        title={t('forgotPassword.success')}
        actions={[{ label: t('common.backToLogin'), to: '/login' }]}
      />
    )
  }

  return (
    <CenteredCard>
      <PageHeader title={t('forgotPassword.title')} description={t('forgotPassword.description')} align="center" />
      <form className={auth.form} onSubmit={handleSubmit} noValidate>
        <TextField
          label={t('forgotPassword.email')}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('forgotPassword.emailPlaceholder')}
          autoFocus
          maxLength={254}
          autoComplete="email"
          invalid={!!error}
        />
        {error && <Alert tone="error">{error}</Alert>}
        <AdminButton type="submit" variant="primary" fullWidth loading={submitting}>
          {t('forgotPassword.submit')}
        </AdminButton>
      </form>
      <p className={auth.aside}>
        <Link to="/login" className={auth.link}>{t('common.backToLogin')}</Link>
      </p>
    </CenteredCard>
  )
}
