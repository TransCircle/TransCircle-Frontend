import { useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { checkPasswordStrength } from '@/utils/string'
import { AdminButton, Alert, CenteredCard, PageHeader, StatusScreen, TextField } from '@/components/ui'
import auth from './Auth.module.css'

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
      <StatusScreen
        kind="success"
        title={t('resetPassword.success')}
        actions={[{ label: t('emailVerify.redirectToLogin'), to: '/login' }]}
      />
    )
  }

  return (
    <CenteredCard>
      <PageHeader title={t('resetPassword.title')} description={t('resetPassword.description')} align="center" />
      <form className={auth.form} onSubmit={handleSubmit} noValidate>
        <TextField
          label={t('resetPassword.newPassword')}
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder={t('resetPassword.newPasswordPlaceholder')}
          autoFocus
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
          invalid={!!pwError}
          hint={pwError || undefined}
        />
        {error && <Alert tone="error">{error}</Alert>}
        <AdminButton type="submit" variant="primary" fullWidth loading={submitting} disabled={!newPassword || !!pwError}>
          {t('resetPassword.submit')}
        </AdminButton>
      </form>
    </CenteredCard>
  )
}
