import { useEffect, useState } from 'react'
import { Outlet, useNavigate, useSearchParams } from 'react-router-dom'

import { Navbar } from '../components/Navbar'
import { LicenseFooter } from '../components/LicenseFooter'
import styles from '../App.module.css'

const TOAST_MESSAGES: Record<string, string> = {
  bind_already_self: '该 OAuth 账号已绑定到你的账户，无需重复绑定',
  bind_provider_taken: '该 OAuth 账号已绑定到其他用户',
  bind_success: '绑定成功',
  merge_success: '合并成功',
  deletion_scheduled: '账户注销已受理',
}

export const RootLayout = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const toastKey = searchParams.get('toast')
  const initialMessage = (toastKey && TOAST_MESSAGES[toastKey]) || null

  const [toast, setToast] = useState<string | null>(initialMessage)

  // L15: Toast feedback for cross-page notifications (OAuth callback, etc.)
  useEffect(() => {
    if (!toast) return

    // Clear the URL param after reading
    const params = new URLSearchParams(searchParams.toString())
    params.delete('toast')
    navigate({ search: params.toString() }, { replace: true })

    // Auto-dismiss after 5 seconds
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={styles.appContainer}>
      <Navbar />

      <main className={styles.mainContent}>
        <Outlet />
      </main>

      <LicenseFooter />

      {toast && (
        <div
          style={{
            position: 'fixed',
            top: '1rem',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#e8f5e9',
            color: '#2e7d32',
            padding: '0.75rem 1.5rem',
            borderRadius: '8px',
            fontSize: '0.9rem',
            zIndex: 9999,
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  )
}
