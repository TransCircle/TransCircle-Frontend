import { useState, useMemo, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { get } from '@/api/client'
import { ERRORS } from '@/api/errors'
import styles from '../App.module.css'
import formStyles from './Register.module.css'

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
  // Tracks whether the OAuth provider has verified the user's email (e.g., GitHub verified=true)
  const [providerEmailVerified, setProviderEmailVerified] = useState(false)

  // Fetch OAuth pending profile to get suggested email for auto-detection
  useEffect(() => {
    const fetchProfile = async () => {
      const result = await get<{
        suggestedEmail?: string | null
        providerEmailVerified?: boolean
      }>(`/auth/oauth/pending-profile?provider=${encodeURIComponent(provider)}`, { csrf: true })

      if (result.ok) {
        if (result.data.suggestedEmail) {
          setSuggestedEmail(result.data.suggestedEmail)
          setEmail(result.data.suggestedEmail)
        }
        setProviderEmailVerified(result.data.providerEmailVerified ?? false)
      }
    }
    fetchProfile()
  }, [provider])

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

    setSubmitting(true)
    try {
      const trimmedEmail = email.trim()
      // emailMatchesProvider=true only if email matches AND provider has verified it
      const emailMatchesProvider = providerEmailVerified && !!(suggestedEmail && trimmedEmail.toLowerCase() === suggestedEmail.toLowerCase())

      const result = await completeRegistration(provider, {
        username: username.trim(),
        email: trimmedEmail,
        displayName: displayName.trim() || username.trim(),
        password,
        emailMatchesProvider,
      })

      if (result?.user) {
        navigate(result.user.roles.includes('reviewer') ? '/admin' : '/submit', { replace: true })
      } else {
        const code = result?.errorCode
        if (code === ERRORS.USERNAME_TAKEN) setError('该用户名已被占用，请换一个')
        else if (code === ERRORS.EMAIL_TAKEN) setError('该邮箱已被注册')
        else if (code === ERRORS.TOKEN_INVALID_OR_EXPIRED) setError('注册会话已过期，请重新发起 OAuth 登录')
        else if (code === ERRORS.VALIDATION_ERROR) setError('请检查输入信息')
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
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('register.emailPlaceholder')}
            required
            maxLength={254}
            aria-invalid={!!fieldErrors.email}
          />
          {fieldErrors.email && (
            <span className={formStyles.error} role="alert">{fieldErrors.email}</span>
          )}
        </label>

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
    </>
  )
}

export { Register }

