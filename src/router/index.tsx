import { createBrowserRouter, Navigate } from 'react-router-dom'

import { RootLayout } from '../layouts/RootLayout'

import { Submit } from '../pages/Submit'
import { Login } from '../pages/Login'
import { Register } from '../pages/Register'
import { Admin } from '../pages/Admin'
import { OAuthCallback } from '../pages/OAuthCallback'
import { AuthError } from '../pages/AuthError'
import { OAuthBinding } from '../pages/OAuthBinding'
import { OAuthMerge } from '../pages/OAuthMerge'
import { NotFound } from '../pages/NotFound'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: <Navigate to="/submit" replace />,
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
        path: 'auth/callback',
        element: <OAuthCallback />,
      },
      {
        path: 'auth/error',
        element: <AuthError />,
      },
      {
        path: 'auth/oauth/merge',
        element: <OAuthMerge />,
      },
      {
        path: 'settings/security/oauth-bind/confirm',
        element: <OAuthBinding />,
      },
      {
        path: '*',
        element: <NotFound />,
      },
    ],
  },
])
