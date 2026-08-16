import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { hasPermission } from '@/api/permissions'
import { Spinner, EmptyState } from '@/components/ui'
import shell from './Page.module.css'

export interface RequirePermissionLayoutProps {
  /** 访问该子树所需的具体权限（IAM 细粒度权限快照）。 */
  permission: string
  /** 拒绝页文案 key 前缀（默认 admin.accessDenied），供页面级定制。 */
  deniedTitleKey?: string
  deniedDescKey?: string
  children: ReactNode
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
  deniedTitleKey = 'admin.accessDenied',
  deniedDescKey = 'admin.accessDeniedDetail',
  children,
}: RequirePermissionLayoutProps) => {
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
    return <Navigate to={`/auth/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />
  }

  if (!hasPermission(permissions, permission)) {
    return (
      <div className={shell.page}>
        <EmptyState title={t(deniedTitleKey)} description={t(deniedDescKey, { username: user.username })} />
      </div>
    )
  }

  return <>{children}</>
}
