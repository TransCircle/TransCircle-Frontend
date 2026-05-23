import { Outlet } from 'react-router-dom'

import Navbar from '../components/Navbar'
import LicenseFooter from '../components/LicenseFooter'
import styles from '../App.module.css'

const Rootlayout = () => {
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

export default Rootlayout
