import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import styles from '../App.module.css'
import formStyles from './Register.module.css'

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!username.trim()) {
      setError(t('register.errors.usernameRequired'))
      return
    }
    if (!password || password.length < 12) {
      setError(t('register.errors.passwordTooShort'))
      return
    }

    setSubmitting(true)
    try {
      const result = await completeRegistration(provider, {
        username: username.trim(),
        email: email.trim(),
        displayName: displayName.trim() || username.trim(),
        password,
        emailMatchesProvider: false,
      })

      if (result?.user) {
        navigate(result.user.isAdmin ? '/admin' : '/submit', { replace: true })
      } else {
        setError(t('register.errors.failed'))
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
          />
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
            minLength={8}
          />
        </label>

        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('register.email')}</span>
          <input
            className={formStyles.input}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('register.emailPlaceholder')}
          />
        </label>

        <label className={formStyles.field}>
          <span className={formStyles.label}>{t('register.displayName')}</span>
          <input
            className={formStyles.input}
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('register.displayNamePlaceholder')}
          />
        </label>

        {error && (
          <p className={formStyles.error}>{error}</p>
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
