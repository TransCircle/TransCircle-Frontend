import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { Spinner } from '@/components/ui'
import shell from './Page.module.css'

/**
 * 统一的「需要认证」路由守卫（普通用户 / 投稿 / 设置）。
 *
 * 解决历史遗留：/submit、/me/contributions、/settings 等需认证页面各自在组件内部
 * 重复实现「加载中 → 未登录」过渡（Spinner 闪烁 / return null / 直接 Navigate 形态不一）。
 * 现在统一由路由级守卫处理：authLoading 期间展示一致的加载态，未登录统一重定向登录页。
 *
 * 注意：管理员子树（/admin）已有独立的 RequireReviewerOrAdminLayout / RequirePermissionLayout
 * 权限守卫，不经过本守卫；本守卫只处理「需要登录但不需要特定权限」的页面。
 */
export const RequireAuthLayout = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading } = useAuth()
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

  return <Outlet />
}
