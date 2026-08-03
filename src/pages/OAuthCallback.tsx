import { useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { computePermissions, landingPath } from '@/api/permissions'
import { isValidRedirect } from '@/utils/redirect'
import { StatusScreen } from '@/components/ui'

const BLOCKED_REASONS: Record<string, string> = {
  ACCOUNT_BANNED: 'oauth.blockedBanned',
  ACCOUNT_MERGED: 'oauth.blockedMerged',
  ACCOUNT_PENDING_DELETION: 'oauth.blockedPendingDeletion',
  ACCOUNT_DELETED: 'oauth.blockedDeleted',
} as const

const RETIRED_ACCOUNT_STATES = new Set([
  'pending_registration',
  'pending_binding',
  'bind_already_self',
  'bind_provider_taken',
  'bind_conflict_merge',
])

export const OAuthCallback = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { exchangeLoginCode } = useAuth()
  const processed = useRef(false)

  useEffect(() => {
    if (processed.current) return
    processed.current = true

    const handle = async () => {
      try {
        const status = searchParams.get('status')
        const loginCode = searchParams.get('loginCode')
        const code = searchParams.get('code') || ''

        if (status === 'login_ok') {
          if (!loginCode) {
            navigate('/auth/error?status=oauth_error', { replace: true })
            return
          }
          const user = await exchangeLoginCode(loginCode)
          if (!user) {
            navigate('/auth/error?status=login_blocked&reason=oauth.blockedUnknown', { replace: true })
            return
          }
          const redirectAfter = searchParams.get('redirectAfter') || ''
          const permissions = Array.isArray(user.permissions) ? user.permissions : computePermissions(user.roles ?? [])
          navigate(isValidRedirect(redirectAfter) ? redirectAfter : landingPath(permissions), { replace: true })
          return
        }

        if (status === 'login_blocked') {
          const reasonKey = BLOCKED_REASONS[code] || 'oauth.blockedUnknown'
          navigate(`/auth/error?status=login_blocked&code=${encodeURIComponent(code)}&reason=${reasonKey}`, { replace: true })
          return
        }

        if (status === 'bad_state') {
          navigate('/auth/error?status=bad_state', { replace: true })
          return
        }

        if (status === 'oauth_error' || status === 'oauth_provider_error') {
          navigate(`/auth/error?status=${status}`, { replace: true })
          return
        }

        if (status && RETIRED_ACCOUNT_STATES.has(status)) {
          navigate('/auth/error?status=oauth_error', { replace: true })
          return
        }

        navigate('/auth/error?status=oauth_error', { replace: true })
      } catch (error) {
        console.error('[OAuthCallback] Failed to process OAuth callback:', error)
        navigate('/auth/error?status=oauth_error', { replace: true })
      }
    }

    void handle()
  }, [exchangeLoginCode, navigate, searchParams])

  return <StatusScreen kind="loading" title={t('oauth.loading')} />
}
