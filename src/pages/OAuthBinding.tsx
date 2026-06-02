import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { API_BASE } from '@/config'
import { useAuth } from '@/context/useAuth'
import { StepUpDialog } from '@/components/StepUpDialog'

export const OAuthBinding = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { accessToken } = useAuth()

  const provider = searchParams.get('provider') || 'github'
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [showStepUp, setShowStepUp] = useState(false)

  const handleBind = async () => {
    setStatus('submitting')
    setErrorMsg('')

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
      else {
        setErrorMsg(t('oauth.bindStepUpRequired'))
        setStatus('error')
        return
      }

      const csrfMatch = document.cookie.match(/oauth_pending_csrf=([^;]+)/)
      const csrfToken = csrfMatch?.[1] || ''
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken

      const res = await fetch(`${API_BASE}/auth/oauth/complete-binding`, {
        method: 'POST',
        headers,
        credentials: 'include',
      })

      if (res.status === 403) {
        const body = await res.json() as { error?: { code?: string } }
        if (body.error?.code === 'STEP_UP_REQUIRED') {
          setShowStepUp(true)
          setStatus('idle')
          return
        }
        setErrorMsg(t('oauth.bindError'))
        setStatus('error')
        return
      }

      if (!res.ok) {
        setErrorMsg(t('oauth.bindError'))
        setStatus('error')
        return
      }

      setStatus('success')
      setTimeout(() => navigate('/submit?toast=bind_success', { replace: true }), 1500)
    } catch {
      setErrorMsg(t('oauth.bindError'))
      setStatus('error')
    }
  }

  const handleStepUpSuccess = () => {
    setShowStepUp(false)
    handleBind()
  }

  const providerLabel = provider === 'x' ? 'X' : 'GitHub'
  const containerStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', minHeight: '50vh', textAlign: 'center', padding: '2rem',
  }

  if (status === 'success') {
    return (
      <main style={containerStyle}>
        <p style={{ fontSize: '1.1rem', color: 'var(--text-main)' }}>
          {t('oauth.bindSuccess', { provider: providerLabel })}
        </p>
      </main>
    )
  }

  return (
    <>
      <main style={containerStyle}>
        <h1 style={{ fontSize: '1.8rem', margin: '0 0 0.75rem', color: 'var(--text-main)' }}>
          {t('oauth.bindTitle')}
        </h1>
        <p style={{ fontSize: '1rem', color: 'var(--text-secondary)', margin: '0 0 1.5rem', maxWidth: '400px', lineHeight: 1.6 }}>
          {t('oauth.bindDescription', { provider: providerLabel })}
        </p>

        {status === 'error' && errorMsg && (
          <p style={{ color: '#c62828', fontSize: '0.9rem', marginBottom: '1rem' }} role="alert">{errorMsg}</p>
        )}

        <button
          onClick={handleBind}
          disabled={status === 'submitting'}
          style={{
            backgroundColor: 'var(--accent-pink)', color: 'white', border: 'none',
            padding: '0.65rem 2rem', borderRadius: '50px', fontSize: '0.95rem',
            fontWeight: 600, cursor: status === 'submitting' ? 'not-allowed' : 'pointer',
            opacity: status === 'submitting' ? 0.6 : 1, fontFamily: 'inherit',
          }}
        >
          {status === 'submitting' ? t('register.submitting') : t('oauth.bindConfirm')}
        </button>
      </main>

      {showStepUp && (
        <StepUpDialog
          onSuccess={handleStepUpSuccess}
          onCancel={() => setShowStepUp(false)}
        />
      )}
    </>
  )
}
