import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

export const NotFound = () => {
  const { t } = useTranslation()

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '50vh',
        textAlign: 'center',
        padding: '2rem',
      }}
    >
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
        to="/submit"
        style={{
          color: 'var(--accent-pink)',
          textDecoration: 'none',
          fontSize: '0.95rem',
          fontWeight: 500,
        }}
        aria-label={t('notFound.backToHome')}
      >
        ← {t('notFound.backToHome')}
      </Link>
    </main>
  )
}
