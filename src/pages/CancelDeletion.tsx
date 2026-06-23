import { useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { StatusScreen } from '@/components/ui'

/**
 * Cancel account deletion page (api.md §2.5).
 * Reads cancelToken from email link query param, immediately redirects to
 * the security settings page where the cancel form lives.  The token is
 * passed via router state so SettingsSecurity can auto-fill the field
 * instead of requiring the user to re-enter it manually (C1).
 */
export const CancelDeletion = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const tokenFromUrl = searchParams.get('token') || ''

  useEffect(() => {
    if (tokenFromUrl) {
      navigate('/settings/security?tab=profile', {
        replace: true,
        state: { cancelToken: tokenFromUrl },
      })
    }
  }, [tokenFromUrl, navigate])

  // With a token we redirect immediately — show a transient loading screen.
  if (tokenFromUrl) {
    return (
      <StatusScreen
        kind="loading"
        title={t('settings.cancelDeletionHeading')}
        description={t('settings.cancelDeletionDescription')}
      />
    )
  }

  return (
    <StatusScreen
      kind="info"
      title={t('settings.cancelDeletionHeading')}
      description={t('settings.cancelDeletionDescription')}
      actions={[{ label: t('common.backToHome'), to: '/settings/security', variant: 'secondary' }]}
    />
  )
}
