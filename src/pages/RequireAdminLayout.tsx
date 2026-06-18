import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import styles from './Admin.module.css'

export const RequireAdminLayout = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading } = useAuth()
  const location = useLocation()

  if (authLoading) {
    return (
      <main className={styles.container}>
        <div className={styles.loading}>{t('admin.verifying')}</div>
      </main>
    )
  }

  if (!user) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />
  }

  if (!user.roles?.includes('admin')) {
    return (
      <main className={styles.container}>
        <h1 className={styles.heading}>{t('admin.accessDenied')}</h1>
        <p className={styles.headingDesc}>{t('admin.accessDeniedDetail', { username: user.username })}</p>
      </main>
    )
  }

  return <Outlet />
}
