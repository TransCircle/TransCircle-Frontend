import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import styles from './Admin.module.css'

/**
 * Route-level guard for admin-only sub-routes (users, audit-logs).
 * Blocks reviewers who pass through RequireAdminLayout.
 */
export const AdminOnlyGuard = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading } = useAuth()

  if (authLoading) {
    return (
      <main className={styles.container}>
        <div className={styles.loading}>{t('admin.verifying')}</div>
      </main>
    )
  }

  if (!user || !user.roles?.includes('admin')) {
    return (
      <main className={styles.container}>
        <h1 className={styles.heading}>{t('adminUsers.accessDenied')}</h1>
        <p className={styles.headingDesc}>{t('adminUsers.accessDeniedDetail')}</p>
      </main>
    )
  }

  return <Outlet />
}
