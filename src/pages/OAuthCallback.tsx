import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'

// login_blocked 子错误码文案映射
const BLOCKED_REASONS: Record<string, string> = {
  ACCOUNT_BANNED: 'oauth.blockedBanned',
  ACCOUNT_MERGED: 'oauth.blockedMerged',
  ACCOUNT_PENDING_DELETION: 'oauth.blockedPendingDeletion',
  ACCOUNT_DELETED: 'oauth.blockedDeleted',
} as const

export const OAuthCallback = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { exchangeLoginCode } = useAuth()

  useEffect(() => {
    const handle = async () => {
      const status = searchParams.get('status')
      const loginCode = searchParams.get('loginCode')
      const provider = searchParams.get('provider') || 'github'
      const code = searchParams.get('code') || ''
      const mergeToken = searchParams.get('mergeToken') || ''
      const conflictUserId = searchParams.get('conflictUserId') || ''

      switch (status) {
        case 'login_ok':
          if (!loginCode) {
            navigate('/submit?error=oauth_missing_code', { replace: true })
            return
          }
          {
            const user = await exchangeLoginCode(loginCode)
            if (user?.roles.includes('reviewer')) {
              navigate('/admin', { replace: true })
            } else {
              navigate('/submit', { replace: true })
            }
          }
          break

        case 'pending_registration':
          navigate(`/register?provider=${encodeURIComponent(provider)}`, { replace: true })
          break

        case 'pending_binding':
          // OAuth 身份待通过 1.6.5 绑定到当前账号，跳转到绑定确认页
          navigate(`/settings/security/oauth-bind/confirm?provider=${encodeURIComponent(provider)}`, { replace: true })
          break

        case 'bind_already_self':
          // 该 OAuth 已绑定到当前用户
          navigate('/settings/security?toast=bind_already_self', { replace: true })
          break

        case 'bind_provider_taken':
          // 当前账户在该 provider 下已有绑定，需先解绑
          navigate('/settings/security?toast=bind_provider_taken', { replace: true })
          break

        case 'bind_conflict_merge':
          // 该 OAuth 已绑定到其他用户，进入账号合并流程
          if (mergeToken) {
            navigate(`/auth/oauth/merge?mergeToken=${encodeURIComponent(mergeToken)}&conflictUserId=${encodeURIComponent(conflictUserId)}`, { replace: true })
          } else {
            navigate('/submit?error=oauth_merge_missing_token', { replace: true })
          }
          break

        case 'login_blocked': {
          // 账户状态拒绝登录，按子 code 显示对应文案
          const reasonKey = BLOCKED_REASONS[code] || 'oauth.blockedUnknown'
          navigate(`/auth/error?status=login_blocked&code=${encodeURIComponent(code)}&reason=${reasonKey}`, { replace: true })
          break
        }

        case 'bad_state':
          navigate('/auth/error?status=bad_state', { replace: true })
          break

        case 'oauth_error':
          navigate('/auth/error?status=oauth_error', { replace: true })
          break

        case 'oauth_provider_error':
          navigate('/auth/error?status=oauth_provider_error', { replace: true })
          break

        default:
          // 未知 status，安全兜底
          navigate('/submit', { replace: true })
          break
      }
    }
    handle()
  }, [searchParams, navigate, exchangeLoginCode])

  return (
    <main style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
      <p style={{ fontSize: '1.1rem', color: 'var(--text-muted)' }}>{t('oauth.loading')}</p>
    </main>
  )
}
