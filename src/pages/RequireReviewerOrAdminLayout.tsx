import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import styles from './Admin.module.css'

export const RequireReviewerOrAdminLayout = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading, permissions } = useAuth()
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

  // 审核后台入口：拥有「查看投稿」权限即可（reviewer/editor/admin 皆有）
  const allowed = hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ)
  if (!allowed) {
    return (
      <main className={styles.container}>
        <h1 className={styles.heading}>{t('admin.accessDenied')}</h1>
        <p className={styles.headingDesc}>{t('admin.accessDeniedDetail', { username: user.username })}</p>
      </main>
    )
  }

  return <Outlet />
}
