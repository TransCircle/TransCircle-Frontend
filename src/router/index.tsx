import { createBrowserRouter, Navigate } from 'react-router-dom'
import { lazy, Suspense, Component, type ReactNode, type ErrorInfo } from 'react'

import i18n from '@/i18n/config'
import { RootLayout } from '../layouts/RootLayout'
import { ErrorBoundaryPage } from '../pages/ErrorBoundaryPage'
import { AdminShell } from '../pages/AdminShell'
import { RequireAuthLayout } from '../pages/RequireAuthLayout'
import { RequirePermissionLayout } from '../pages/RequirePermissionLayout'
import { RequireReviewerOrAdminLayout } from '../pages/RequireReviewerOrAdminLayout'
import { PERMISSIONS } from '@/api/permissions'
import { LegacyLoginRedirect } from '../pages/LegacyLoginRedirect'

import { Home } from '../pages/Home'

// 惰性加载错误边界：捕获 chunk 加载失败（网络断开/部署后 404等），显示重试提示
const FALLBACK_STYLE: Record<string, string> = {
  textAlign: 'center',
  padding: '2rem',
  color: 'var(--text-muted)',
}
const SPINNER_STYLE: Record<string, string> = {
  textAlign: 'center',
  padding: '2rem',
  color: 'var(--text-muted)',
}

class LazyErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
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
  handleRetry = (): void => {
    this.setState({ hasError: false })
  }
  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div role="alert" style={FALLBACK_STYLE}>
          <p>{i18n.t('common.chunkLoadError')}</p>
          <button onClick={this.handleRetry} style={{ marginTop: '1rem', cursor: 'pointer' }}>
            {i18n.t('common.retry')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function lazyNamed(importFn: () => Promise<Record<string, unknown>>, name: string) {
  const LazyComponent = lazy(async () => {
    const mod = await importFn()
    return { default: mod[name] as React.ComponentType<unknown> }
  })
  return (
    <LazyErrorBoundary>
      <Suspense
        fallback={
          <div role="status" aria-live="polite" aria-busy="true" style={SPINNER_STYLE}>
            {i18n.t('common.loading')}
          </div>
        }
      >
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
        element: lazyNamed(() => import('../pages/Login'), 'Login'),
      },
      {
        // 本地注册已迁移到 TransCircle Pass，故事站不再承载。
        path: 'register',
        element: <Navigate to="/auth/login" replace />,
      },
      {
        path: 'admin',
        element: <AdminShell />,
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
        element: lazyNamed(() => import('../pages/OAuthCallback'), 'OAuthCallback'),
      },
      {
        path: 'auth/error',
        element: lazyNamed(() => import('../pages/AuthError'), 'AuthError'),
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
        element: lazyNamed(() => import('../pages/StepUpDone'), 'StepUpDone'),
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
        element: lazyNamed(() => import('../pages/NotFound'), 'NotFound'),
      },
    ],
  },
])
