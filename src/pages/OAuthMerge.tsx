import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { post, clearAuth, tryRefreshToken, clearCsrfToken } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { useAuth } from '@/context/useAuth'
import { StepUpDialog } from '@/components/StepUpDialog'
import { AdminButton, Alert, CenteredCard, PageHeader, StatusScreen } from '@/components/ui'
import shell from './Page.module.css'

export const OAuthMerge = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { accessToken, refreshUser } = useAuth()

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
        const newToken = await tryRefreshToken()
        if (newToken) {
          currentToken = newToken
        } else {
          setErrorMsg(t('oauth.mergeStepUpRequired'))
          setStatus('error')
          return
        }
      }

      const result = await post('/auth/merge', { mergeToken, confirm: true }, { csrf: true })

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
      // Try to refresh session — merge invalidates old access token (api.md §1.8)
      const refreshedUser = await refreshUser()
      if (refreshedUser) {
        setStatus('success')
        setTimeout(() => navigate('/?toast=merge_success', { replace: true }), 1500)
      } else {
        clearAuth()
        setStatus('success')
        setTimeout(() => navigate('/login?toast=merge_success', { replace: true }), 1500)
      }
    } catch {
      setErrorMsg(t('oauth.mergeError'))
      setStatus('error')
    }
  }

  const handleStepUpSuccess = () => {
    setShowStepUp(false)
    handleMerge()
  }

  if (status === 'success') {
    return <StatusScreen kind="success" title={t('oauth.mergeSuccess')} />
  }

  if (!mergeToken) {
    return (
      <StatusScreen
        kind="error"
        title={t('oauth.mergeTitle')}
        description={t('oauth.mergeTokenExpired')}
        actions={[{ label: t('common.backToHome'), to: '/' }]}
      />
    )
  }

  return (
    <>
      <CenteredCard>
        <PageHeader title={t('oauth.mergeTitle')} description={t('oauth.mergeDescription')} align="center" />
        {conflictUserId && (
          <p className={shell.subtleNote}>{t('oauth.mergeConflictUser', { user: conflictUserId })}</p>
        )}
        {status === 'error' && errorMsg && <Alert tone="error">{errorMsg}</Alert>}
        <AdminButton variant="danger" fullWidth loading={status === 'submitting'} onClick={handleMerge}>
          {t('oauth.mergeConfirm')}
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

