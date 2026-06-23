import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { AdminButton, Alert, CenteredCard, PageHeader, StatusScreen, TextField } from '@/components/ui'
import auth from './Auth.module.css'

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
      <StatusScreen
        kind="success"
        title={t('emailResend.success')}
        actions={[{ label: t('login.title'), to: '/login' }]}
      />
    )
  }

  return (
    <CenteredCard>
      <PageHeader title={t('emailResend.title')} description={t('emailResend.description')} align="center" />
      <form className={auth.form} onSubmit={handleSubmit} noValidate>
        <TextField
          label={t('emailResend.email')}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('emailResend.emailPlaceholder')}
          autoFocus
          maxLength={254}
          autoComplete="email"
          invalid={!!error}
        />
        {error && <Alert tone="error">{error}</Alert>}
        <AdminButton type="submit" variant="primary" fullWidth loading={submitting}>
          {t('emailResend.submit')}
        </AdminButton>
      </form>
    </CenteredCard>
  )
}
