import { Outlet } from 'react-router-dom'

import Navbar from '../components/Navbar'
import LicenseFooter from '../components/LicenseFooter'

const RootLayout = () => {
  return (
    <>
      <Navbar />

      <main>
        <Outlet />
      </main>

      <LicenseFooter />
    </>
  )
}

export default RootLayout
