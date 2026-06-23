import { useState, useRef, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post, tryRefreshToken, clearCsrfToken } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { useAuth } from '@/context/useAuth'
import { StepUpDialog } from '@/components/StepUpDialog'
import { AdminButton, Alert, CenteredCard, PageHeader, StatusScreen } from '@/components/ui'

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

  if (status === 'success') {
    return <StatusScreen kind="success" title={t('oauth.bindSuccess', { provider: providerLabel })} />
  }

  return (
    <>
      <CenteredCard>
        <PageHeader
          title={t('oauth.bindTitle')}
          description={t('oauth.bindDescription', { provider: providerLabel })}
          align="center"
        />
        {status === 'error' && errorMsg && <Alert tone="error">{errorMsg}</Alert>}
        <AdminButton variant="primary" fullWidth loading={status === 'submitting'} onClick={handleBind}>
          {t('oauth.bindConfirm')}
        </AdminButton>
      </CenteredCard>

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

