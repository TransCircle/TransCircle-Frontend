import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { Spinner, EmptyState } from '@/components/ui'
import shell from './Page.module.css'

export const RequireReviewerOrAdminLayout = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading, permissions } = useAuth()
  const location = useLocation()

  if (authLoading) {
    return (
      <div className={shell.page}>
        <Spinner size="lg" label={t('admin.verifying')} />
      </div>
    )
  }

  if (!user) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />
  }

  // 审核后台入口：拥有「查看投稿」权限即可（reviewer/editor/admin 皆有）
  const allowed = hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ)
  if (!allowed) {
    return (
      <div className={shell.page}>
        <EmptyState
          title={t('admin.accessDenied')}
          description={t('admin.accessDeniedDetail', { username: user.username })}
        />
      </div>
    )
  }

  return <Outlet />
}
