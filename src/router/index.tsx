import { createBrowserRouter, Navigate } from 'react-router-dom'

import App from '../App'

import Submit from '../pages/Submit'
import Admin from '../pages/Admin'
import NotFound from '../pages/NotFound'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
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
