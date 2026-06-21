import { createBrowserRouter, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'

import { RootLayout } from '../layouts/RootLayout'
import { ErrorBoundaryPage } from '../pages/ErrorBoundaryPage'
import { RequireAdminLayout } from '../pages/RequireAdminLayout'
import { RequireReviewerOrAdminLayout } from '../pages/RequireReviewerOrAdminLayout'
import { AdminOnlyGuard } from '../pages/AdminOnlyGuard'

import { Home } from '../pages/Home'

function lazyNamed(
  importFn: () => Promise<Record<string, unknown>>,
  name: string,
) {
  const LazyComponent = lazy(async () => {
    const mod = await importFn()
    return { default: mod[name] as React.ComponentType<unknown> }
  })
  return <Suspense fallback={<div role="status" aria-live="polite" aria-busy="true" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>{'Loading...'}</div>}>
    <LazyComponent />
  </Suspense>
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
        path: 'register',
        element: lazyNamed(() => import('../pages/Register'), 'Register'),
      },
      {
        path: 'admin',
        children: [
          {
            element: <RequireReviewerOrAdminLayout />,
            children: [
              { index: true, element: lazyNamed(() => import('../pages/Admin'), 'Admin') },
              { path: 'edit-requests', element: lazyNamed(() => import('../pages/AdminEditRequests'), 'AdminEditRequests') },
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
        element: lazyNamed(() => import('../pages/OAuthContinue'), 'OAuthContinue'),
      },
      {
        path: 'auth/oauth/merge',
        element: lazyNamed(() => import('../pages/OAuthMerge'), 'OAuthMerge'),
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
        path: 'auth/cancel-deletion',
        element: lazyNamed(() => import('../pages/CancelDeletion'), 'CancelDeletion'),
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
