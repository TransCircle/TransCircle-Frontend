import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post, tryRefreshToken, clearCsrfToken } from '@/api/client'
import { ERRORS } from '@/api/errors'
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
      let currentToken = accessToken
      if (!currentToken) {
        const refreshed = await tryRefreshToken()
        if (refreshed) {
          currentToken = refreshed
        } else {
          setErrorMsg(t('oauth.mergeStepUpRequired'))
          setStatus('error')
          return
        }
      }

      const result = await post('/auth/merge', { mergeToken, confirm: true })

      if (!result.ok) {
        if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
          setShowStepUp(true)
          setStatus('idle')
          return
        }
        if (result.error.code === ERRORS.TOKEN_INVALID_OR_EXPIRED) {
          setErrorMsg(t('oauth.mergeTokenExpired'))
          setStatus('error')
          return
        }
        setErrorMsg(t('oauth.mergeError'))
        setStatus('error')
        return
      }

      clearCsrfToken()
      setStatus('success')
      // Refresh token after account merge (api.md §1.8: merge increments tokenVersion,
      // invalidating the current access token)
      tryRefreshToken()
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
          accessToken={accessToken ?? ''}
        />
      )}
    </>
  )
}

