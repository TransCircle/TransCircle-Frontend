import { useState, useRef, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post, tryRefreshToken, clearCsrfToken } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { useAuth } from '@/context/useAuth'
import { StepUpDialog } from '@/components/StepUpDialog'

export const OAuthBinding = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { accessToken } = useAuth()

  const navigateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { return () => { if (navigateTimerRef.current) clearTimeout(navigateTimerRef.current) } }, [])
  const provider = searchParams.get('provider') || 'github'
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [showStepUp, setShowStepUp] = useState(false)

  const handleBind = async () => {
    setStatus('submitting')
    setErrorMsg('')

    try {
      if (!accessToken) {
        // Token might be null in memory but refresh token cookie still valid — try refresh
        const refreshed = await tryRefreshToken()
        if (!refreshed) {
          setErrorMsg(t('oauth.bindSessionExpired'))
          setStatus('error')
          return
        }
      }

      const result = await post('/auth/oauth/complete-binding', undefined, {
        csrf: true,
      })

      if (!result.ok) {
        if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
          setShowStepUp(true)
          setStatus('idle')
          return
        }
        if (result.error.code === ERRORS.OAUTH_ALREADY_LINKED) {
          const errorData = result.error.data as Record<string, string> | undefined
          if (errorData?.mergeToken) {
            const params = new URLSearchParams({ mergeToken: errorData.mergeToken })
            if (errorData.conflictUserId) params.set('conflictUserId', errorData.conflictUserId)
            navigate(`/auth/oauth/merge?${params}`, { replace: true })
            return
          }
        }
        if (result.error.code === ERRORS.TOKEN_INVALID_OR_EXPIRED) {
          setErrorMsg(t('oauth.bindSessionExpired'))
        } else if (result.error.code === ERRORS.MISSING_OAUTH_PENDING) {
          setErrorMsg(t('oauth.bindMissingPending'))
        } else if (result.error.code === ERRORS.CSRF_TOKEN_INVALID) {
          setErrorMsg(t('oauth.bindCsrfInvalid'))
        } else if (result.error.code === ERRORS.PROVIDER_ALREADY_BOUND) {
          setErrorMsg(t('oauth.bindProviderTaken'))
        } else if (result.error.code === ERRORS.EMAIL_NOT_VERIFIED) {
          setErrorMsg(t('oauth.bindEmailNotVerified'))
        } else {
          setErrorMsg(result.error.message || t('oauth.bindError'))
        }
        setStatus('error')
        return
      }

      clearCsrfToken()
      setStatus('success')
      navigateTimerRef.current = setTimeout(() => navigate('/settings/security?toast=bind_success&tab=oauth', { replace: true }), 1500)
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
          <p style={{ color: 'var(--error-color)', fontSize: '0.9rem', marginBottom: '1rem' }} role="alert">{errorMsg}</p>
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
          accessToken={accessToken ?? ''}
        />
      )}
    </>
  )
}

