import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { get } from '@/api/client'
import { computePermissions, landingPath } from '@/api/permissions'
import { AdminButton, Alert, CenteredCard, PageHeader } from '@/components/ui'
import auth from './Auth.module.css'

export const Login = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const { loginWithPass, loginWithIam, user: authUser, loading: authLoading } = useAuth()
  const justLoggedInRef = useRef(false)

  // 仅当后端启用 IAM（配置完整）时才展示「统一身份登录(管理员)」入口
  const [iamEnabled, setIamEnabled] = useState(false)
  useEffect(() => {
    let active = true
    get<{ providers: string[] }>('/auth/oauth/providers').then((r) => {
      if (active && r.ok) setIamEnabled(r.data.providers.includes('iam'))
    })
    return () => {
      active = false
    }
  }, [])

  // Navigate after auth context loads full profile (with roles) from /v1/me
  // 优先消费 ?redirect= 深链参数（从 RequireAdminLayout 等守卫跳转而来）
  // 注意：redirect 必须通过白名单校验，防止开放重定向
  useEffect(() => {
    if (justLoggedInRef.current && authUser && !authLoading) {
      justLoggedInRef.current = false
      const redirect = searchParams.get('redirect')
      if (redirect && isValidRedirect(redirect)) {
        navigate(redirect, { replace: true })
        return
      }
      // 权限驱动跳转：进入「确实有权访问」的首个管理页，避免被各页守卫拒绝
      const perms = Array.isArray(authUser.permissions)
        ? authUser.permissions
        : computePermissions(authUser.roles ?? [])
      navigate(landingPath(perms), { replace: true })
    }
  }, [authUser, authLoading, navigate, searchParams])

  // 路由保护：已登录用户访问 /login 直接重定向走（修复 OAuth 回调 redirectAfter=/login
  // 时回到登录页、看似未登录的问题）。优先消费安全的 ?redirect=，否则前往个人资料页。
  useEffect(() => {
    if (authLoading || justLoggedInRef.current || !authUser) return
    const redirect = searchParams.get('redirect')
    const safe =
      redirect && redirect.startsWith('/') && !redirect.startsWith('//') && !/^\/(login|register)\b/.test(redirect)
        ? redirect
        : '/settings/security?tab=profile'
    navigate(safe, { replace: true })
  }, [authUser, authLoading, navigate, searchParams])

  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handlePassLogin = async () => {
    setError('')
    setSubmitting(true)
    try {
      await loginWithPass()
      // loginWithPass 会整页跳转到后端 OAuth 授权地址；正常情况下不会返回到此
    } catch {
      setError(t('login.errors.serverError'))
      setSubmitting(false)
    }
  }

  return (
    <CenteredCard>
      <PageHeader title={t('login.title')} description={t('login.description')} align="center" />

      <div className={auth.form}>
        <AdminButton type="button" variant="primary" fullWidth loading={submitting} onClick={handlePassLogin}>
          {t('login.passLogin')}
        </AdminButton>

        {error && <Alert tone="error">{error}</Alert>}

        {iamEnabled && (
          <>
            <div className={auth.divider}>{t('login.adminAlternative')}</div>
            <AdminButton
              type="button"
              variant="secondary"
              fullWidth
              onClick={loginWithIam}
              aria-label={t('oauth.providerIam')}
            >
              {t('oauth.providerIam')}
            </AdminButton>
          </>
        )}
      </div>
    </CenteredCard>
  )
}

/** 校验重定向 URL 防止开放重定向：仅允许站内相对路径 */
function isValidRedirect(url: string): boolean {
  if (!url.startsWith('/')) return false
  if (url.startsWith('//') || url.startsWith('/\\')) return false
  if (url.length > 200) return false
  try {
    // 用 URL 确保不包含非法协议结构
    const parsed = new URL(url, 'http://localhost')
    // 确认解析后的 pathname 与原 url 一致，防止 /%2Fevil.com 等编码绕过
    if (parsed.pathname !== url.split('?')[0]! && decodeURIComponent(parsed.pathname) !== url.split('?')[0]!)
      return false
    return true
  } catch {
    return false
  }
}
