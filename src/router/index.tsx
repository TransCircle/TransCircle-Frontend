import { createBrowserRouter, Navigate } from 'react-router-dom'

import { RootLayout } from '../layouts/RootLayout'

import { Submit } from '../pages/Submit'
import { Register } from '../pages/Register'
import { Admin } from '../pages/Admin'
import { OAuthCallback } from '../pages/OAuthCallback'
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
        path: '*',
        element: <NotFound />,
      },
    ],
  },
])
