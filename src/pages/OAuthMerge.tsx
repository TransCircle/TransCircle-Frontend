import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { API_BASE } from '@/config'
import { useAuth } from '@/context/useAuth'
import { StepUpDialog } from '@/components/StepUpDialog'

export const OAuthMerge = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { accessToken } = useAuth()

  const mergeToken = searchParams.get('mergeToken') || ''
  const conflictUserId = searchParams.get('conflictUserId') || ''
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [showStepUp, setShowStepUp] = useState(false)

  const handleMerge = async () => {
    if (!mergeToken) {
      setErrorMsg(t('oauth.mergeTokenExpired'))
      setStatus('error')
      return
    }

    setStatus('submitting')
    setErrorMsg('')

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
      else {
        setErrorMsg(t('oauth.mergeStepUpRequired'))
        setStatus('error')
        return
      }

      const res = await fetch(`${API_BASE}/auth/merge`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mergeToken, confirm: true }),
      })

      if (res.status === 403) {
        const body = await res.json() as { error?: { code?: string } }
        if (body.error?.code === 'STEP_UP_REQUIRED') {
          setShowStepUp(true)
          setStatus('idle')
          return
        }
        setErrorMsg(t('oauth.mergeError'))
        setStatus('error')
        return
      }

      if (res.status === 410) {
        setErrorMsg(t('oauth.mergeTokenExpired'))
        setStatus('error')
        return
      }

      if (!res.ok) {
        setErrorMsg(t('oauth.mergeError'))
        setStatus('error')
        return
      }

      setStatus('success')
      setTimeout(() => navigate('/submit?toast=merge_success', { replace: true }), 1500)
    } catch {
      setErrorMsg(t('oauth.mergeError'))
      setStatus('error')
    }
  }

  const handleStepUpSuccess = () => {
    setShowStepUp(false)
    handleMerge()
  }

  const containerStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', minHeight: '50vh', textAlign: 'center', padding: '2rem',
  }

  if (status === 'success') {
    return (
      <main style={containerStyle}>
        <p style={{ fontSize: '1.1rem', color: 'var(--text-main)' }}>{t('oauth.mergeSuccess')}</p>
      </main>
    )
  }

  if (!mergeToken) {
    return (
      <main style={containerStyle}>
        <h1 style={{ fontSize: '1.8rem', margin: '0 0 0.75rem', color: 'var(--text-main)' }}>{t('oauth.mergeTitle')}</h1>
        <p style={{ fontSize: '1rem', color: '#c62828' }} role="alert">{t('oauth.mergeTokenExpired')}</p>
      </main>
    )
  }

  return (
    <>
      <main style={containerStyle}>
        <h1 style={{ fontSize: '1.8rem', margin: '0 0 0.75rem', color: 'var(--text-main)' }}>{t('oauth.mergeTitle')}</h1>
        <p style={{ fontSize: '1rem', color: 'var(--text-secondary)', margin: '0 0 1.5rem', maxWidth: '450px', lineHeight: 1.6 }}>
          {t('oauth.mergeDescription')}
        </p>
        {conflictUserId && (
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            {t('admin.authorLabel')} {conflictUserId}
          </p>
        )}
        {status === 'error' && errorMsg && (
          <p style={{ color: '#c62828', fontSize: '0.9rem', marginBottom: '1rem' }} role="alert">{errorMsg}</p>
        )}
        <button
          onClick={handleMerge}
          disabled={status === 'submitting'}
          style={{
            backgroundColor: '#d32f2f', color: 'white', border: 'none',
            padding: '0.65rem 2rem', borderRadius: '50px', fontSize: '0.95rem',
            fontWeight: 600, cursor: status === 'submitting' ? 'not-allowed' : 'pointer',
            opacity: status === 'submitting' ? 0.6 : 1, fontFamily: 'inherit',
          }}
        >
          {status === 'submitting' ? t('register.submitting') : t('oauth.mergeConfirm')}
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
