import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'

import { Navbar } from '../components/Navbar'
import { LicenseFooter } from '../components/LicenseFooter'
import styles from '../App.module.css'

export const RootLayout = () => {
  // L15: Toast feedback for cross-page notifications (OAuth callback, etc.)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const toast = params.get('toast')
    if (toast) {
      console.warn(`[toast] ${toast} — consider upgrading to a UI toast component`)
    }
  }, [])

  return (
    <div className={styles.appContainer}>
      <Navbar />

      <main className={styles.mainContent}>
        <Outlet />
      </main>

      <LicenseFooter />
    </div>
  )
}
