// OAuth callback handler page
// Backend redirects here with ?status=login_ok&loginCode=xxx&provider=github
// This page exchanges the loginCode for an access token and redirects

import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'

const OAuthCallback = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { exchangeLoginCode } = useAuth()

  useEffect(() => {
    const handle = async () => {
      const status = searchParams.get('status')
      const loginCode = searchParams.get('loginCode')

      if (status === 'login_ok' && loginCode) {
        const user = await exchangeLoginCode(loginCode)
        if (user?.isAdmin) {
          navigate('/admin', { replace: true })
        } else {
          navigate('/submit', { replace: true })
        }
      } else if (status === 'pending_registration') {
        const provider = searchParams.get('provider') || 'github'
        navigate(`/register?provider=${encodeURIComponent(provider)}`, { replace: true })
      } else if (status === 'bad_state' || status === 'oauth_error') {
        navigate(`/submit?error=oauth_${status}`, { replace: true })
      } else {
        navigate('/submit', { replace: true })
      }
    }
    handle()
  }, [searchParams, navigate, exchangeLoginCode])

  return (
    <main style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
      <p style={{ fontSize: '1.1rem', color: 'var(--text-muted)' }}>完成登录...</p>
    </main>
  )
}

export default OAuthCallback
