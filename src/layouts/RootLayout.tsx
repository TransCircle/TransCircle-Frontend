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

  const [rateLimitToast, setRateLimitToast] = useState<string | null>(null)
  const [dismissedToastKey, setDismissedToastKey] = useState<string | null>(null)

  const toastKey = searchParams.get('toast')
  const toastMessage = (toastKey && TOAST_MESSAGE_KEYS[toastKey] && dismissedToastKey !== toastKey)
    ? t(TOAST_MESSAGE_KEYS[toastKey])
    : null

  // L15/A: Auto-dismiss and URL cleanup for ?toast= (supports SPA navigation)
  useEffect(() => {
    if (!toastKey || !TOAST_MESSAGE_KEYS[toastKey]) return

    const timer = setTimeout(() => {
      setDismissedToastKey(toastKey)
      const params = new URLSearchParams(searchParams.toString())
      params.delete('toast')
      navigate({ search: params.toString() }, { replace: true })
    }, 5000)

    return () => clearTimeout(timer)
  }, [searchParams, navigate, toastKey])
  // L1: Listen for API rate-limit events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const retryAfter = detail?.retryAfter
      if (retryAfter) {
        setRateLimitToast(t('common.rateLimitHint', { seconds: retryAfter }))
        setTimeout(() => setRateLimitToast(null), Math.min(retryAfter * 1000, 15000))
      }
    }
    window.addEventListener('api:rate-limit', handler)
    return () => window.removeEventListener('api:rate-limit', handler)
  }, [t])


  return (
    <div className={styles.appContainer}>
      <Navbar />

      <main className={styles.mainContent}>
        <Outlet />
      </main>

      <LicenseFooter />


      {rateLimitToast && (
        <div
          className={styles.toastError}
          role="alert"
          onClick={() => setRateLimitToast(null)}
        >
          {rateLimitToast}
        </div>
      )}
      {toastMessage && (
        <div
          className={styles.toastInfo}
          role="status"
          aria-live="polite"
        >
          {toastMessage}
        </div>
      )}
    </div>
  )
}
