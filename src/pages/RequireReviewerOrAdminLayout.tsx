import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { RouteLoading } from '@/router/RouteFallback'
import { AccessDenied } from './GuardStates'

export const RequireReviewerOrAdminLayout = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading, permissions } = useAuth()
  const location = useLocation()

  if (authLoading) return <RouteLoading layout="inline" label={t('admin.verifying')} />

  if (!user) {
    return <Navigate to={`/auth/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />
  }

  // 审核后台入口：拥有「查看投稿」权限即可（reviewer/editor/admin 皆有）
  const allowed = hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ)
  if (!allowed) {
    return (
      <AccessDenied
        title={t('admin.accessDenied')}
        description={t('admin.accessDeniedDetail', { username: user.username })}
      />
    )
  }

  return <Outlet />
}
