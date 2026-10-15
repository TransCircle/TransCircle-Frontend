import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ThemeToggle } from './ThemeToggle'
import { FlagStripe } from './FlagStripe'
import { cx } from './admin/cx'
import { useAuth } from '@/context/useAuth'
import { landingPath, ROLE_LABEL_KEYS } from '@/api/permissions'
import { LOGOUT_REDIRECT } from '@/config'
import { hasModalLayer } from '@/components/admin/modalStack'
import { lockScroll, unlockScroll } from '@/components/admin/scrollLock'
import { normalizePathname } from '@/router/paths'
import styles from './Navbar.module.css'

/** 折叠断点：与 Navbar.module.css 的 `@media (max-width: 1024px)` 互指（同 Pass 门户）。 */
const MOBILE_BREAKPOINT = 1024

/** 账户菜单悬停关闭的延时：留出指针从头像跨到菜单的时间（菜单顶部间隙 6px）。 */
const HOVER_CLOSE_DELAY_MS = 140

/** 抽屉内的可聚焦元素选择器（打开时的初始聚焦与 Tab 循环共用）。 */
const DRAWER_FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

const ExternalIcon = () => (
  <svg
    className={styles.extIcon}
    width="12"
    height="12"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M6 2h8v8" />
    <path d="M14 2 4 12" />
  </svg>
)

const ChevronIcon = () => (
  <svg
    className={styles.chevron}
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
)

const CloseIcon = () => (
  <svg
    width="20"
    height="20"
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

/** 站内一级入口（顶栏横排 + 抽屉）。 */
interface PrimaryLink {
  to: string
  labelKey: string
}

const PRIMARY_LINKS: PrimaryLink[] = [
  { to: '/', labelKey: 'nav.home' },
  { to: '/search', labelKey: 'nav.search' },
  { to: '/submit', labelKey: 'nav.submit' },
]

/** 「更多」下拉：项目组其他站点（名称与 transcircle.org 首页「项目列表」一致）。 */
interface MoreLink {
  labelKey: string
  /** 无 href = 预告项（还没有站点），不可点击。 */
  href?: string
  /** 成员个人维护的外部站：标「外部」并加 nofollow。 */
  external?: boolean
}

const MORE_LINKS: MoreLink[] = [
  { labelKey: 'nav.mainSite', href: 'https://transcircle.org/' },
  { labelKey: 'nav.community', href: 'https://community.transcircle.org/' },
  { labelKey: 'nav.blog', href: 'https://blog.transcircle.org/' },
  { labelKey: 'nav.contentSearch', href: 'https://search.transcircle.org/', external: true },
  { labelKey: 'nav.archive' },
]

const relFor = (l: MoreLink) => (l.external ? 'nofollow noopener noreferrer' : 'noopener noreferrer')

/**
 * role=menu 的键盘契约（同 Pass useMenuKeyboard）：显式打开即聚焦首个 menuitem，
 * ArrowUp/Down 循环、Home/End 跳首尾、Esc 关闭并把焦点还给触发器、Tab 关闭。
 */
function useMenuKeyboard(
  open: boolean,
  close: () => void,
  menuRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  /** 打开时把焦点放到哪一项：first / last；null = 悬停打开，不抢鼠标用户的焦点。 */
  focusOnOpenRef: RefObject<'first' | 'last' | null>,
): void {
  useEffect(() => {
    if (!open) return
    const menu = menuRef.current
    if (!menu) return
    const items = () => focusableMenuItems(menu)
    // 悬停打开不抢鼠标用户的焦点；点击 / ↓ 打开聚焦首项，↑ 打开聚焦末项。
    const initial = focusOnOpenRef.current
    if (initial === 'first') items()[0]?.focus()
    else if (initial === 'last') items()[items().length - 1]?.focus()
    const onKey = (e: KeyboardEvent) => {
      const nodes = items()
      if (nodes.length === 0) return
      const idx = nodes.indexOf(document.activeElement as HTMLElement)
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          nodes[(idx + 1) % nodes.length]?.focus()
          break
        case 'ArrowUp':
          e.preventDefault()
          nodes[(idx - 1 + nodes.length) % nodes.length]?.focus()
          break
        case 'Home':
          e.preventDefault()
          nodes[0]?.focus()
          break
        case 'End':
          e.preventDefault()
          nodes[nodes.length - 1]?.focus()
          break
        case 'Escape':
          close()
          triggerRef.current?.focus()
          break
        case 'Tab':
          close()
          break
      }
    }
    menu.addEventListener('keydown', onKey)
    return () => menu.removeEventListener('keydown', onKey)
  }, [open, close, menuRef, triggerRef, focusOnOpenRef])
}

/** 菜单内可聚焦的项：原生 disabled 的项（如退出请求进行中）收不到焦点，排除在方向键序列之外。 */
function focusableMenuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
    (el) => !(el instanceof HTMLButtonElement && el.disabled),
  )
}

/** 触发器上的方向键：未打开则打开并聚焦首/末项，已（悬停）打开则把焦点送进菜单。 */
function arrowIntoMenu(
  e: ReactKeyboardEvent<HTMLButtonElement>,
  open: boolean,
  setOpen: (v: boolean) => void,
  menuRef: RefObject<HTMLElement | null>,
  focusOnOpenRef: RefObject<'first' | 'last' | null>,
) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  if (!open) {
    focusOnOpenRef.current = e.key === 'ArrowDown' ? 'first' : 'last'
    setOpen(true)
    return
  }
  const items = focusableMenuItems(menuRef.current)
  ;(e.key === 'ArrowDown' ? items[0] : items[items.length - 1])?.focus()
}

export const Navbar = () => {
  const { t } = useTranslation()
  const { user, isAdmin, permissions, logout, loginWithPass } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  // 管理入口：/admin 由后台外壳按权限落到首个可访问的分区（口径见 api/permissions.ts canEnterAdmin）
  const adminEntry = landingPath(permissions)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [acctOpen, setAcctOpen] = useState(false)
  const [loginStarting, setLoginStarting] = useState(false)
  const [logoutPending, setLogoutPending] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  const hamburgerRef = useRef<HTMLButtonElement>(null)
  const brandRef = useRef<HTMLAnchorElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const moreMenuRef = useRef<HTMLUListElement>(null)
  const moreFocusOnOpen = useRef<'first' | 'last' | null>('first')
  const acctRef = useRef<HTMLDivElement>(null)
  const acctBtnRef = useRef<HTMLButtonElement>(null)
  const acctMenuRef = useRef<HTMLUListElement>(null)
  const acctFocusOnOpen = useRef<'first' | 'last' | null>('first')
  /** 最近一次按下头像的指针类型：鼠标点击只保证「打开」（开合交给悬停），触屏/键盘点击切换。 */
  const acctPointerType = useRef('')
  const acctCloseTimer = useRef<number | null>(null)

  // 当前项：只有站内一级入口参与，外链与预告项永远不是「当前页」。
  const currentPath = normalizePathname(location.pathname)
  const activeTo = PRIMARY_LINKS.find((l) => l.to === currentPath)?.to ?? null

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    hamburgerRef.current?.focus()
  }, [])

  // OIDC 登录跳转：state 驱动，失败/异常必须复位——否则一次失败的跳转后
  // 按钮变成「点了没有任何反应」的死控件。
  // 从抽屉发起时关抽屉并把焦点还给汉堡：跳转前（或跳转失败后）焦点不能留在 inert 的抽屉里。
  const startPassLogin = (fromDrawer: boolean) => {
    if (loginStarting) return
    setLoginStarting(true)
    if (fromDrawer) closeDrawer()
    void loginWithPass().catch(() => setLoginStarting(false))
  }

  /* 菜单项激活后关菜单，焦点先还给触发器：外链 / Ctrl+点击在新标签打开、当前页链接不换页，
     这些情况都没有路由焦点接管，被卸载的菜单项会把焦点丢到 body；真正换页时
     RootLayout / AdminShell 随后再把焦点移入 main。 */
  const closeMenuFromItem = (setOpen: (v: boolean) => void, triggerRef: RefObject<HTMLButtonElement | null>) => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  // fromDrawer：同 startPassLogin——退出后抽屉里的按钮卸载，焦点要交还汉堡（同路径跳转没有路由焦点接管）。
  const doLogout = async (fromDrawer: boolean) => {
    if (logoutPending) return
    setLogoutError(null)
    setLogoutPending(true)
    try {
      await logout()
      setAcctOpen(false)
      // 头像与菜单随用户一起卸载：抽屉入口交还汉堡，桌面入口交给品牌链接（换页时 main 随后接管）。
      if (fromDrawer) closeDrawer()
      else brandRef.current?.focus()
      if (LOGOUT_REDIRECT.startsWith('/')) {
        navigate(LOGOUT_REDIRECT, { replace: true })
      } else {
        window.location.href = LOGOUT_REDIRECT
      }
    } catch {
      setLogoutError(t('nav.logoutFailed'))
    } finally {
      setLogoutPending(false)
    }
  }

  /* ── 当前项下方的迷你旗帜条纹：一条独立元素在各项之间滑动 ──────── */
  const linksRowRef = useRef<HTMLDivElement>(null)
  const [stripe, setStripe] = useState<{ x: number; ready: boolean } | null>(null)
  useLayoutEffect(() => {
    const row = linksRowRef.current
    if (!row) return
    const place = () => {
      const el = activeTo ? row.querySelector<HTMLElement>(`[data-nav-to="${activeTo}"]`) : null
      if (!el || el.offsetWidth === 0) {
        setStripe(null)
        return
      }
      const x = el.offsetLeft + el.offsetWidth / 2
      // 首次定位不做过渡（否则会从最左侧滑进来）；之后的切换才滑动。
      setStripe((prev) => ({ x, ready: prev !== null }))
    }
    place()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
    ro?.observe(row)
    return () => ro?.disconnect()
  }, [activeTo, t])

  // 路由变化时关闭抽屉与下拉——防止 guard 重定向 / navigate() 后 main 停在 inert。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrawerOpen(false)
    setMoreOpen(false)
    setAcctOpen(false)
    if (acctCloseTimer.current !== null) {
      window.clearTimeout(acctCloseTimer.current)
      acctCloseTimer.current = null
    }
  }, [location.pathname])

  useEffect(
    () => () => {
      if (acctCloseTimer.current !== null) window.clearTimeout(acctCloseTimer.current)
    },
    [],
  )

  // 抽屉打开：<main> 设 inert（仅抽屉可见的窄屏下），焦点移入抽屉。
  // 不缓存 DOM 引用：React 19 StrictMode 双重渲染会留下过期引用，清理与设置都直接重新查询。
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('main')
    if (el && window.innerWidth <= MOBILE_BREAKPOINT) el.inert = drawerOpen
    if (drawerOpen) {
      requestAnimationFrame(() => {
        drawerRef.current?.querySelector<HTMLElement>(DRAWER_FOCUSABLE)?.focus()
      })
    }
    return () => {
      const main = document.querySelector<HTMLElement>('main')
      if (main) main.inert = false
    }
  }, [drawerOpen])

  // 抽屉打开：共享滚动锁（不冻结 body，粘性顶栏与汉堡关闭键留在原位）+ Esc / Tab 循环 + 变宽自动关闭。
  useEffect(() => {
    if (!drawerOpen) return
    lockScroll({ fixedBody: false })
    const handleKeyDown = (e: KeyboardEvent) => {
      /* 有浮层开着（确认弹窗、理由弹窗、step-up…）：键盘归它管，抽屉必须让开，
         否则 Tab 会被拽回抽屉，顶层 aria-modal 对话框的焦点陷阱形同虚设。 */
      if (hasModalLayer()) return
      if (e.key === 'Escape') {
        closeDrawer()
        return
      }
      if (e.key !== 'Tab') return
      const el = drawerRef.current
      if (!el) return
      const nodes = Array.from(el.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      )
      if (nodes.length === 0) return
      const first = nodes[0]!
      const last = nodes[nodes.length - 1]!
      const active = document.activeElement
      if (!el.contains(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    const handleResize = () => {
      if (window.innerWidth <= MOBILE_BREAKPOINT) return
      // 宽屏下汉堡隐藏：焦点若还在（即将 inert 的）抽屉里，交给顶栏品牌链接。
      if (drawerRef.current?.contains(document.activeElement)) brandRef.current?.focus()
      setDrawerOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)
    return () => {
      unlockScroll()
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleResize)
    }
  }, [drawerOpen, closeDrawer])

  /* 跨入折叠断点时横排（含「更多」）被隐藏：收起下拉；焦点若在被隐藏的横排里，交给汉堡按钮。 */
  useEffect(() => {
    if (!moreOpen) return
    const onResize = () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) return
      const focusInRow = linksRowRef.current?.contains(document.activeElement)
      setMoreOpen(false)
      if (focusInRow) hamburgerRef.current?.focus()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [moreOpen])

  /* 点击外部关闭下拉；Esc 在菜单外也能关（悬停打开时焦点并不在菜单里）。
     焦点在菜单内的 Esc 由 useMenuKeyboard 处理并把焦点还给触发器。 */
  useEffect(() => {
    if (!moreOpen && !acctOpen) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (moreRef.current && !moreRef.current.contains(target)) setMoreOpen(false)
      if (acctRef.current && !acctRef.current.contains(target)) setAcctOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || hasModalLayer()) return
      setMoreOpen(false)
      setAcctOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen, acctOpen])

  // close 回调必须引用稳定：菜单打开期间的任意重渲染都不能重跑「聚焦首项」。
  const closeMore = useCallback(() => setMoreOpen(false), [])
  const closeAcct = useCallback(() => setAcctOpen(false), [])
  useMenuKeyboard(moreOpen, closeMore, moreMenuRef, moreBtnRef, moreFocusOnOpen)
  useMenuKeyboard(acctOpen, closeAcct, acctMenuRef, acctBtnRef, acctFocusOnOpen)

  // 焦点离开下拉区域（Tab 出去）时收起。
  const closeOnBlur = (setOpen: (v: boolean) => void) => (e: React.FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false)
  }

  /* 账户菜单：桌面鼠标悬停打开、移出延时关闭；触屏 / 触控笔 / 键盘点击切换。
     用事件的 pointerType 判定真实鼠标：触屏笔记本的主指针也报告为可 hover 的 fine 指针，
     按媒体查询判定会让手指点击「点开即关」。 */
  const openAcctHover = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return
    if (acctCloseTimer.current !== null) {
      window.clearTimeout(acctCloseTimer.current)
      acctCloseTimer.current = null
    }
    acctFocusOnOpen.current = null
    setAcctOpen(true)
  }
  const closeAcctHover = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return
    acctCloseTimer.current = window.setTimeout(() => {
      // 键盘正在菜单里操作（焦点在菜单项上）：鼠标偶然移出不收起，交给 Esc / Tab / 失焦。
      if (acctMenuRef.current?.contains(document.activeElement)) return
      setAcctOpen(false)
    }, HOVER_CLOSE_DELAY_MS)
  }

  const displayName = user ? user.displayName || user.username : ''
  const primaryRole = user?.roles?.[0]
  /** 角色说明（原先画在后台顶栏）：只对有管理权限的用户显示。 */
  const roleLabel = isAdmin && primaryRole ? t(ROLE_LABEL_KEYS[primaryRole] ?? primaryRole) : null
  const logoutLabel = logoutPending ? t('nav.loggingOut') : t('nav.logout')

  /* 品牌组合：正式横版 logo（不改动）+ 细分隔线 + 本站站名。顶栏是每一页都看得到的地方——
     从分享链接直接落到故事页的读者也能一眼认出「这里是 TransCircle 的故事分享」，
     而不是和主站一模一样的顶栏。 */
  const brandLockup = (
    <>
      {/* ≤480px 横版 logo 放不下站名：换成单独的圆环图标（logo 规范允许图标单独使用）。 */}
      <span className={styles.brandFull}>
        <img
          className={cx(styles.brandLogo, styles.brandLogoLight)}
          src="/brand/transcircle-horizontal-on-light.svg"
          width={400}
          height={120}
          alt=""
          aria-hidden="true"
        />
        <img
          className={cx(styles.brandLogo, styles.brandLogoDark)}
          src="/brand/transcircle-horizontal-on-dark.svg"
          width={400}
          height={120}
          alt=""
          aria-hidden="true"
        />
      </span>
      <img
        className={styles.brandIcon}
        src="/brand/transcircle-icon.svg"
        width={32}
        height={32}
        alt=""
        aria-hidden="true"
      />
      <span className={styles.brandDivider} aria-hidden="true" />
      <span className={styles.brandSite}>{t('nav.siteName')}</span>
    </>
  )

  return (
    <>
      <nav className={styles.nav} aria-label={t('nav.ariaLabel')}>
        <div className={styles.inner}>
          <div className={styles.left}>
            <button
              ref={hamburgerRef}
              type="button"
              className={styles.hamburger}
              onClick={() => (drawerOpen ? closeDrawer() : setDrawerOpen(true))}
              aria-label={drawerOpen ? t('nav.closeMenu') : t('nav.openMenu')}
              aria-expanded={drawerOpen}
              aria-controls="nav-drawer"
            >
              <span className={styles.bar} />
              <span className={styles.bar} />
              <span className={styles.bar} />
            </button>
            <Link ref={brandRef} to="/" className={styles.brand} aria-label={t('nav.logo')}>
              {brandLockup}
            </Link>
          </div>

          <div ref={linksRowRef} className={styles.links}>
            {PRIMARY_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                data-nav-to={l.to}
                className={cx(styles.link, activeTo === l.to && styles.linkActive)}
                aria-current={activeTo === l.to ? 'page' : undefined}
              >
                {t(l.labelKey)}
              </Link>
            ))}

            {/* 本站功能与项目组其他站点之间的分隔（同博客顶栏「│ 主站」）。 */}
            <span className={styles.linksDivider} aria-hidden="true" />

            <div ref={moreRef} className={styles.dropdown} onBlur={closeOnBlur(setMoreOpen)}>
              <button
                ref={moreBtnRef}
                type="button"
                className={styles.link}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => {
                  moreFocusOnOpen.current = 'first'
                  setMoreOpen((o) => !o)
                }}
                onKeyDown={(e) => arrowIntoMenu(e, moreOpen, setMoreOpen, moreMenuRef, moreFocusOnOpen)}
              >
                {t('nav.more')}
                <ChevronIcon />
              </button>
              {moreOpen && (
                <ul ref={moreMenuRef} className={styles.menu} role="menu" aria-label={t('nav.more')}>
                  {MORE_LINKS.map((l) => (
                    <li key={l.labelKey} role="none">
                      {l.href ? (
                        <a
                          role="menuitem"
                          href={l.href}
                          target="_blank"
                          rel={relFor(l)}
                          className={styles.menuItem}
                          onClick={() => closeMenuFromItem(setMoreOpen, moreBtnRef)}
                        >
                          <span className={styles.menuLabel}>
                            {t(l.labelKey)}
                            {l.external && <span className={styles.tag}>{t('nav.externalTag')}</span>}
                          </span>
                          <ExternalIcon />
                        </a>
                      ) : (
                        /* 预告项：没有跳转目标，点了什么都不会发生。仍保留 menuitem + tabIndex=-1，
                           方向键能走到它（否则键盘 / 读屏用户不知道它存在），aria-disabled 说明现在不可用。 */
                        <span
                          role="menuitem"
                          aria-disabled="true"
                          tabIndex={-1}
                          className={cx(styles.menuItem, styles.menuItemMuted)}
                        >
                          <span className={styles.menuLabel}>{t(l.labelKey)}</span>
                          <span className={styles.pending}>{t('nav.inDevelopment')}</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 当前项指示：24×3px 迷你旗帜条纹（§3.1 / §5.3），随当前项滑动；语义由 aria-current 承担。 */}
            {stripe && (
              <FlagStripe
                variant="mini"
                className={cx(styles.activeStripe, stripe.ready && styles.activeStripeAnimated)}
                style={{ '--stripe-x': `${stripe.x}px` } as CSSProperties}
              />
            )}
          </div>

          <div className={styles.right}>
            <ThemeToggle />

            {user ? (
              <div
                ref={acctRef}
                className={styles.dropdown}
                onPointerEnter={openAcctHover}
                onPointerLeave={closeAcctHover}
                onBlur={closeOnBlur(setAcctOpen)}
              >
                <button
                  ref={acctBtnRef}
                  type="button"
                  className={styles.acctBtn}
                  aria-haspopup="menu"
                  aria-expanded={acctOpen}
                  aria-label={
                    roleLabel
                      ? t('nav.accountLabelWithRole', { name: displayName, role: roleLabel })
                      : t('nav.accountLabel', { name: displayName })
                  }
                  onPointerDown={(e) => {
                    acctPointerType.current = e.pointerType
                  }}
                  onClick={() => {
                    acctFocusOnOpen.current = 'first'
                    if (acctPointerType.current === 'mouse') setAcctOpen(true)
                    else setAcctOpen((o) => !o)
                    acctPointerType.current = ''
                  }}
                  onKeyDown={(e) => arrowIntoMenu(e, acctOpen, setAcctOpen, acctMenuRef, acctFocusOnOpen)}
                >
                  {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className={styles.avatar} width={34} height={34} />
                  ) : (
                    <span className={styles.avatarFallback} aria-hidden="true">
                      {displayName.charAt(0).toUpperCase()}
                    </span>
                  )}
                </button>
                {acctOpen && (
                  <ul ref={acctMenuRef} className={cx(styles.menu, styles.menuRight)} role="menu">
                    {/* 身份抬头：当前是谁 / 什么角色。触发器的可访问名已含姓名与角色，
                        这里对读屏隐藏，避免 role=menu 里混入非菜单项。 */}
                    <li role="none" aria-hidden="true" className={styles.menuHeader}>
                      <span className={styles.menuHeaderName}>{displayName}</span>
                      {roleLabel && <span className={styles.menuHeaderMeta}>{roleLabel}</span>}
                    </li>
                    <li role="separator" className={styles.menuSeparator} />
                    <li role="none">
                      <Link
                        role="menuitem"
                        to="/me/contributions"
                        className={styles.menuItem}
                        onClick={() => closeMenuFromItem(setAcctOpen, acctBtnRef)}
                      >
                        {t('nav.myContributions')}
                      </Link>
                    </li>
                    <li role="none">
                      <Link
                        role="menuitem"
                        to="/settings/security"
                        className={styles.menuItem}
                        onClick={() => closeMenuFromItem(setAcctOpen, acctBtnRef)}
                      >
                        {t('nav.securitySettings')}
                      </Link>
                    </li>
                    {isAdmin && (
                      <li role="none">
                        <Link
                          role="menuitem"
                          to={adminEntry}
                          className={styles.menuItem}
                          onClick={() => closeMenuFromItem(setAcctOpen, acctBtnRef)}
                        >
                          {t('nav.adminDashboard')}
                        </Link>
                      </li>
                    )}
                    <li role="separator" className={styles.menuSeparator} />
                    <li role="none">
                      <button
                        role="menuitem"
                        type="button"
                        className={styles.menuItem}
                        disabled={logoutPending}
                        aria-busy={logoutPending}
                        onClick={() => void doLogout(false)}
                      >
                        {logoutLabel}
                      </button>
                    </li>
                  </ul>
                )}
              </div>
            ) : (
              <button
                type="button"
                className={styles.loginBtn}
                disabled={loginStarting}
                aria-busy={loginStarting}
                onClick={() => startPassLogin(false)}
              >
                {t('nav.login')}
              </button>
            )}
            {logoutError && (
              <p className={styles.logoutError} role="alert">
                {logoutError}
              </p>
            )}
          </div>
        </div>
      </nav>

      {/* 移动端抽屉（自左滑入）：关闭时 inert（不可聚焦、移出无障碍树）。 */}
      <div
        ref={drawerRef}
        id="nav-drawer"
        className={cx(styles.drawer, drawerOpen && styles.drawerOpen)}
        inert={drawerOpen ? undefined : true}
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.menuLabel')}
      >
        <div className={styles.drawerHeader}>
          <div className={styles.drawerBrand} aria-hidden="true">
            {brandLockup}
          </div>
          <button type="button" className={styles.drawerClose} aria-label={t('nav.closeMenu')} onClick={closeDrawer}>
            <CloseIcon />
          </button>
        </div>
        <div className={styles.drawerInner}>
          {PRIMARY_LINKS.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className={styles.drawerLink}
              aria-current={activeTo === l.to ? 'page' : undefined}
              onClick={closeDrawer}
            >
              {t(l.labelKey)}
            </Link>
          ))}

          <p className={styles.drawerGroup}>{t('nav.more')}</p>
          {MORE_LINKS.map((l) =>
            l.href ? (
              <a
                key={l.labelKey}
                href={l.href}
                className={styles.drawerLink}
                target="_blank"
                rel={relFor(l)}
                onClick={closeDrawer}
              >
                <span className={styles.menuLabel}>
                  {t(l.labelKey)}
                  {l.external && <span className={styles.tag}>{t('nav.externalTag')}</span>}
                </span>
                <ExternalIcon />
              </a>
            ) : (
              <span key={l.labelKey} aria-disabled="true" className={cx(styles.drawerLink, styles.drawerLinkMuted)}>
                <span className={styles.menuLabel}>{t(l.labelKey)}</span>
                <span className={styles.pending}>{t('nav.inDevelopment')}</span>
              </span>
            ),
          )}

          <hr className={styles.drawerDivider} />

          {user ? (
            <>
              <Link to="/me/contributions" className={styles.drawerLink} onClick={closeDrawer}>
                {t('nav.myContributions')}
              </Link>
              <Link to="/settings/security" className={styles.drawerLink} onClick={closeDrawer}>
                {t('nav.securitySettings')}
              </Link>
              {isAdmin && (
                <Link to={adminEntry} className={styles.drawerLink} onClick={closeDrawer}>
                  {t('nav.adminDashboard')}
                </Link>
              )}
              <button
                type="button"
                className={styles.drawerLink}
                disabled={logoutPending}
                aria-busy={logoutPending}
                onClick={() => void doLogout(true)}
              >
                {logoutLabel}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles.drawerLink}
              disabled={loginStarting}
              aria-busy={loginStarting}
              onClick={() => startPassLogin(true)}
            >
              {loginStarting ? t('nav.loggingIn') : t('nav.login')}
            </button>
          )}
        </div>
      </div>

      {/* 遮罩：真 button 语义（点击关闭），键盘出口另有 Esc，故移出 Tab 序。 */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className={cx(styles.overlay, drawerOpen && styles.overlayOn)}
        onClick={closeDrawer}
      />
    </>
  )
}
