import { useState, useRef, useEffect, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ThemeToggle } from './ThemeToggle'
import { LanguageToggle } from '@/components/ui'
import { useAuth } from '@/context/useAuth'
import { LOGOUT_REDIRECT } from '@/config'
import styles from './Navbar.module.css'

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

interface MobileLink {
  key: string
  node: ReactNode
}

interface NavbarProps {
  customMobileLinks?: (closeMenu: () => void) => MobileLink[]
  customMobileLinkLabel?: string
}

const MOBILE_BREAKPOINT = 1200

export const Navbar = ({ customMobileLinks, customMobileLinkLabel }: NavbarProps) => {
  const { t } = useTranslation()
  const { user, isAdmin, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const hamburgerRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLButtonElement>(null)

  const closeMenu = () => setIsOpen(false)

  const openMenu = () => {
    setIsOpen(true)
    requestAnimationFrame(() => {
      drawerRef.current
        ?.querySelector<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
        ?.focus()
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
      if (e.key === 'Escape') {
        closeMenu()
        hamburgerRef.current?.focus()
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

  const mobileLinks = customMobileLinks?.(closeMenu)

  const handleDropdownToggle = () => {
    setDropdownOpen((prev) => !prev)
  }

  const handleDropdownKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      setDropdownOpen(true)
      requestAnimationFrame(() => {
        dropdownRef.current?.closest(`.${styles.dropdown}`)?.querySelector<HTMLElement>('a[role="menuitem"]')?.focus()
      })
    } else if (e.key === 'Escape') {
      setDropdownOpen(false)
      dropdownRef.current?.focus()
    }
  }

  const handleDropdownMenuKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'Escape') {
      setDropdownOpen(false)
      dropdownRef.current?.focus()
    }
  }

  const handleDropdownBlur = (e: React.FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropdownOpen(false)
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
              className={styles.hamburger}
              onClick={() => (isOpen ? closeMenu() : openMenu())}
              aria-label={isOpen ? t('nav.closeMenu') : t('nav.openMenu')}
              aria-expanded={isOpen}
              aria-controls="nav-drawer"
            >
              <span className={styles.bar}></span>
              <span className={styles.bar}></span>
              <span className={styles.bar}></span>
            </button>

            <div className={styles.logo}>
              <a href="https://transcircle.org">{t('nav.logo')}</a>
            </div>
          </div>

          {/* Desktop navigation — hidden on mobile via CSS */}
          <ul className={styles.navLinks}>
            <li>
              <a href="https://transcircle.org/">
                {t('nav.home')}
              </a>
            </li>
            <li>
              <Link to={location.pathname === '/submit' ? '/' : '/submit'}>
                {location.pathname === '/submit' ? t('nav.submitView') : t('nav.submit')}
              </Link>
            </li>
            <li className={`${styles.dropdown} ${dropdownOpen ? styles.dropdownOpen : ''}`} onBlur={handleDropdownBlur}>
              <button
                ref={dropdownRef}
                type="button"
                className={styles.dropdownTrigger}
                aria-haspopup="menu"
                aria-expanded={dropdownOpen}
                onClick={handleDropdownToggle}
                onKeyDown={handleDropdownKeyDown}
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
                onKeyDown={handleDropdownMenuKeyDown}
              >
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
            <div className={styles.toggles}>
              <LanguageToggle variant="plain" />
              <ThemeToggle />
            </div>
            {!user && (
              <Link to="/login" className={styles.loginBtn}>
                {t('nav.login')}
              </Link>
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
          <a href="https://transcircle.org/" className={styles.drawerLink} onClick={closeMenu}>
            {t('nav.home')}
          </a>
          <Link to={location.pathname === '/submit' ? '/' : '/submit'} className={styles.drawerLink} onClick={closeMenu}>
            {location.pathname === '/submit' ? t('nav.submitView') : t('nav.submit')}
          </Link>
          <span className={`${styles.drawerLink} ${styles.disabled}`}>
            {t('nav.archive')}
          </span>
          <span className={`${styles.drawerLink} ${styles.disabled}`}>
            {t('nav.community')}
          </span>

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
            <Link to="/login" className={styles.drawerLink} onClick={closeMenu}>
              {t('nav.login')}
            </Link>
          )}

          {mobileLinks && (
            <>
              <div className={styles.drawerDivider}></div>
              {customMobileLinkLabel && (
                <span className={styles.mobileLinkLabel}>{customMobileLinkLabel}</span>
              )}
              <div className={styles.mobileTOCGroup}>
                {mobileLinks.map(({ key, node }) => (
                  <div key={key} className={styles.mobileTOCItem}>
                    {node}
                  </div>
                ))}
              </div>
            </>
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
