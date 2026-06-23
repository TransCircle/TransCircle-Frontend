import { useState, useMemo, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { get, clearCsrfToken } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { USERNAME_RE, checkPasswordStrength, validateEmail } from '@/utils/string'
import { computePermissions, landingPath } from '@/api/permissions'
import { AdminButton, Alert, CenteredCard, Checkbox, PageHeader, TextField } from '@/components/ui'
import auth from './Auth.module.css'

const Register = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { completeRegistration } = useAuth()

  const provider = searchParams.get('provider') || 'github'

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [suggestedEmail, setSuggestedEmail] = useState<string | null>(null)
  const [emailChangedConfirmed, setEmailChangedConfirmed] = useState(false)

  // Fetch OAuth pending profile to get suggested email for auto-detection
  useEffect(() => {
    const abortCtrl = new AbortController()
    const fetchProfile = async () => {
      try {
        const result = await get<{
          suggestedEmail?: string | null
          providerEmailVerified?: boolean
          mode?: string
        }>(`/auth/oauth/pending-profile?provider=${encodeURIComponent(provider)}`, { csrf: true, noAuth: true, signal: abortCtrl.signal })

        if (abortCtrl.signal.aborted) return
        if (result.ok) {
          // Per api.md §1.6.6: if mode is 'binding', redirect to binding page
          if (result.data.mode === 'binding') {
            navigate('/settings/security/oauth-bind/confirm?provider=' + encodeURIComponent(provider), { replace: true })
            return
          }
          if (result.data.suggestedEmail) {
            setSuggestedEmail(result.data.suggestedEmail)
            setEmail(result.data.suggestedEmail)
          }
        } else if (result.error.code === 'TOKEN_INVALID_OR_EXPIRED') {
          setError(t('register.errors.sessionExpired'))
        } else if (result.error.code === 'MISSING_OAUTH_PENDING') {
          setError(t('register.errors.sessionExpired'))
        } else if (result.error.code === 'CSRF_TOKEN_INVALID') {
          setError(t('register.errors.sessionExpired'))
        } else if (result.error.code === 'RATE_LIMITED') {
          setError(result.error.message || t('register.errors.failed'))
        }
      } catch {
        // AbortError on unmount — gracefully ignore (H2)
        if (!abortCtrl.signal.aborted) {
          setError(t('register.errors.failed'))
        }
      }
    }
    fetchProfile()
    return () => { abortCtrl.abort() }
  }, [provider, t, navigate])

  const fieldErrors = useMemo(() => {
    const errs: { username?: string; password?: string; email?: string; displayName?: string } = {}

    // 用户名验证：3-32 字符，小写字母开头，仅 [a-z0-9_-]
    if (!username.trim()) {
      errs.username = t('register.errors.usernameRequired')
    } else if (!USERNAME_RE.test(username.trim())) {
      errs.username = t('register.errors.usernameInvalid')
    }

    // 密码验证：12-128 字符，至少 3 类字符
    const pw = password || ''
    if (pw.length < 12 || pw.length > 128) {
      errs.password = t('register.errors.passwordLength')
    } else if (checkPasswordStrength(pw) < 3) {
      errs.password = t('register.errors.passwordStrength')
    } else {
      // api.md §1.1: password must not contain username or email local part
      const lowerPw = pw.toLowerCase()
      const u = username.trim()
      if (u && lowerPw.includes(u.toLowerCase())) {
        errs.password = t('register.errors.passwordContainsUsername')
      } else {
        const e = email.trim()
        if (e) {
          const emailLocal = e.split('@')[0]
          if (emailLocal && lowerPw.includes(emailLocal.toLowerCase())) {
            errs.password = t('register.errors.passwordContainsEmail')
          }
        }
      }
    }

    // 邮箱验证（api.md §1.6.4 要求必填）
    if (!email.trim()) {
      errs.email = t('register.errors.emailRequired')
    } else if (!validateEmail(email.trim())) {
      errs.email = t('register.errors.emailInvalid')
    }

    // 显示名称验证（api.md §1.6.4 要求 1-50 字符，必填）
    const dn = displayName.trim()
    if (!dn) {
      errs.displayName = t('register.errors.displayNameRequired')
    } else if (dn.length > 50) {
      errs.displayName = t('register.errors.displayNameTooLong')
    }

    return errs
  }, [username, password, email, displayName, t])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (Object.keys(fieldErrors).length > 0) {
      setError(t('register.errors.validationFailed'))
      return
    }

    const trimmedEmail = email.trim()
    if (suggestedEmail && trimmedEmail.toLowerCase() !== suggestedEmail.toLowerCase() && !emailChangedConfirmed) {
      setError(t('register.errors.emailChangeNotConfirmed'))
      return
    }

    setSubmitting(true)
    try {
      const emailMatchesProvider = !!(suggestedEmail && trimmedEmail.toLowerCase() === suggestedEmail.toLowerCase())

      const result = await completeRegistration(provider, {
        username: username.trim(),
        email: trimmedEmail,
        displayName: displayName.trim() || username.trim(),
        password,
        emailMatchesProvider,
      })

      if (result?.user) {
        clearCsrfToken()
        const perms = Array.isArray(result.user.permissions) ? result.user.permissions : computePermissions(result.user.roles ?? [])
        navigate(landingPath(perms), { replace: true })
      } else {
        const code = result?.errorCode
        if (code === ERRORS.USERNAME_TAKEN) setError(t('register.errors.usernameTaken'))
        else if (code === ERRORS.EMAIL_TAKEN) setError(t('register.errors.emailTaken'))
        else if (code === ERRORS.TOKEN_INVALID_OR_EXPIRED) setError(t('register.errors.sessionExpired'))
        else if (code === ERRORS.OAUTH_ALREADY_LINKED) setError(t('register.errors.oauthAlreadyLinked'))
        else if (code === ERRORS.VALIDATION_ERROR) setError(t('register.errors.validationFailed'))
        else if (code === ERRORS.MISSING_OAUTH_PENDING) setError(t('register.errors.sessionExpired'))
        else if (code === ERRORS.CSRF_TOKEN_INVALID) setError(t('register.errors.sessionExpired'))
        else if (code === ERRORS.RATE_LIMITED) setError(result?.errorMessage || t('register.errors.failed'))
        else setError(t('register.errors.failed'))
      }
    } catch {
      setError(t('register.errors.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  const providerLabel = provider === 'x' ? t('register.providerX') : t('register.providerGithub')

  const showEmailChange = !!suggestedEmail && email.trim().toLowerCase() !== suggestedEmail.toLowerCase() && !fieldErrors.email

  return (
    <CenteredCard>
      <PageHeader
        title={t('register.title')}
        description={t('register.description', { provider: providerLabel })}
        align="center"
      />

      <form className={auth.form} onSubmit={handleSubmit} noValidate>
        <TextField
          label={t('register.username')}
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('register.usernamePlaceholder')}
          autoFocus
          maxLength={32}
          autoComplete="username"
          invalid={!!fieldErrors.username}
          hint={fieldErrors.username || undefined}
        />

        <TextField
          label={t('register.password')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('register.passwordPlaceholder')}
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
          invalid={!!fieldErrors.password}
          hint={fieldErrors.password || undefined}
        />

        <TextField
          label={t('register.email')}
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setEmailChangedConfirmed(false) }}
          placeholder={t('register.emailPlaceholder')}
          maxLength={254}
          autoComplete="email"
          invalid={!!fieldErrors.email}
          hint={fieldErrors.email || undefined}
        />

        {showEmailChange && (
          <Alert tone="info">
            <span className={auth.infoStack}>
              <span>{t('register.emailChangeWarning', { suggested: suggestedEmail })}</span>
              <Checkbox
                label={t('register.emailChangeConfirm')}
                checked={emailChangedConfirmed}
                onChange={(e) => setEmailChangedConfirmed(e.target.checked)}
              />
            </span>
          </Alert>
        )}

        <TextField
          label={t('register.displayName')}
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t('register.displayNamePlaceholder')}
          maxLength={50}
          autoComplete="nickname"
          invalid={!!fieldErrors.displayName}
          hint={fieldErrors.displayName || undefined}
        />

        {error && <Alert tone="error">{error}</Alert>}

        <AdminButton type="submit" variant="primary" fullWidth loading={submitting}>
          {t('register.submit')}
        </AdminButton>
      </form>

      <p className={auth.aside}>
        {t('register.haveAccount')}{' '}
        <Link to="/login" className={auth.link}>{t('register.loginInstead')}</Link>
      </p>
    </CenteredCard>
  )
}

export { Register }

