import { createBrowserRouter } from 'react-router-dom'

import { RootLayout } from '../layouts/RootLayout'

import { Submit } from '../pages/Submit'
import { Login } from '../pages/Login'
import { Register } from '../pages/Register'
import { Admin } from '../pages/Admin'
import { AdminUsers } from '../pages/AdminUsers'
import { AdminEditRequests } from '../pages/AdminEditRequests'
import { AdminAuditLogs } from '../pages/AdminAuditLogs'
import { OAuthCallback } from '../pages/OAuthCallback'
import { AuthError } from '../pages/AuthError'
import { OAuthBinding } from '../pages/OAuthBinding'
import { OAuthContinue } from '../pages/OAuthContinue'
import { OAuthMerge } from '../pages/OAuthMerge'
import { SettingsSecurity } from '../pages/SettingsSecurity'
import { NotFound } from '../pages/NotFound'
import { RegisterDirect } from '../pages/RegisterDirect'
import { EmailVerify } from '../pages/EmailVerify'
import { EmailResend } from '../pages/EmailResend'
import { ForgotPassword } from '../pages/ForgotPassword'
import { ResetPassword } from '../pages/ResetPassword'
import { Home } from '../pages/Home'
import { MyContributions } from '../pages/MyContributions'
import { MyContributionDetail } from '../pages/MyContributionDetail'
import { PublicContributionDetail } from '../pages/PublicContributionDetail'
import { EditRequestForm } from '../pages/EditRequestForm'

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
        element: <Submit />,
      },
      {
        path: 'login',
        element: <Login />,
      },
      {
        path: 'register',
        element: <Register />,
      },
      {
        path: 'admin',
        element: <Admin />,
      },
      {
        path: 'admin/edit-requests',
        element: <AdminEditRequests />,
      },
      {
        path: 'admin/audit-logs',
        element: <AdminAuditLogs />,
      },
      {
        path: 'auth/callback',
        element: <OAuthCallback />,
      },
      {
        path: 'auth/error',
        element: <AuthError />,
      },
      {
        path: 'auth/oauth/continue',
        element: <OAuthContinue />,
      },
      {
        path: 'auth/oauth/merge',
        element: <OAuthMerge />,
      },
      {
        path: 'settings/security',
        element: <SettingsSecurity />,
      },
      {
        path: 'settings/security/oauth-bind/confirm',
        element: <OAuthBinding />,
      },
      {
        path: 'register-direct',
        element: <RegisterDirect />,
      },
      {
        path: 'auth/email/verify',
        element: <EmailVerify />,
      },
      {
        path: 'auth/email/resend',
        element: <EmailResend />,
      },
      {
        path: 'auth/password/forgot',
        element: <ForgotPassword />,
      },
      {
        path: 'auth/password/reset',
        element: <ResetPassword />,
      },
      {
        path: 'admin/users',
        element: <AdminUsers />,
      },
      {
        path: 'me/contributions',
        element: <MyContributions />,
      },
      {
        path: 'me/contributions/:id',
        element: <MyContributionDetail />,
      },
      {
        path: 'contributions/:id',
        element: <PublicContributionDetail />,
      },
      {
        path: 'contributions/:id/edit-request',
        element: <EditRequestForm />,
      },
      {
        path: '*',
        element: <NotFound />,
      },
    ],
  },
])
