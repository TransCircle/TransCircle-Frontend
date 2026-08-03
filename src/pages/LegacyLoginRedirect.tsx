import { Navigate, useLocation } from 'react-router-dom'

export const LegacyLoginRedirect = () => {
  const location = useLocation()
  return <Navigate to={`/auth/login${location.search}`} replace />
}
