import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { saveCsrfToken } from '@/api/client'

/**
 * OAuth 补全注册中间页 — api.md §1.6.2
 * 服务端 redirect 到 /auth/oauth/continue?status=pending_registration&provider=github
 */
export const OAuthContinue = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  useEffect(() => {
    const status = searchParams.get('status')
    const provider = searchParams.get('provider') || 'github'

    // Persist CSRF token to sessionStorage for registration page
    const csrfMatch = document.cookie.match(/oauth_pending_csrf=([^;]+)/)
    if (csrfMatch?.[1]) saveCsrfToken(csrfMatch[1])

    if (status === 'pending_registration') {
      navigate(`/register?provider=${encodeURIComponent(provider)}`, { replace: true })
    } else {
      navigate('/submit', { replace: true })
    }
  }, [searchParams, navigate])

  return (
    <main style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
      <p style={{ fontSize: '1.1rem', color: 'var(--text-muted)' }}>跳转中...</p>
    </main>
  )
}
