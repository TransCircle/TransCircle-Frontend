import { createBrowserRouter, Navigate } from 'react-router-dom'
import { lazy, Suspense, Component, type ReactNode, type ErrorInfo } from 'react'

import { RootLayout } from '../layouts/RootLayout'
import { ErrorBoundaryPage } from '../pages/ErrorBoundaryPage'
import { AdminShell } from '../pages/AdminShell'
import { RequireAdminLayout } from '../pages/RequireAdminLayout'
import { RequireReviewerOrAdminLayout } from '../pages/RequireReviewerOrAdminLayout'
import { AdminOnlyGuard } from '../pages/AdminOnlyGuard'

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
          <p>页面加载失败，请检查网络连接</p>
          <button onClick={this.handleRetry} style={{ marginTop: '1rem', cursor: 'pointer' }}>
            重试
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
            {'Loading...'}
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
        element: lazyNamed(() => import('../pages/Login'), 'Login'),
      },
      {
        // 本地注册已迁移到 TransCircle Pass，故事站不再承载 → 重定向到登录
        path: 'register',
        element: <Navigate to="/login" replace />,
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
            element: <RequireAdminLayout />,
            children: [
              {
                element: <AdminOnlyGuard />,
                children: [
                  { path: 'audit-logs', element: lazyNamed(() => import('../pages/AdminAuditLogs'), 'AdminAuditLogs') },
                  { path: 'users', element: lazyNamed(() => import('../pages/AdminUsers'), 'AdminUsers') },
                ],
              },
            ],
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
        element: <Navigate to="/login" replace />,
      },
      {
        path: 'auth/oauth/merge',
        element: <Navigate to="/login" replace />,
      },
      {
        path: 'auth/step-up/done',
        element: lazyNamed(() => import('../pages/StepUpDone'), 'StepUpDone'),
      },
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
        element: <Navigate to="/login" replace />,
      },
      {
        path: 'register-direct',
        element: <Navigate to="/login" replace />,
      },
      {
        path: 'auth/email/verify',
        element: <Navigate to="/login" replace />,
      },
      {
        path: 'auth/email/resend',
        element: <Navigate to="/login" replace />,
      },
      {
        path: 'auth/password/forgot',
        element: <Navigate to="/login" replace />,
      },
      {
        path: 'auth/password/reset',
        element: <Navigate to="/login" replace />,
      },
      {
        path: 'auth/cancel-deletion',
        element: <Navigate to="/login" replace />,
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
        path: 'contributions/:id',
        element: lazyNamed(() => import('../pages/PublicContributionDetail'), 'PublicContributionDetail'),
      },
      {
        path: 'contributions/:id/edit-request',
        element: lazyNamed(() => import('../pages/EditRequestForm'), 'EditRequestForm'),
      },
      {
        path: '*',
        element: lazyNamed(() => import('../pages/NotFound'), 'NotFound'),
      },
    ],
  },
])
