import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Navbar } from '../components/Navbar'
import { LicenseFooter } from '../components/LicenseFooter'
import styles from '../App.module.css'

const TOAST_MESSAGE_KEYS: Record<string, string> = {
  bind_already_self: 'common.toast.bindAlreadySelf',
  bind_provider_taken: 'common.toast.bindProviderTaken',
  bind_success: 'common.toast.bindSuccess',
  merge_success: 'common.toast.mergeSuccess',
  deletion_scheduled: 'common.toast.deletionScheduled',
}

/** 路由 → 页面标题 i18n key（WCAG 2.4.2 Page Titled + 路由播报）。 */
function titleKeyForPathname(pathname: string): string {
  if (pathname === '/') return 'pageTitles.home'
  if (pathname === '/submit') return 'pageTitles.submit'
  if (pathname === '/login' || pathname === '/auth/login') return 'pageTitles.login'
  if (pathname === '/admin') return 'pageTitles.admin'
  if (pathname.startsWith('/admin/edit-requests')) return 'pageTitles.editRequests'
  if (pathname.startsWith('/admin/audit-logs')) return 'pageTitles.auditLogs'
  if (pathname.startsWith('/admin/users')) return 'pageTitles.users'
  if (pathname.startsWith('/admin/comments')) return 'pageTitles.comments'
  if (pathname.startsWith('/settings')) return 'pageTitles.settings'
  if (pathname.startsWith('/me/contributions')) return 'pageTitles.myContributions'
  if (pathname.startsWith('/contributions/')) return 'pageTitles.contribution'
  if (pathname.startsWith('/auth/error')) return 'pageTitles.error'
  return 'pageTitles.notFound'
}

export const RootLayout = () => {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()

  // 后台路由占满宽度并由 AdminShell 提供唯一的 <main>；非后台路由渲染路径保持不变。
  const isAdminRoute = location.pathname === '/admin' || location.pathname.startsWith('/admin/')
  const MainWrapper = isAdminRoute ? 'div' : 'main'

  const [rateLimitToast, setRateLimitToast] = useState<string | null>(null)
  const [dismissedToastKey, setDismissedToastKey] = useState<string | null>(null)

  const pageTitle = t(titleKeyForPathname(location.pathname))

  // SPA 换页：更新 document.title（2.4.2）+ 焦点移入 main（配合 tabIndex={-1}）
  // + 读屏播报新页标题（简易 route announcer）。
  useEffect(() => {
    document.title = pageTitle
    const main = document.querySelector<HTMLElement>('main')
    if (main && !location.pathname.startsWith('/admin')) {
      main.focus({ preventScroll: true })
    }
  }, [pageTitle, location.pathname])

  const toastKey = searchParams.get('toast')
  const toastMessage =
    toastKey && TOAST_MESSAGE_KEYS[toastKey] && dismissedToastKey !== toastKey ? t(TOAST_MESSAGE_KEYS[toastKey]) : null

  // L15/A: Auto-dismiss and URL cleanup for ?toast= (supports SPA navigation)
  useEffect(() => {
    if (!toastKey || !TOAST_MESSAGE_KEYS[toastKey]) return

    const timer = setTimeout(() => {
      setDismissedToastKey(toastKey)
      const params = new URLSearchParams(searchParams.toString())
      params.delete('toast')
      navigate({ search: params.toString() }, { replace: true })
    }, 4000)

    return () => clearTimeout(timer)
  }, [searchParams, navigate, toastKey])
  // L1: Listen for API rate-limit events
  useEffect(() => {
    /* 定时器 id 要留着：连着来两次限流时，第一条的定时器若不取消，它到点会把
       第二条（还没到期的）提示一起清掉。卸载时同样要清，否则会在已卸载的
       组件上 setState。 */
    let hideTimer: number | null = null
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const retryAfter = detail?.retryAfter
      if (retryAfter) {
        if (hideTimer !== null) window.clearTimeout(hideTimer)
        setRateLimitToast(t('common.rateLimitHint', { seconds: retryAfter }))
        hideTimer = window.setTimeout(() => setRateLimitToast(null), Math.min(retryAfter * 1000, 15000))
      }
    }
    window.addEventListener('api:rate-limit', handler)
    return () => {
      window.removeEventListener('api:rate-limit', handler)
      if (hideTimer !== null) window.clearTimeout(hideTimer)
    }
  }, [t])

  return (
    <div className={`${styles.appContainer} ${isAdminRoute ? styles.appContainerAdmin : ''}`}>
      {!isAdminRoute && (
        <a href="#main-content" className={styles.skipLink}>
          {t('common.skipToContent')}
        </a>
      )}
      <Navbar />

      <MainWrapper
        id={isAdminRoute ? undefined : 'main-content'}
        className={`${styles.mainContent} ${isAdminRoute ? styles.mainContentAdmin : ''}`}
        tabIndex={-1}
      >
        <Outlet />
      </MainWrapper>

      <LicenseFooter />

      {/* 路由播报：读屏用户在 SPA 换页时听到新页标题。 */}
      <div role="status" className={styles.srOnly}>
        {pageTitle}
      </div>

      {/* 右下堆叠容器（§5.7）：多条 toast 自然纵向堆叠，不互相覆盖。 */}
      <div className={styles.toastStack} aria-live="off">
        {rateLimitToast && (
          <div className={styles.toastError} role="alert">
            <span>{rateLimitToast}</span>
            <button
              type="button"
              className={styles.toastClose}
              aria-label={t('common.close')}
              onClick={() => setRateLimitToast(null)}
            >
              ×
            </button>
          </div>
        )}
        {toastMessage && (
          <div className={styles.toastInfo} role="status">
            <span>{toastMessage}</span>
            <button
              type="button"
              className={styles.toastClose}
              aria-label={t('common.close')}
              onClick={() => setDismissedToastKey(toastKey)}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
