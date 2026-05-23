import { createBrowserRouter, Navigate } from 'react-router-dom'

import RootLayout from '../layouts/RootLayout'

import Submit from '../pages/Submit'
import Admin from '../pages/Admin'
import NotFound from '../pages/NotFound'

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
        path: 'admin',
        element: <Admin />,
      },
      {
        path: '*',
        element: <NotFound />,
      },
    ],
  },
])
