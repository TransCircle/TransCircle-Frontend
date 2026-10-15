import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, Outlet, useLocation, useMatches } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { normalizePathname } from '@/router/paths'
import { matchedAdminSection, matchedTitleKey, type AdminSection } from '@/router/handles'
import { cx, Spinner, StatusBadge } from '@/components/admin'
import { buttonClassName } from '@/components/admin/buttonClass'
import { BackIcon } from '@/components/ui/icons'
import { AdminHeaderContext, type AdminHeaderEntry } from './admin/header'
import { adminLandingPath, adminNavGroups } from './admin/nav'
import { AccessDenied } from './GuardStates'
import styles from './AdminShell.module.css'

/**
 * 左栏折叠阈值（与 Pass 控制台同值）：视口 <1280 时左栏收成 60px 图标条，≤768 变顶部横条。
 * 工作区内容按容器宽度自适应（container-type），不按视口，左栏折叠时不会出现反向跳变。
 */
const RAIL_COLLAPSE_AT = 1280

/**
 * 管理控制台外壳（与 Pass 门户 AdminLayout 同一结构）：站点顶栏保留，下方是
 * 分组的左栏分区导航 + 工作区（粘性玻璃标题栏 + 内容）。
 *
 * - /admin 本身不是页面：按权限落到首个可访问的分区（同 Pass），不会撞进一个没权限的页面；
 * - 标题栏内容由页面经 AdminHeaderContext 交上来（详情页的实体名、返回入口、状态徽标），
 *   页面还没交（懒加载中）时用路由 handle 的标题兜底；
 * - 当前分区由路由 handle 标出，详情页可以改成它真正所属的列表（投稿详情可能来自审核队列，
 *   也可能来自投稿管理）。
 *
 * 唯一的 <main id="admin-main"> 由这里持有（RootLayout 在后台路由下让位）。
 */
export const AdminShell = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading, permissions } = useAuth()
  const location = useLocation()
  const matches = useMatches()
  const [rail, setRail] = useState<'full' | 'mini'>(() =>
    typeof window !== 'undefined' && window.innerWidth < RAIL_COLLAPSE_AT ? 'mini' : 'full',
  )
  const railRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const shellPhase = authLoading ? 'loading' : user ? 'ready' : 'anonymous'

  const [headerEntry, setHeaderEntry] = useState<AdminHeaderEntry | null>(null)
  /* 内容相同就不写：页面每次渲染都会走一遍 effect，别让外壳跟着白白重渲染。 */
  const setHeader = useCallback((next: AdminHeaderEntry) => {
    setHeaderEntry((cur) =>
      cur &&
      cur.path === next.path &&
      cur.title === next.title &&
      cur.subtitle === next.subtitle &&
      cur.section === next.section &&
      cur.back?.to === next.back?.to &&
      cur.back?.label === next.back?.label &&
      cur.back?.focusRow === next.back?.focusRow &&
      cur.badge?.tone === next.badge?.tone &&
      cur.badge?.label === next.badge?.label
        ? cur
        : next,
    )
  }, [])

  /* 路由焦点：RootLayout 在后台路由下让位，由这里把焦点移入唯一的 <main>（配合 tabIndex=-1），
     与公共页同一约定。鉴权占位换成正式外壳时 main 会重建，也要重新接住。
     子页面已把焦点放进 main 时不抢。 */
  useEffect(() => {
    const main = mainRef.current
    if (!main || main.contains(document.activeElement)) return
    main.focus({ preventScroll: true })
  }, [location.pathname, shellPhase])

  useEffect(() => {
    const onResize = () => setRail(window.innerWidth < RAIL_COLLAPSE_AT ? 'mini' : 'full')
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* 只在标题栏属于当前路径时才用它：换页后、新页面交标题之前，不把上一页的标题、
     返回入口挂在新页上。 */
  const header = headerEntry?.path === location.pathname ? headerEntry : null
  const activeSection: AdminSection | undefined = header?.section ?? matchedAdminSection(matches)

  /* 窄屏下左栏是可横向滚动的分区条：换页后把当前项滚进可视范围。
     刻意不用 scrollIntoView——它会连带滚动所有祖先滚动容器（包括文档本身），
     点一下分区整页会纵向跳一截；这里只动分区条自己的 scrollLeft。 */
  useEffect(() => {
    const el = railRef.current
    if (!el) return
    const reveal = () => {
      if (el.scrollWidth <= el.clientWidth) return
      const active = el.querySelector<HTMLElement>('[aria-current="page"]')
      if (!active) return
      const railBox = el.getBoundingClientRect()
      const itemBox = active.getBoundingClientRect()
      if (itemBox.left < railBox.left) el.scrollLeft -= railBox.left - itemBox.left
      else if (itemBox.right > railBox.right) el.scrollLeft += itemBox.right - railBox.right
    }
    reveal()
    // 竖栏在 ≤768 变成横条只是 CSS 的事（rail 状态可能不变），尺寸一变就重新显露当前项。
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(reveal) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [location.pathname, authLoading, activeSection])

  // 鉴权中：只画加载态，但仍由这里给出唯一的 <main>（RootLayout 在后台路由下不渲染 main）。
  if (authLoading) {
    return (
      <main ref={mainRef} id="admin-main" className={styles.bootstrap} tabIndex={-1}>
        <Spinner size="lg" label={t('admin.verifying')} />
      </main>
    )
  }

  // 未登录：/admin 本身没有内层守卫（它只做分流），直接去登录并带回原地址；其余路由交给内层守卫。
  if (!user && normalizePathname(location.pathname) === '/admin') {
    return <Navigate to={`/auth/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />
  }
  if (!user) {
    return (
      <main ref={mainRef} id="admin-main" className={styles.bootstrap} tabIndex={-1}>
        <Outlet />
      </main>
    )
  }

  const groups = adminNavGroups(permissions)
  const isIndex = normalizePathname(location.pathname) === '/admin'

  // /admin 入口按权限落到首个可访问分区；一个分区都没有就直接说明，而不是落进某个 403 页面。
  if (isIndex) {
    const landing = adminLandingPath(permissions)
    if (landing) return <Navigate to={{ pathname: landing, search: location.search }} replace />
    return (
      <main ref={mainRef} id="admin-main" className={styles.bootstrap} tabIndex={-1}>
        <AccessDenied
          title={t('admin.accessDenied')}
          description={t('admin.accessDeniedDetail', { username: user.username })}
        />
      </main>
    )
  }

  const title = header?.title ?? t(matchedTitleKey(matches) ?? 'adminShell.brand')

  return (
    <div className={styles.shell} data-rail={rail}>
      <nav ref={railRef} className={styles.rail} aria-label={t('adminShell.navAriaLabel')}>
        {groups.map((group, gi) => (
          <div
            key={group.labelKey ?? `group-${gi}`}
            className={styles.navSection}
            role={group.labelKey ? 'group' : undefined}
            aria-labelledby={group.labelKey ? `admin-nav-${gi}` : undefined}
          >
            {group.labelKey && (
              <p id={`admin-nav-${gi}`} className={styles.navGroup}>
                {t(group.labelKey)}
              </p>
            )}
            {group.items.map((item) => {
              const active = item.section === activeSection
              return (
                <Link
                  key={item.section}
                  to={item.to}
                  title={t(item.labelKey)}
                  aria-current={active ? 'page' : undefined}
                  className={cx(styles.navItem, active && styles.navItemActive)}
                >
                  <span className={styles.navIcon} aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className={styles.navLabel}>{t(item.labelKey)}</span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      <div className={styles.work}>
        <header className={styles.topbar}>
          {header?.back && (
            <>
              <Link
                to={header.back.to}
                state={header.back.focusRow ? { focusRow: header.back.focusRow } : undefined}
                className={cx(buttonClassName('ghost', 'sm'), styles.back)}
                aria-label={header.back.label}
              >
                <BackIcon />
                <span className={styles.backLabel}>{header.back.label}</span>
              </Link>
              <span className={styles.crumbSep} aria-hidden="true" />
            </>
          )}
          <h1 className={styles.title}>{title}</h1>
          {header?.badge && <StatusBadge tone={header.badge.tone} label={header.badge.label} size="sm" />}
          {header?.subtitle && <p className={styles.subtitle}>{header.subtitle}</p>}
        </header>
        <main ref={mainRef} id="admin-main" className={styles.content} tabIndex={-1}>
          <AdminHeaderContext.Provider value={setHeader}>
            <Outlet />
          </AdminHeaderContext.Provider>
        </main>
      </div>
    </div>
  )
}
