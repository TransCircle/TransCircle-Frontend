import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { saveCsrfToken } from '@/api/client'

/**
 * OAuth 补全注册中间页 — api.md §1.6.2
 * 服务端 redirect 到 /auth/oauth/continue?status=pending_registration&provider=github
 */
export const OAuthContinue = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()

  useEffect(() => {
    const status = searchParams.get('status')
    const provider = searchParams.get('provider') || 'github'
    const redirectAfter = searchParams.get('redirectAfter') || ''

    // Persist CSRF token to sessionStorage for registration page
    const csrfMatch = document.cookie.match(/oauth_pending_csrf=([^;]+)/)
    if (csrfMatch?.[1]) saveCsrfToken(csrfMatch[1])

    if (status === 'pending_registration') {
      const target = `/register?provider=${encodeURIComponent(provider)}${redirectAfter ? `&redirectAfter=${encodeURIComponent(redirectAfter)}` : ''}`
      navigate(target, { replace: true })
    } else {
      navigate('/submit', { replace: true })
    }
  }, [searchParams, navigate])

  return (
    <main style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
      <p style={{ fontSize: '1.1rem', color: 'var(--text-muted)' }}>{t('common.loading')}</p>
    </main>
  )
}
