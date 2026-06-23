import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import styles from './Admin.module.css'

/**
 * Route-level guard for the user-management / audit sub-routes.
 * 权限驱动：需要查看用户或审计的权限；具体页面再按 user:read / audit:read 细化。
 */
export const AdminOnlyGuard = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading, permissions } = useAuth()

  if (authLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>{t('admin.verifying')}</div>
      </div>
    )
  }

  const allowed = !!user && (hasPermission(permissions, PERMISSIONS.USER_READ) || hasPermission(permissions, PERMISSIONS.AUDIT_READ))
  if (!allowed) {
    return (
      <div className={styles.container}>
        <h1 className={styles.heading}>{t('adminUsers.accessDenied')}</h1>
        <p className={styles.headingDesc}>{t('adminUsers.accessDeniedDetail')}</p>
      </div>
    )
  }

  return <Outlet />
}
