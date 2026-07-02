import { useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { saveCsrfToken } from '@/api/client'
import { computePermissions, landingPath } from '@/api/permissions'
import { StatusScreen } from '@/components/ui'

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

  const processed = useRef(false)

  useEffect(() => {
    if (processed.current) return
    processed.current = true
    const handle = async () => {
      try {
        const status = searchParams.get('status')
        const loginCode = searchParams.get('loginCode')
        const provider = searchParams.get('provider') || 'github'
        const code = searchParams.get('code') || ''
        const mergeToken = searchParams.get('mergeToken') || ''
        const conflictUserId = searchParams.get('conflictUserId') || ''

        // Persist CSRF token to sessionStorage for registration/binding pages
        // 优先从 URL 参数读取（Pass 后端跨域 cookie 不可读时的兜底通道 — H1 方案 B），
        // cookie 作为同源场景的降级路径
        const csrfFromUrl = searchParams.get('csrfToken')
        if (csrfFromUrl) {
          saveCsrfToken(csrfFromUrl)
        } else {
          const csrfMatch = document.cookie.match(/oauth_pending_csrf=([^;]+)/)
          if (csrfMatch?.[1]) saveCsrfToken(csrfMatch[1])
        }

        switch (status) {
          case 'login_ok':
            if (!loginCode) {
              navigate('/submit?error=oauth_missing_code', { replace: true })
              return
            }
            {
              const user = await exchangeLoginCode(loginCode)
              if (!user) {
                navigate('/auth/error?status=login_blocked&reason=oauth.blockedUnknown', { replace: true })
                return
              }
              // Read redirectAfter from URL params and validate it's a safe relative path
              const redirectAfter = searchParams.get('redirectAfter') || ''
              const perms = Array.isArray(user.permissions) ? user.permissions : computePermissions(user.roles ?? [])
              // 安全相对路径且非鉴权页才采用，否则按权限落地，避免回到 /login、/register
              const safeRedirect =
                redirectAfter.startsWith('/') &&
                !redirectAfter.startsWith('//') &&
                !/^\/(login|register)\b/.test(redirectAfter)
                  ? redirectAfter
                  : landingPath(perms)
              navigate(safeRedirect, { replace: true })
            }
            break

          case 'pending_registration':
            navigate(`/register?provider=${encodeURIComponent(provider)}`, { replace: true })
            break

          case 'pending_binding':
            // OAuth 身份待通过 1.6.5 绑定到当前账号，跳转到绑定确认页
            navigate(`/settings/security/oauth-bind/confirm?provider=${encodeURIComponent(provider)}`, {
              replace: true,
            })
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
              navigate(
                `/auth/oauth/merge?mergeToken=${encodeURIComponent(mergeToken)}&conflictUserId=${encodeURIComponent(conflictUserId)}`,
                { replace: true },
              )
            } else {
              navigate('/submit?error=oauth_merge_missing_token', { replace: true })
            }
            break

          case 'login_blocked': {
            // 账户状态拒绝登录，按子 code 显示对应文案
            const reasonKey = BLOCKED_REASONS[code] || 'oauth.blockedUnknown'
            navigate(`/auth/error?status=login_blocked&code=${encodeURIComponent(code)}&reason=${reasonKey}`, {
              replace: true,
            })
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
      } catch (err) {
        console.error('[OAuthCallback] 处理 OAuth 回调时出错:', err)
        navigate('/auth/error?status=oauth_error', { replace: true })
      }
    }
    handle()
  }, [searchParams, navigate, exchangeLoginCode])

  return <StatusScreen kind="loading" title={t('oauth.loading')} />
}
