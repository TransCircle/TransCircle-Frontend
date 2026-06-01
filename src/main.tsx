import React from 'react'
import ReactDOM from 'react-dom/client'

import { RouterProvider } from 'react-router-dom'

import { ThemeProvider } from './context/ThemeContext'
import { AuthProvider } from './context/AuthContext'

import { router } from './router'

import './styles/index.css'

// Initialize i18n — side-effect import ensures language resources are loaded
import './i18n/config'

ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
).render(
  <React.StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
