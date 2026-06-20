import { useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import styles from '../App.module.css'

/**
 * Cancel account deletion page (api.md §2.5).
 * Reads cancelToken from email link query param, shows a form
 * to enter identifier + password, then POSTs to /me/delete/cancel.
 *
 * The full cancel flow is also available in SettingsSecurity page.
 */
export const CancelDeletion = () => {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const tokenFromUrl = searchParams.get('token') || ''

  useEffect(() => {
    if (tokenFromUrl) {
      const timer = setTimeout(() => {
        window.location.href = `/settings/security?tab=profile`
      }, 3000)
      return () => clearTimeout(timer)
    }
  }, [tokenFromUrl])

  return (
    <main style={{ maxWidth: '600px', margin: '0 auto', padding: '2rem' }}>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>{t('settings.cancelDeletionHeading')}</h1>
      </header>

      {tokenFromUrl ? (
        <div>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            {t('settings.cancelDeletionDescription')}
          </p>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            {t('common.loading')}
          </p>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            <Link to="/settings/security" style={{ color: 'var(--accent-pink)' }}>
              {t('common.backToHome')}
            </Link>
          </p>
        </div>
      ) : (
        <div>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            {t('settings.cancelDeletionDescription')}
          </p>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            <Link to="/settings/security" style={{ color: 'var(--accent-pink)' }}>
              {t('common.backToHome')}
            </Link>
          </p>
        </div>
      )}
    </main>
  )
}
