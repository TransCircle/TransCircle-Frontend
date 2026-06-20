import { useState, useMemo, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { get, clearCsrfToken } from '@/api/client'
import { ERRORS } from '@/api/errors'
import styles from '../App.module.css'
import formStyles from '../components/Form.module.css'

// 用户名：3-32 字符，小写字母开头，仅允许小写字母/数字/下划线/短横线
const USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/

// 密码强度检查：至少满足 4 类中的 3 类
const UPPER_RE = /[A-Z]/
const LOWER_RE = /[a-z]/
const DIGIT_RE = /\d/
// ASCII 标点或 Unicode 标点（\p{P}）
const SYMBOL_RE = /[!-/:-@[-`{-~]|[\p{P}\p{S}]/u

function checkPasswordStrength(password: string): number {
  let score = 0
  if (UPPER_RE.test(password)) score++
  if (LOWER_RE.test(password)) score++
  if (DIGIT_RE.test(password)) score++
  if (SYMBOL_RE.test(password)) score++
  return score
}

function validateEmail(email: string): boolean {
  // 简单 RFC 5322 近似校验
  const parts = email.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  if (!local || !domain) return false
  if (local.length > 64) return false
  if (email.length > 254) return false
  const domainRe = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/
  if (!domainRe.test(domain)) return false
  return true
}

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
    const fetchProfile = async () => {
      const result = await get<{
        suggestedEmail?: string | null
        providerEmailVerified?: boolean
        mode?: string
      }>(`/auth/oauth/pending-profile?provider=${encodeURIComponent(provider)}`, { csrf: true, noAuth: true })

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
    }
    fetchProfile()
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
        navigate((result.user.roles.includes('admin') || result.user.roles.includes('reviewer')) ? '/admin' : '/submit', { replace: true })
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

  return (
    <>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>{t('register.title')}</h1>
        <p className={styles.subTitle}>
          {t('register.description', { provider: providerLabel })}
        </p>
      </header>

      <form className={formStyles.form} onSubmit={handleSubmit} noValidate>
        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('register.username')}</span>
          <input
            className={formStyles.input}
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('register.usernamePlaceholder')}
            required
            autoFocus
            maxLength={32}
            aria-invalid={!!fieldErrors.username}
          />
          {fieldErrors.username && (
            <span className={formStyles.error} role="alert">{fieldErrors.username}</span>
          )}
        </label>

        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('register.password')}</span>
          <input
            className={formStyles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('register.passwordPlaceholder')}
            required
            minLength={12}
            maxLength={128}
            aria-invalid={!!fieldErrors.password}
          />
          {fieldErrors.password && (
            <span className={formStyles.error} role="alert">{fieldErrors.password}</span>
          )}
        </label>

        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('register.email')}</span>
          <input
            className={formStyles.input}
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setEmailChangedConfirmed(false) }}
            placeholder={t('register.emailPlaceholder')}
            required
            maxLength={254}
            aria-invalid={!!fieldErrors.email}
          />
          {fieldErrors.email && (
            <span className={formStyles.error} role="alert">{fieldErrors.email}</span>
          )}
        </label>
        {suggestedEmail && email.trim().toLowerCase() !== suggestedEmail.toLowerCase() && !fieldErrors.email && (
          <div style={{
            background: 'var(--hover-bg)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)',
            marginBottom: '0.75rem', fontSize: '0.85rem',
          }}>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>
              {t('register.emailChangeWarning', { suggested: suggestedEmail })}
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={emailChangedConfirmed}
                onChange={(e) => setEmailChangedConfirmed(e.target.checked)}
              />
              <span>{t('register.emailChangeConfirm')}</span>
            </label>
          </div>
        )}

        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('register.displayName')}</span>
          <input
            className={formStyles.input}
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('register.displayNamePlaceholder')}
            required
            maxLength={50}
            aria-invalid={!!fieldErrors.displayName}
          />
          {fieldErrors.displayName && (
            <span className={formStyles.error} role="alert">{fieldErrors.displayName}</span>
          )}
        </label>

        {error && (
          <p className={formStyles.error} role="alert">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className={`${styles.ctaPrimary} ${formStyles.submitBtn}`}
        >
          {submitting ? t('register.submitting') : t('register.submit')}
        </button>
      </form>

      <p style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.85rem' }}>
        {t('register.haveAccount')}{' '}
        <Link to="/login" style={{ color: 'var(--accent-pink)' }}>{t('register.loginInstead')}</Link>
      </p>
    </>
  )
}

export { Register }

