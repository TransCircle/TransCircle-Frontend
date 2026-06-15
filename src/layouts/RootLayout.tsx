import { useEffect, useState } from 'react'
import { Outlet, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Navbar } from '../components/Navbar'
import { LicenseFooter } from '../components/LicenseFooter'
import styles from '../App.module.css'

const TOAST_MESSAGE_KEYS: Record<string, string> = {
  bind_already_self: 'common.toast.bindAlreadySelf',
  bind_provider_taken: 'common.toast.bindProviderTaken',
  bind_success: 'common.toast.bindSuccess',
  merge_success: 'common.toast.mergeSuccess',
  deletion_scheduled: 'common.toast.deletionScheduled',
}

export const RootLayout = () => {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const toastKey = searchParams.get('toast')
  const initialMessage = (toastKey && TOAST_MESSAGE_KEYS[toastKey])
    ? t(TOAST_MESSAGE_KEYS[toastKey])
    : null

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
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            top: '1rem',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--surface-card)',
            color: 'var(--text-main)',
            border: '1px solid var(--divider-color)',
            padding: '0.75rem 1.5rem',
            borderRadius: '8px',
            fontSize: '0.9rem',
            zIndex: 9999,
            boxShadow: '0 2px 8px var(--shadow-color)',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  )
}
