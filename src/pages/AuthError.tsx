import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useEffect } from 'react'
import { StatusScreen } from '@/components/ui'

const ERROR_MESSAGES: Record<string, string> = {
  bad_state: 'oauth.errorBadState',
  oauth_error: 'oauth.errorOAuthError',
  oauth_provider_error: 'oauth.errorProviderError',
  login_blocked: 'oauth.errorLoginBlocked',
  bind_provider_taken: 'oauth.bindProviderTaken',
} as const

const BLOCKED_CODE_MESSAGES: Record<string, string> = {
  ACCOUNT_BANNED: 'oauth.blockedBanned',
  ACCOUNT_MERGED: 'oauth.blockedMerged',
  ACCOUNT_PENDING_DELETION: 'oauth.blockedPendingDeletion',
  ACCOUNT_DELETED: 'oauth.blockedDeleted',
} as const

const ALLOWED_REASONS = new Set([
  'oauth.blockedBanned',
  'oauth.blockedMerged',
  'oauth.blockedPendingDeletion',
  'oauth.blockedDeleted',
  'oauth.blockedUnknown',
])

export const AuthError = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const status = searchParams.get('status') || ''
  const code = searchParams.get('code') || ''
  const reasonKey = searchParams.get('reason') || ''

  useEffect(() => {
    // Log the error for debugging (api.md §12.3: requestId should be used for troubleshooting)
    console.warn(`[auth] OAuth error: status=${status} code=${code}`)
  }, [status, code])

  // login_blocked: use code to distinguish specific ban reasons (api.md §1.6.2)
  const messageKey = status === 'login_blocked' && BLOCKED_CODE_MESSAGES[code]
    ? BLOCKED_CODE_MESSAGES[code]
    : (ERROR_MESSAGES[status] || (ALLOWED_REASONS.has(reasonKey) ? reasonKey : 'oauth.errorDescription'))

  return (
    <StatusScreen
      kind="error"
      title={t('oauth.errorTitle')}
      description={t(messageKey)}
      detail={code ? `(${code})` : undefined}
      actions={[{ label: t('oauth.errorBackToHome'), variant: 'secondary', onClick: () => navigate('/', { replace: true }) }]}
    />
  )
}
