import { Navigate, Outlet, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { hasPermission } from '@/api/permissions'
import { RouteLoading } from '@/router/RouteFallback'
import { AccessDenied } from './GuardStates'

export interface RequirePermissionLayoutProps {
  /** 访问该子树所需的具体权限（IAM 细粒度权限快照）。与 anyOf 二选一。 */
  permission?: string
  /** 持有其中任一权限即可访问（如概览：任一后台权限）。 */
  anyOf?: readonly string[]
  /** 拒绝页文案 key 前缀（默认 admin.accessDenied），供页面级定制。 */
  deniedTitleKey?: string
  deniedDescKey?: string
  /** 不给时渲染子路由（用作布局路由，守住列表与其详情两条路由）。 */
  children?: ReactNode
}

/**
 * 按具体权限守卫的通用路由布局（IAM 权限快照驱动）。
 *
 * 解决旧结构的两处不一致：
 * 1) RequireAdminLayout 用 USER_READ || AUDIT_READ 的 OR 守卫包裹 users 与 audit-logs，
 *    页面内再用各自权限二次判断 → 谓词分散、页面守卫与路由守卫重复；
 * 2) AdminOnlyGuard 与 RequireAdminLayout 谓词完全相同 → 纯死代码（已删除）。
 *
 * 现在路由层为每个子页面指定精确权限，页面内不再重复守卫。
 * 注意：本守卫只处理权限，不处理 /admin 整体的登录 gate（由 AdminShell 与
 * RequireReviewerOrAdminLayout 承担）。
 */
export const RequirePermissionLayout = ({
  permission,
  anyOf,
  deniedTitleKey = 'admin.accessDenied',
  deniedDescKey = 'admin.accessDeniedDetail',
  children,
}: RequirePermissionLayoutProps) => {
  const { t } = useTranslation()
  const { user, loading: authLoading, permissions } = useAuth()
  const location = useLocation()

  if (authLoading) return <RouteLoading layout="inline" label={t('admin.verifying')} />

  if (!user) {
    return <Navigate to={`/auth/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />
  }

  const allowed = anyOf
    ? anyOf.some((p) => hasPermission(permissions, p))
    : !!permission && hasPermission(permissions, permission)
  if (!allowed) {
    return <AccessDenied title={t(deniedTitleKey)} description={t(deniedDescKey, { username: user.username })} />
  }

  return children === undefined ? <Outlet /> : <>{children}</>
}
