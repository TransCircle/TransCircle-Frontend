import { createBrowserRouter } from 'react-router-dom'
import { lazy, Suspense } from 'react'

import { RootLayout } from '../layouts/RootLayout'

import { Home } from '../pages/Home'

function lazyNamed(
  importFn: () => Promise<Record<string, unknown>>,
  name: string,
) {
  const LazyComponent = lazy(async () => {
    const mod = await importFn()
    return { default: mod[name] as React.ComponentType<unknown> }
  })
  return <Suspense fallback={<div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>加载中...</div>}>
    <LazyComponent />
  </Suspense>
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
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
        path: 'register',
        element: lazyNamed(() => import('../pages/Register'), 'Register'),
      },
      {
        path: 'admin',
        element: lazyNamed(() => import('../pages/Admin'), 'Admin'),
      },
      {
        path: 'admin/edit-requests',
        element: lazyNamed(() => import('../pages/AdminEditRequests'), 'AdminEditRequests'),
      },
      {
        path: 'admin/audit-logs',
        element: lazyNamed(() => import('../pages/AdminAuditLogs'), 'AdminAuditLogs'),
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
        element: lazyNamed(() => import('../pages/OAuthContinue'), 'OAuthContinue'),
      },
      {
        path: 'auth/oauth/merge',
        element: lazyNamed(() => import('../pages/OAuthMerge'), 'OAuthMerge'),
      },
      {
        path: 'settings/security',
        element: lazyNamed(() => import('../pages/SettingsSecurity'), 'SettingsSecurity'),
      },
      {
        path: 'settings/security/oauth-bind/confirm',
        element: lazyNamed(() => import('../pages/OAuthBinding'), 'OAuthBinding'),
      },
      {
        path: 'register-direct',
        element: lazyNamed(() => import('../pages/RegisterDirect'), 'RegisterDirect'),
      },
      {
        path: 'auth/email/verify',
        element: lazyNamed(() => import('../pages/EmailVerify'), 'EmailVerify'),
      },
      {
        path: 'auth/email/resend',
        element: lazyNamed(() => import('../pages/EmailResend'), 'EmailResend'),
      },
      {
        path: 'auth/password/forgot',
        element: lazyNamed(() => import('../pages/ForgotPassword'), 'ForgotPassword'),
      },
      {
        path: 'auth/password/reset',
        element: lazyNamed(() => import('../pages/ResetPassword'), 'ResetPassword'),
      },
      {
        path: 'admin/users',
        element: lazyNamed(() => import('../pages/AdminUsers'), 'AdminUsers'),
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
