import { createBrowserRouter, Navigate } from 'react-router-dom'
import { lazy, Suspense, Component, type ReactNode, type ErrorInfo } from 'react'

import { RootLayout } from '../layouts/RootLayout'
import { ErrorBoundaryPage } from '../pages/ErrorBoundaryPage'
import { AdminShell } from '../pages/AdminShell'
import { RequireAuthLayout } from '../pages/RequireAuthLayout'
import { RequirePermissionLayout } from '../pages/RequirePermissionLayout'
import { RequireReviewerOrAdminLayout } from '../pages/RequireReviewerOrAdminLayout'
import { PERMISSIONS } from '@/api/permissions'
import { LegacyLoginRedirect } from '../pages/LegacyLoginRedirect'
import type { RouteHandle } from './handles'
import { RouteLoadError, RouteLoading, type RouteFallbackLayout } from './RouteFallback'

import { Home } from '../pages/Home'

// 惰性加载错误边界：捕获 chunk 加载失败（网络断开 / 部署后 404 等），显示重试入口。
class LazyErrorBoundary extends Component<{ children: ReactNode; layout: RouteFallbackLayout }, { hasError: boolean }> {
  constructor(props: { children: ReactNode; layout: RouteFallbackLayout }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }
  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    console.warn('[router] Lazy load error:', error.message)
    void _info
  }
  /* 整页重新加载：React.lazy 会缓存失败的 import，只清错误边界状态会立刻再次渲染同一个
     失败结果，「重试」点了等于没点。部署更新后旧 chunk 404 的情形也只有整页刷新才能拿到新清单。 */
  handleRetry = (): void => {
    window.location.reload()
  }
  override render(): ReactNode {
    if (this.state.hasError) {
      return <RouteLoadError layout={this.props.layout} onRetry={this.handleRetry} />
    }
    return this.props.children
  }
}

/** layout：占位与目标页根外壳保持一致（见 RouteFallback.tsx）。 */
function lazyNamed(
  importFn: () => Promise<Record<string, unknown>>,
  name: string,
  layout: RouteFallbackLayout = 'page',
) {
  const LazyComponent = lazy(async () => {
    const mod = await importFn()
    return { default: mod[name] as React.ComponentType<unknown> }
  })
  /* key：同一位置上的兄弟路由（如 /admin/users ↔ /admin/audit-logs）元素类型相同，
     不加 key 会复用同一个边界，一页 chunk 失败后切到别的页仍显示失败。 */
  return (
    <LazyErrorBoundary key={name} layout={layout}>
      <Suspense fallback={<RouteLoading layout={layout} />}>
        <LazyComponent />
      </Suspense>
    </LazyErrorBoundary>
  )
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    errorElement: <ErrorBoundaryPage />,
    children: [
      {
        index: true,
        element: <Home />,
      },
      {
        path: 'submit',
        element: lazyNamed(() => import('../pages/Submit'), 'Submit'),
      },
      {
        path: 'login',
        element: <LegacyLoginRedirect />,
      },
      {
        path: 'auth/login',
        element: lazyNamed(() => import('../pages/Login'), 'Login', 'stage'),
      },
      {
        // 本地注册已迁移到 TransCircle Pass，故事站不再承载。
        path: 'register',
        element: <Navigate to="/auth/login" replace />,
      },
      {
        path: 'admin',
        element: <AdminShell />,
        handle: { shell: 'admin' } satisfies RouteHandle,
        children: [
          {
            element: <RequireReviewerOrAdminLayout />,
            children: [
              { index: true, element: lazyNamed(() => import('../pages/Admin'), 'Admin') },
              {
                path: 'edit-requests',
                element: lazyNamed(() => import('../pages/AdminEditRequests'), 'AdminEditRequests'),
              },
            ],
          },
          {
            // 用户管理 / 审计子路由：按具体权限精确守卫（IAM 权限快照驱动），
            // 不再用 OR 守卫 + 页面内二次判断（admin-page-guard-inconsistent）
            path: 'audit-logs',
            element: (
              <RequirePermissionLayout permission={PERMISSIONS.AUDIT_READ}>
                {lazyNamed(() => import('../pages/AdminAuditLogs'), 'AdminAuditLogs')}
              </RequirePermissionLayout>
            ),
          },
          {
            path: 'users',
            element: (
              <RequirePermissionLayout permission={PERMISSIONS.USER_READ}>
                {lazyNamed(() => import('../pages/AdminUsers'), 'AdminUsers')}
              </RequirePermissionLayout>
            ),
          },
          {
            path: 'comments',
            element: (
              <RequirePermissionLayout permission={PERMISSIONS.COMMENT_MODERATE}>
                {lazyNamed(() => import('../pages/AdminComments'), 'AdminComments')}
              </RequirePermissionLayout>
            ),
          },
        ],
      },
      {
        path: 'auth/callback',
        element: lazyNamed(() => import('../pages/OAuthCallback'), 'OAuthCallback', 'stage'),
      },
      {
        path: 'auth/error',
        element: lazyNamed(() => import('../pages/AuthError'), 'AuthError', 'stage'),
      },
      {
        path: 'auth/oauth/continue',
        element: <Navigate to="/auth/login" replace />,
      },
      {
        path: 'auth/oauth/merge',
        element: <Navigate to="/auth/error?status=oauth_error" replace />,
      },
      {
        path: 'auth/step-up/done',
        element: lazyNamed(() => import('../pages/StepUpDone'), 'StepUpDone', 'stage'),
      },
      {
        // 需要认证的普通用户页面：统一由 RequireAuthLayout 守卫（身份统一 Pass，无需特定权限）。
        element: <RequireAuthLayout />,
        children: [
          {
            path: 'settings',
            element: <Navigate to="/settings/security" replace />,
          },
          {
            path: 'settings/security',
            element: lazyNamed(() => import('../pages/SettingsSecurity'), 'SettingsSecurity'),
          },
          {
            // 以下本地账户流程（OAuth 绑定/直接注册/邮箱验证/密码找回/撤销注销）均迁移到
            // TransCircle Pass，故事站不再承载 → 统一重定向到登录页。
            path: 'settings/security/oauth-bind/confirm',
            element: <Navigate to="/auth/login" replace />,
          },
          {
            path: 'register-direct',
            element: <Navigate to="/auth/login" replace />,
          },
          {
            path: 'auth/email/verify',
            element: <Navigate to="/auth/login" replace />,
          },
          {
            path: 'auth/email/resend',
            element: <Navigate to="/auth/login" replace />,
          },
          {
            path: 'auth/password/forgot',
            element: <Navigate to="/auth/login" replace />,
          },
          {
            path: 'auth/password/reset',
            element: <Navigate to="/auth/login" replace />,
          },
          {
            path: 'auth/cancel-deletion',
            element: <Navigate to="/auth/login" replace />,
          },
          {
            path: 'me/contributions',
            element: lazyNamed(() => import('../pages/MyContributions'), 'MyContributions'),
          },
          {
            path: 'me/contributions/:id',
            element: lazyNamed(() => import('../pages/MyContributionDetail'), 'MyContributionDetail'),
          },
          {
            path: 'contributions/:id/edit-request',
            element: lazyNamed(() => import('../pages/EditRequestForm'), 'EditRequestForm'),
          },
        ],
      },
      {
        path: 'contributions/:id',
        element: lazyNamed(() => import('../pages/PublicContributionDetail'), 'PublicContributionDetail'),
      },
      {
        path: '*',
        element: lazyNamed(() => import('../pages/NotFound'), 'NotFound', 'card'),
        handle: { notFound: true } satisfies RouteHandle,
      },
    ],
  },
])
