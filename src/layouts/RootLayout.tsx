import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useMatches, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Navbar } from '../components/Navbar'
import { LicenseFooter } from '../components/LicenseFooter'
import { isAdminShellMatch, isNotFoundMatch, matchedTitleKey } from '../router/handles'
import { normalizePathname } from '../router/paths'
import styles from '../App.module.css'

const TOAST_MESSAGE_KEYS: Record<string, string> = {
  bind_already_self: 'common.toast.bindAlreadySelf',
  bind_provider_taken: 'common.toast.bindProviderTaken',
  bind_success: 'common.toast.bindSuccess',
  merge_success: 'common.toast.mergeSuccess',
  deletion_scheduled: 'common.toast.deletionScheduled',
  // 后台连续审稿：处理完一条后自动打开了下一条 / 当前筛选已经处理完
  review_next: 'common.toast.reviewNext',
  review_done: 'common.toast.reviewDone',
  review_next_failed: 'common.toast.reviewNextFailed',
  // 后台评论详情处理完退回列表
  comment_hidden: 'common.toast.commentHidden',
  comment_restored: 'common.toast.commentRestored',
}

const CloseIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)

/** 路由 → 页面标题 i18n key（WCAG 2.4.2 Page Titled + 路由播报）。 */
function titleKeyForPathname(pathname: string): string {
  if (pathname === '/') return 'pageTitles.home'
  if (pathname === '/search') return 'pageTitles.search'
  if (pathname === '/submit') return 'pageTitles.submit'
  if (pathname === '/login' || pathname === '/auth/login') return 'pageTitles.login'
  // 后台各页的标题由路由 handle.titleKey 给出（见 router/index.tsx），这里只兜 /admin 落点分流那一下。
  if (pathname === '/admin') return 'pageTitles.admin'
  if (pathname.startsWith('/settings')) return 'pageTitles.settings'
  if (pathname.startsWith('/me/contributions')) return 'pageTitles.myContributions'
  if (pathname.startsWith('/contributions/')) return 'pageTitles.contribution'
  if (pathname.startsWith('/auth/error')) return 'pageTitles.error'
  if (pathname === '/auth/callback') return 'pageTitles.authCallback'
  if (pathname === '/auth/step-up/done') return 'pageTitles.stepUp'
  return 'pageTitles.notFound'
}

export const RootLayout = () => {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const mainRef = useRef<HTMLElement>(null)

  /* 后台路由由 AdminShell 提供唯一的 <main>。按「是否匹配到 AdminShell 路由」判定，
     而不是看路径前缀：/admin/不存在 会落到通配 NotFound，那时 AdminShell 不渲染，
     RootLayout 必须自己给出 <main>，否则整页没有主内容地标。 */
  const matches = useMatches()
  const isAdminRoute = matches.some(isAdminShellMatch)
  const navigationType = useNavigationType()

  const [rateLimitToast, setRateLimitToast] = useState<string | null>(null)
  /* 按导航记录（location.key）记「已关闭」，而不是按提示类型：同一种提示（如连续审稿的
     「已打开下一条」）会在后续导航里再次出现，每一次都是新的提示，都要重新显示、重新计时。 */
  const [dismissedToastFor, setDismissedToastFor] = useState<string | null>(null)

  // 通配 404 按路由匹配判定：/admin/users/不存在 前缀像用户管理，实际渲染的是 404。
  const pageTitle = t(
    matches.some(isNotFoundMatch)
      ? 'pageTitles.notFound'
      : (matchedTitleKey(matches) ?? titleKeyForPathname(normalizePathname(location.pathname))),
  )

  // SPA 换页：更新 document.title（2.4.2）+ 焦点移入 main（配合 tabIndex={-1}）
  // + 读屏播报新页标题（简易 route announcer）。
  useEffect(() => {
    document.title = pageTitle
    if (isAdminRoute) return
    // 带 hash 且目标存在时让位：页面自己把焦点移到目标（父级 effect 晚于子页面执行）。
    if (location.hash && document.getElementById(location.hash.slice(1))) return
    mainRef.current?.focus({ preventScroll: true })
  }, [pageTitle, location.pathname, location.hash, isAdminRoute])

  /* 换页时把 main 的内部滚动归零：宽屏视口锁定页（data-viewport-fit）滚的是 main，
     它不随路由卸载，浏览器滚动恢复只认 document，新页面会继承上一页的半截位置。
     布局阶段执行，子页面随后的定位才是最终结果；带 hash 时让位给目标定位。 */
  useLayoutEffect(() => {
    if (location.hash) return
    mainRef.current?.scrollTo({ top: 0 })
    /* 其余页面（含后台）滚的是文档：前进导航（PUSH / REPLACE）回到顶部，否则从后台长列表
       点回首页会停在半截；后退 / 前进（POP）交给浏览器恢复原位置。
       navigationType 只在换页时读取，不作依赖：同页 replace（如清理 ?toast=）不应把页面拉回顶部。 */
    if (navigationType !== 'POP') window.scrollTo({ top: 0, behavior: 'instant' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.hash])

  const toastKey = searchParams.get('toast')
  const toastMessage =
    toastKey && TOAST_MESSAGE_KEYS[toastKey] && dismissedToastFor !== location.key
      ? t(TOAST_MESSAGE_KEYS[toastKey])
      : null

  // L15/A: Auto-dismiss and URL cleanup for ?toast= (supports SPA navigation)
  useEffect(() => {
    if (!toastKey || !TOAST_MESSAGE_KEYS[toastKey]) return

    const timer = setTimeout(() => {
      setDismissedToastFor(location.key)
      const params = new URLSearchParams(searchParams.toString())
      params.delete('toast')
      /* 保留 hash：丢掉它会让换页 effect 以为落点变了，把已定位到分区的页面拉回顶部。
         保留 state：replace 不带 state 会把这条历史记录的状态清空，页面靠它记的来源
         （如后台详情的返回落点）在刷新后就丢了。 */
      navigate({ search: params.toString(), hash: location.hash }, { replace: true, state: location.state })
    }, 4000)

    return () => clearTimeout(timer)
  }, [searchParams, navigate, toastKey, location.hash, location.key, location.state])
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

  /* 按顶级路由段重挂载、播放入场动效：查询参数 / hash 变化不重挂载丢状态；
     后台与账户的子路由切换只换内容、不重建侧栏。 */
  const page = (
    <div key={location.pathname.replace(/^(\/[^/]*).*$/, '$1')} className={styles.pageWrap}>
      <Outlet />
    </div>
  )

  return (
    <div className={styles.app}>
      {/* 后台的 <main id="admin-main"> 由 AdminShell 渲染，跳转链接按路由指向对应落点。 */}
      <a href={isAdminRoute ? '#admin-main' : '#main-content'} className={styles.skipLink}>
        {t('common.skipToContent')}
      </a>
      <Navbar />

      {isAdminRoute ? (
        <div className={styles.main}>{page}</div>
      ) : (
        <main ref={mainRef} id="main-content" className={styles.main} tabIndex={-1}>
          {page}
        </main>
      )}

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
              <CloseIcon />
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
              onClick={() => setDismissedToastFor(location.key)}
            >
              <CloseIcon />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
