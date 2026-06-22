import { useEffect } from 'react'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import styles from '../App.module.css'

/**
 * Cancel account deletion page (api.md §2.5).
 * Reads cancelToken from email link query param, immediately redirects to
 * the security settings page where the cancel form lives.  The token is
 * passed via router state so SettingsSecurity can auto-fill the field
 * instead of requiring the user to re-enter it manually (C1).
 */
export const CancelDeletion = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const tokenFromUrl = searchParams.get('token') || ''

  useEffect(() => {
    if (tokenFromUrl) {
      navigate('/settings/security?tab=profile', {
        replace: true,
        state: { cancelToken: tokenFromUrl },
      })
    }
  }, [tokenFromUrl, navigate])

  return (
    <main className={styles.standalonePage} style={{ maxWidth: '600px', margin: '0 auto' }}>
      <header className={styles.contentHeader}>
        <h1 className={styles.mainTitle}>{t('settings.cancelDeletionHeading')}</h1>
      </header>

      {tokenFromUrl ? (
        <div>
          <p className={styles.statusMuted}>
            {t('settings.cancelDeletionDescription')}
          </p>
          <p className={styles.statusMuted} style={{ marginBottom: '1rem' }}>
            {t('common.loading')}
          </p>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            <Link to="/settings/security" className={styles.accentLink}>
              {t('common.backToHome')}
            </Link>
          </p>
        </div>
      ) : (
        <div>
          <p className={styles.statusMuted}>
            {t('settings.cancelDeletionDescription')}
          </p>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            <Link to="/settings/security" className={styles.accentLink}>
              {t('common.backToHome')}
            </Link>
          </p>
        </div>
      )}
    </main>
  )
}
