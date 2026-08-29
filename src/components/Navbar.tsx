import { useState, useRef, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ThemeToggle } from './ThemeToggle'
import { useAuth } from '@/context/useAuth'
import { LOGOUT_REDIRECT } from '@/config'
import styles from './Navbar.module.css'
import { hasModalLayer } from '@/components/admin/modalStack'

const ExternalLinkIcon = () => (
  <svg
    className={styles.externalIcon}
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 2h8v8" />
    <path d="M14 2 4 12" />
  </svg>
)

const MOBILE_BREAKPOINT = 1100

/** 抽屉内的可聚焦元素选择器（打开时的初始聚焦与 Tab 循环共用）。 */
const DRAWER_FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

export const Navbar = () => {
  const { t } = useTranslation()
  const { user, isAdmin, logout, loginWithPass } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const [linksDropdownOpen, setLinksDropdownOpen] = useState(false)
  const [acctDropdownOpen, setAcctDropdownOpen] = useState(false)

  const hamburgerRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const linksDropdownRef = useRef<HTMLButtonElement>(null)
  const acctDropdownRef = useRef<HTMLButtonElement>(null)
  const loginStartingRef = useRef(false)

  const closeMenu = () => setIsOpen(false)

  const startPassLogin = () => {
    if (loginStartingRef.current) return
    loginStartingRef.current = true
    closeMenu()
    void loginWithPass()
  }

  const openMenu = () => {
    setIsOpen(true)
    requestAnimationFrame(() => {
      drawerRef.current?.querySelector<HTMLElement>(DRAWER_FOCUSABLE)?.focus()
    })
  }

  // Manage <main> inert: when the mobile drawer is open, the main content
  // should be inert so keyboard/tab navigation stays inside the drawer.
  // 注意：不使用 ref 缓存 DOM 引用来避免 React 19 StrictMode 双重渲染导致的过期引用；
  //       清理函数和安全阀 effect 均直接重新查询 DOM，确保 inert 一定能被正确重置。
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('main')
    if (el && window.innerWidth <= MOBILE_BREAKPOINT) {
      el.inert = isOpen
    }
    return () => {
      const el = document.querySelector<HTMLElement>('main')
      if (el) el.inert = false
    }
  }, [isOpen])

  // Close mobile drawer on route change — prevents <main> from staying inert
  // after programmatic navigation (redirects from guards, navigate() calls, etc.)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    closeMenu()
  }, [location.pathname])

  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (e: KeyboardEvent) => {
      /* 有浮层开着（确认弹窗、理由弹窗、step-up…）：键盘归它管，抽屉必须让开。
         不让的话 Tab 会在浮层处理完后继续冒泡到这里，把焦点拽回抽屉，
         顶层 aria-modal 对话框的焦点陷阱就形同虚设了。 */
      if (hasModalLayer()) return
      if (e.key === 'Escape') {
        closeMenu()
        hamburgerRef.current?.focus()
        return
      }
      /* Tab 循环。把 <main> 设成 inert 只挡住了正文，抽屉外仍有可聚焦元素
         （汉堡按钮、页脚等），Tab 到最后一项后焦点会走出抽屉。抽屉是模态的，
         焦点必须留在里面，出口只有 Esc 和抽屉自己的链接。 */
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
      if (e.shiftKey) {
        if (active === first) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    const handleResize = () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) closeMenu()
    }
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('resize', handleResize)
    }
  }, [isOpen])

  const handleLinksToggle = () => {
    setLinksDropdownOpen((prev) => !prev)
  }

  const handleLinksKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      setLinksDropdownOpen(true)
      requestAnimationFrame(() => {
        linksDropdownRef.current?.closest(`.${styles.dropdown}`)?.querySelector<HTMLElement>('a[role="menuitem"]')?.focus()
      })
    } else if (e.key === 'Escape') {
      setLinksDropdownOpen(false)
      linksDropdownRef.current?.focus()
    }
  }

  // WAI-ARIA menu 键盘契约：在 role="menuitem" 之间用方向键/Home/End 滚动焦点。
  const moveMenuFocus = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    if (items.length === 0) return
    const current = items.findIndex((el) => el === document.activeElement)
    let next: number
    if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length
    else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const handleLinksMenuKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'Escape') {
      setLinksDropdownOpen(false)
      linksDropdownRef.current?.focus()
      return
    }
    moveMenuFocus(e)
  }

  const handleLinksBlur = (e: React.FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setLinksDropdownOpen(false)
    }
  }

  const handleAcctToggle = () => {
    setAcctDropdownOpen((prev) => !prev)
  }

  const handleAcctKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      setAcctDropdownOpen(true)
      requestAnimationFrame(() => {
        acctDropdownRef.current?.closest(`.${styles.acctDropdown}`)?.querySelector<HTMLElement>('a[role="menuitem"]')?.focus()
      })
    } else if (e.key === 'Escape') {
      setAcctDropdownOpen(false)
      acctDropdownRef.current?.focus()
    }
  }

  const handleAcctMenuKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'Escape') {
      setAcctDropdownOpen(false)
      acctDropdownRef.current?.focus()
      return
    }
    moveMenuFocus(e)
  }

  const handleAcctBlur = (e: React.FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setAcctDropdownOpen(false)
    }
  }

  return (
    <>
      <nav className={styles.navbar} aria-label={t('nav.ariaLabel')}>
        <div className={styles.container}>
          <div className={styles.leftSection}>
            <button
              ref={hamburgerRef}
              type="button"
              className={`${styles.hamburger} ${isOpen ? styles.hamburgerOpen : ''}`}
              onClick={() => (isOpen ? closeMenu() : openMenu())}
              aria-label={isOpen ? t('nav.closeMenu') : t('nav.openMenu')}
              aria-expanded={isOpen}
              aria-controls="nav-drawer"
            >
              <span className={`${styles.bar} ${styles.barTop}`}></span>
              <span className={`${styles.bar} ${styles.barMid}`}></span>
              <span className={`${styles.bar} ${styles.barBot}`}></span>
            </button>

            <div className={styles.logo}>
              <Link to="/" onClick={closeMenu}>
                <img className={styles.logoMark} src="/logo-mark.svg" width={28} height={28} alt="" aria-hidden="true" />
                {t('nav.logo')}
              </Link>
            </div>
          </div>

          {/* Desktop navigation — hidden on mobile via CSS */}
          <ul className={styles.navLinks}>
            <li>
              <Link to="/">
                {t('nav.home')}
              </Link>
            </li>
            <li>
              <a href="https://transcircle.org/#archive" target="_blank" rel="noopener noreferrer">
                {t('nav.archive')}
              </a>
            </li>
            <li>
              <a href="https://community.transcircle.org/" target="_blank" rel="noopener noreferrer">
                {t('nav.community')}
              </a>
            </li>
            <li className={`${styles.dropdown} ${linksDropdownOpen ? styles.dropdownOpen : ''}`} onBlur={handleLinksBlur}>
              <button
                ref={linksDropdownRef}
                type="button"
                className={styles.dropdownTrigger}
                aria-haspopup="menu"
                aria-expanded={linksDropdownOpen}
                onClick={handleLinksToggle}
                onKeyDown={handleLinksKeyDown}
              >
                {t('nav.links')}
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
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              <ul
                className={styles.dropdownMenu}
                aria-label={t('nav.externalLinks')}
                role="menu"
                onKeyDown={handleLinksMenuKeyDown}
              >
                <li role="none">
                  <a
                    role="menuitem"
                    href="https://transcircle.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('nav.mainSite')}
                    <ExternalLinkIcon />
                  </a>
                </li>
                <li role="none">
                  <a
                    role="menuitem"
                    href="https://blog.transcircle.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('nav.blog')}
                    <ExternalLinkIcon />
                  </a>
                </li>
                <li role="none">
                  <a
                    role="menuitem"
                    href="https://search.transcircle.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('nav.explore')}
                    <ExternalLinkIcon />
                  </a>
                </li>
              </ul>
            </li>
          </ul>

          <div className={styles.rightSection}>
            <ThemeToggle />

            {user ? (
              <div className={styles.acctDropdown} onBlur={handleAcctBlur}>
                <button
                  ref={acctDropdownRef}
                  type="button"
                  className={styles.acctBtn}
                  aria-haspopup="menu"
                  aria-expanded={acctDropdownOpen}
                  aria-label={user.displayName ?? user.username}
                  onClick={handleAcctToggle}
                  onKeyDown={handleAcctKeyDown}
                >
                  {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className={styles.acctAvatar} width={34} height={34} />
                  ) : (
                    <span className={styles.acctAvatarFallback}>
                      {(user.displayName ?? user.username).charAt(0).toUpperCase()}
                    </span>
                  )}
                </button>
                {acctDropdownOpen && (
                  <ul className={styles.acctMenu} role="menu" onKeyDown={handleAcctMenuKeyDown}>
                    <li role="none">
                      <Link role="menuitem" to="/me/contributions" onClick={closeMenu}>
                        {t('nav.myContributions')}
                      </Link>
                    </li>
                    <li role="none">
                      <Link role="menuitem" to="/settings/security" onClick={closeMenu}>
                        {t('nav.securitySettings')}
                      </Link>
                    </li>
                    {isAdmin && (
                      <li role="none">
                        <Link role="menuitem" to="/admin" onClick={closeMenu}>
                          {t('nav.adminDashboard')}
                        </Link>
                      </li>
                    )}
                    <li role="none">
                      <button
                        role="menuitem"
                        type="button"
                        className={styles.acctLogout}
                        onClick={async () => {
                          await logout()
                          if (LOGOUT_REDIRECT.startsWith('/')) {
                            navigate(LOGOUT_REDIRECT, { replace: true })
                          } else {
                            window.location.href = LOGOUT_REDIRECT
                          }
                        }}
                      >
                        {t('nav.logout')}
                      </button>
                    </li>
                  </ul>
                )}
              </div>
            ) : (
              <button type="button" className={styles.loginBtn} onClick={startPassLogin}>
                {t('nav.login')}
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* Mobile drawer — always rendered, hidden via transform */}
      <div
        ref={drawerRef}
        id="nav-drawer"
        className={`${styles.drawer} ${isOpen ? styles.drawerOpen : ''}`}
        inert={!isOpen ? true : undefined}
      >
        <div className={styles.drawerInner}>
          <Link to="/" className={styles.drawerLink} onClick={closeMenu}>
            {t('nav.home')}
          </Link>
          <a href="https://transcircle.org/#archive" className={styles.drawerLink} target="_blank" rel="noopener noreferrer" onClick={closeMenu}>
            {t('nav.archive')}
          </a>
          <a href="https://community.transcircle.org/" className={styles.drawerLink} target="_blank" rel="noopener noreferrer" onClick={closeMenu}>
            {t('nav.community')}
          </a>

          <a href="https://transcircle.org/" className={styles.drawerLink} target="_blank" rel="noopener noreferrer" onClick={closeMenu}>
            {t('nav.mainSite')}
            <ExternalLinkIcon />
          </a>
          <a href="https://blog.transcircle.org/" className={styles.drawerLink} target="_blank" rel="noopener noreferrer" onClick={closeMenu}>
            {t('nav.blog')}
            <ExternalLinkIcon />
          </a>
          <a href="https://search.transcircle.org/" className={styles.drawerLink} target="_blank" rel="noopener noreferrer" onClick={closeMenu}>
            {t('nav.explore')}
            <ExternalLinkIcon />
          </a>

          <div className={styles.drawerDivider}></div>

          {user && (
            <>
              <Link to="/me/contributions" className={styles.drawerLink} onClick={closeMenu}>
                {t('nav.myContributions')}
              </Link>
              <Link to="/settings/security" className={styles.drawerLink} onClick={closeMenu}>
                {t('nav.securitySettings')}
              </Link>
              {isAdmin && (
                <Link to="/admin" className={styles.drawerLink} onClick={closeMenu}>
                  {t('nav.adminDashboard')}
                </Link>
              )}
              <Link
                to="/"
                className={styles.drawerLink}
                onClick={async (e) => {
                  e.preventDefault()
                  await logout()
                  closeMenu()
                  if (LOGOUT_REDIRECT.startsWith('/')) {
                    navigate(LOGOUT_REDIRECT, { replace: true })
                  } else {
                    window.location.href = LOGOUT_REDIRECT
                  }
                }}
              >
                {t('nav.logout')}
              </Link>
            </>
          )}
          {!user && (
            <button type="button" className={styles.drawerLink} onClick={startPassLogin}>
              {t('nav.login')}
            </button>
          )}

        </div>
      </div>

      {/* Overlay backdrop */}
      <div
        className={`${styles.overlay} ${isOpen ? styles.overlayOn : ''}`}
        onClick={closeMenu}
        aria-hidden="true"
      ></div>
    </>
  )
}
