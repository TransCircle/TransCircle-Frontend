import { createBrowserRouter, Navigate } from 'react-router-dom'
import { lazy, Suspense, Component, type ReactNode, type ErrorInfo } from 'react'

import { RootLayout } from '../layouts/RootLayout'
import { ErrorBoundaryPage } from '../pages/ErrorBoundaryPage'
import { AdminShell } from '../pages/AdminShell'
import { RequireAuthLayout } from '../pages/RequireAuthLayout'
import { RequirePermissionLayout } from '../pages/RequirePermissionLayout'
import { RequireReviewerOrAdminLayout } from '../pages/RequireReviewerOrAdminLayout'
import { ADMIN_ENTRY_PERMISSIONS, PERMISSIONS } from '@/api/permissions'
import { LegacyLoginRedirect } from '../pages/LegacyLoginRedirect'
import type { RouteHandle } from './handles'
import { RouteLoadError, RouteLoading, type RouteFallbackLayout } from './RouteFallback'
import { KeyedById } from './KeyedById'

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
        path: 'search',
        element: lazyNamed(() => import('../pages/Search'), 'Search'),
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
        /* /admin 本身没有页面：AdminShell 按权限把它落到首个可访问的分区（同 Pass 控制台）。
           列表与其详情是两条独立路由——详情有自己的地址，刷新、后退、新标签打开、分享都成立。
           详情路由按 :id 加 key：换一条就整页重挂，卸载会作废上一条的在途请求与写操作。 */
        children: [
          {
            // 概览：持有任一后台权限即可打开（至少能看到自己的角色与权限表），卡片再按各自的权限显示
            path: 'overview',
            handle: { titleKey: 'pageTitles.adminOverview', adminSection: 'overview' } satisfies RouteHandle,
            element: (
              <RequirePermissionLayout anyOf={ADMIN_ENTRY_PERMISSIONS}>
                {lazyNamed(() => import('../pages/admin/AdminOverview'), 'AdminOverview', 'inline')}
              </RequirePermissionLayout>
            ),
          },
          {
            element: <RequireReviewerOrAdminLayout />,
            children: [
              {
                path: 'review',
                handle: { titleKey: 'pageTitles.reviewQueue', adminSection: 'review' } satisfies RouteHandle,
                element: lazyNamed(() => import('../pages/admin/AdminContributionList'), 'AdminReviewQueue', 'inline'),
              },
              {
                path: 'contributions',
                handle: {
                  titleKey: 'pageTitles.adminContributions',
                  adminSection: 'contributions',
                } satisfies RouteHandle,
                element: lazyNamed(
                  () => import('../pages/admin/AdminContributionList'),
                  'AdminContributions',
                  'inline',
                ),
              },
              {
                path: 'contributions/:id',
                handle: {
                  titleKey: 'pageTitles.adminContribution',
                  adminSection: 'contributions',
                } satisfies RouteHandle,
                element: (
                  <KeyedById>
                    {lazyNamed(
                      () => import('../pages/admin/AdminContributionDetail'),
                      'AdminContributionDetail',
                      'inline',
                    )}
                  </KeyedById>
                ),
              },
            ],
          },
          {
            // 修改申请：接口要求 contribution:edit-request:vote（apidocs §10.4 / §10.5），与投稿读取权限分开守卫
            element: <RequirePermissionLayout permission={PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE} />,
            children: [
              {
                path: 'edit-requests',
                handle: { titleKey: 'pageTitles.editRequests', adminSection: 'editRequests' } satisfies RouteHandle,
                element: lazyNamed(() => import('../pages/AdminEditRequests'), 'AdminEditRequests', 'inline'),
              },
              {
                path: 'edit-requests/:id',
                handle: { titleKey: 'pageTitles.editRequest', adminSection: 'editRequests' } satisfies RouteHandle,
                element: (
                  <KeyedById>
                    {lazyNamed(
                      () => import('../pages/admin/AdminEditRequestDetail'),
                      'AdminEditRequestDetail',
                      'inline',
                    )}
                  </KeyedById>
                ),
              },
            ],
          },
          {
            // 用户管理 / 审计子路由：按具体权限精确守卫（IAM 权限快照驱动），
            // 不再用 OR 守卫 + 页面内二次判断（admin-page-guard-inconsistent）
            path: 'audit-logs',
            handle: { titleKey: 'pageTitles.auditLogs', adminSection: 'auditLogs' } satisfies RouteHandle,
            element: (
              <RequirePermissionLayout permission={PERMISSIONS.AUDIT_READ}>
                {lazyNamed(() => import('../pages/AdminAuditLogs'), 'AdminAuditLogs', 'inline')}
              </RequirePermissionLayout>
            ),
          },
          {
            element: <RequirePermissionLayout permission={PERMISSIONS.USER_READ} />,
            children: [
              {
                path: 'users',
                handle: { titleKey: 'pageTitles.users', adminSection: 'users' } satisfies RouteHandle,
                element: lazyNamed(() => import('../pages/AdminUsers'), 'AdminUsers', 'inline'),
              },
              {
                path: 'users/:id',
                handle: { titleKey: 'pageTitles.user', adminSection: 'users' } satisfies RouteHandle,
                element: (
                  <KeyedById>
                    {lazyNamed(() => import('../pages/admin/AdminUserDetail'), 'AdminUserDetail', 'inline')}
                  </KeyedById>
                ),
              },
            ],
          },
          {
            element: <RequirePermissionLayout permission={PERMISSIONS.COMMENT_MODERATE} />,
            children: [
              {
                path: 'comments',
                handle: { titleKey: 'pageTitles.comments', adminSection: 'comments' } satisfies RouteHandle,
                element: lazyNamed(() => import('../pages/AdminComments'), 'AdminComments', 'inline'),
              },
              {
                path: 'comments/:id',
                handle: { titleKey: 'pageTitles.comment', adminSection: 'comments' } satisfies RouteHandle,
                element: (
                  <KeyedById>
                    {lazyNamed(() => import('../pages/admin/AdminCommentDetail'), 'AdminCommentDetail', 'inline')}
                  </KeyedById>
                ),
              },
            ],
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
