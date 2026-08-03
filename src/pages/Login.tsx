import { useEffect, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { StatusScreen } from '@/components/ui'
import { useAuth } from '@/context/useAuth'
import { isValidRedirect } from '@/utils/redirect'

/** Compatibility launcher for historic story-site login links. */
export const Login = () => {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, loading, loginWithPass } = useAuth()
  const startedRef = useRef(false)

  useEffect(() => {
    if (loading || startedRef.current) return

    const requestedRedirect = searchParams.get('redirect')
    const redirectAfter = isValidRedirect(requestedRedirect ?? '')
      ? requestedRedirect!
      : location.pathname === '/auth/login'
        ? ''
        : location.pathname + location.search

    if (user) {
      navigate(redirectAfter || '/settings/security?tab=profile', { replace: true })
      return
    }

    startedRef.current = true
    void loginWithPass(redirectAfter)
  }, [loading, location.pathname, location.search, loginWithPass, navigate, searchParams, user])

  return <StatusScreen kind="loading" title={t('login.redirectingToPass')} />
}
