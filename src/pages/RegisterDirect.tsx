import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { post, setIntentKey, newIdempotencyKey } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { USERNAME_RE, checkPasswordStrength, validateEmail } from '@/utils/string'
import { AdminButton, Alert, CenteredCard, PageHeader, StatusScreen, TextField } from '@/components/ui'
import auth from './Auth.module.css'

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
      if (username.trim() && lowerPw.includes(username.trim().toLowerCase())) errs.password = t('registerDirect.errors.passwordContainsUsername')
      else if (email.trim()) {
        const emailLocal = email.trim().split('@')[0]
        if (emailLocal && lowerPw.includes(emailLocal.toLowerCase())) errs.password = t('registerDirect.errors.passwordContainsEmail')
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
      setIntentKey(newIdempotencyKey())  // Per-intent idempotency-key (M9)
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
          setError(t('registerDirect.errors.usernameTaken'))
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
      <StatusScreen
        kind="success"
        title={t('registerDirect.success')}
        description={t('registerDirect.successHint')}
        actions={[{ label: t('registerDirect.goToLogin'), to: '/login' }]}
      />
    )
  }

  return (
    <CenteredCard>
      <PageHeader title={t('registerDirect.title')} description={t('registerDirect.description')} align="center" />
      <form className={auth.form} onSubmit={handleSubmit} noValidate>
        <TextField
          label={t('registerDirect.username')}
          type="text"
          value={username}
          onChange={handleFieldChange('username', setUsername)}
          placeholder={t('registerDirect.usernamePlaceholder')}
          autoFocus
          maxLength={32}
          autoComplete="username"
          invalid={!!allFieldErrors.username}
          hint={allFieldErrors.username || undefined}
        />
        <TextField
          label={t('registerDirect.email')}
          type="email"
          value={email}
          onChange={handleFieldChange('email', setEmail)}
          placeholder={t('registerDirect.emailPlaceholder')}
          maxLength={254}
          autoComplete="email"
          invalid={!!allFieldErrors.email}
          hint={allFieldErrors.email || undefined}
        />
        <TextField
          label={t('registerDirect.password')}
          type="password"
          value={password}
          onChange={handleFieldChange('password', setPassword)}
          placeholder={t('registerDirect.passwordPlaceholder')}
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
          invalid={!!allFieldErrors.password}
          hint={allFieldErrors.password || undefined}
        />
        <TextField
          label={t('registerDirect.displayName')}
          type="text"
          value={displayName}
          onChange={handleFieldChange('displayName', setDisplayName)}
          placeholder={t('registerDirect.displayNamePlaceholder')}
          maxLength={50}
          autoComplete="nickname"
          invalid={!!allFieldErrors.displayName}
          hint={allFieldErrors.displayName || undefined}
        />
        {error && <Alert tone="error">{error}</Alert>}
        <AdminButton type="submit" variant="primary" fullWidth loading={submitting}>
          {t('registerDirect.submit')}
        </AdminButton>
      </form>
    </CenteredCard>
  )
}

