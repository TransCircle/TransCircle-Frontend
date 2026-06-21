import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import styles from '../App.module.css'

export const NotFound = () => {
  const { t } = useTranslation()

  return (
    <main className={styles.standalonePage}>
      <h1 style={{ fontSize: '4rem', margin: '0', color: 'var(--accent-pink)' }} aria-hidden="true">
        404
      </h1>
      <p
        role="alert"
        style={{ fontSize: '1.2rem', color: 'var(--text-secondary)', margin: '0.5rem 0 1.5rem' }}
      >
        {t('notFound.title')}
      </p>
      <Link
        to="/"
        className={styles.accentLink}
        aria-label={t('notFound.backToHome')}
      >
        ← {t('notFound.backToHome')}
      </Link>
    </main>
  )
}
