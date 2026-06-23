import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import styles from './Admin.module.css'

export const RequireAdminLayout = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading, permissions } = useAuth()
  const location = useLocation()

  if (authLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>{t('admin.verifying')}</div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />
  }

  // 用户管理 / 审计子树：需要查看用户或审计的权限（具体页面再按各自权限细化）
  const allowed = hasPermission(permissions, PERMISSIONS.USER_READ) || hasPermission(permissions, PERMISSIONS.AUDIT_READ)
  if (!allowed) {
    return (
      <div className={styles.container}>
        <h1 className={styles.heading}>{t('admin.accessDenied')}</h1>
        <p className={styles.headingDesc}>{t('admin.accessDeniedDetail', { username: user.username })}</p>
      </div>
    )
  }

  return <Outlet />
}
