import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { cx, Spinner } from '@/components/admin'
import styles from './AdminShell.module.css'

const MOBILE_BREAKPOINT = 1024
const COLLAPSE_KEY = 'tc-admin-sidebar-collapsed'

/* ── Icons (stroke style consistent with ThemeToggle/Navbar) ── */

const icon = (paths: ReactNode) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {paths}
  </svg>
)

const QueueIcon = () =>
  icon(
    <>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </>,
  )
const EditIcon = () =>
  icon(
    <>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
    </>,
  )
const UsersIcon = () =>
  icon(
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>,
  )
const AuditIcon = () =>
  icon(
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </>,
  )

const MenuIcon = () =>
  icon(
    <>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </>,
  )
const ChevronIcon = () => icon(<path d="m15 18-6-6 6-6" />)

interface NavEntry {
  to: string
  end?: boolean
  labelKey: string
  icon: ReactNode
  show: boolean
}

const ROLE_LABEL_KEYS: Record<string, string> = {
  admin: 'adminShell.roleAdmin',
  editor: 'adminShell.roleEditor',
  reviewer: 'adminShell.roleReviewer',
}

const TITLE_KEYS: Record<string, string> = {
  '/admin': 'admin.title',
  '/admin/edit-requests': 'adminEditRequests.title',
  '/admin/users': 'adminUsers.title',
  '/admin/audit-logs': 'adminAuditLogs.title',
}

export const AdminShell = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading, permissions } = useAuth()
  const location = useLocation()

  const [collapsed, setCollapsed] = useState<boolean>(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSE_KEY) === '1',
  )
  const [drawerOpen, setDrawerOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const [isMobile, setIsMobile] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT,
  )

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  // 跟踪移动断点（用于抽屉的模态行为）。
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrawerOpen(false)
  }, [location.pathname])

  // Drawer: Escape to close (return focus to toggle) + auto-close on widen.
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawerOpen(false)
        toggleRef.current?.focus()
      }
    }
    const onResize = () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [drawerOpen])

  // 移动端抽屉打开：聚焦首个【可见】可聚焦项（折叠按钮在 ≤1024px 为 display:none，需跳过，
  // 否则焦点会停留在抽屉外）。与站点 Navbar 抽屉一致的可达性处理。
  useEffect(() => {
    if (!drawerOpen || !isMobile) return
    const nodes = sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
    const firstVisible = nodes && Array.from(nodes).find((n) => n.offsetParent !== null)
    firstVisible?.focus()
  }, [drawerOpen, isMobile])

  // While authenticating, show a bare loading screen (no chrome).
  if (authLoading) {
    return (
      <div className={styles.bootstrap}>
        <Spinner size="lg" label={t('admin.verifying')} />
      </div>
    )
  }

  // Unauthenticated: defer to the nested guards (they redirect to /login).
  if (!user) {
    return <Outlet />
  }

  const navItems: NavEntry[] = [
    {
      to: '/admin',
      end: true,
      labelKey: 'adminShell.navReview',
      icon: <QueueIcon />,
      show: hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ),
    },
    {
      to: '/admin/edit-requests',
      labelKey: 'adminShell.navEditRequests',
      icon: <EditIcon />,
      show: hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ),
    },
    {
      to: '/admin/users',
      labelKey: 'adminShell.navUsers',
      icon: <UsersIcon />,
      show: hasPermission(permissions, PERMISSIONS.USER_READ),
    },
    {
      to: '/admin/audit-logs',
      labelKey: 'adminShell.navAudit',
      icon: <AuditIcon />,
      show: hasPermission(permissions, PERMISSIONS.AUDIT_READ),
    },
  ].filter((i) => i.show)

  const pageTitle = t(TITLE_KEYS[location.pathname] ?? 'adminShell.brand')

  const displayName = user.displayName || user.username
  const primaryRole = user.roles?.[0]
  const roleLabel = primaryRole ? t(ROLE_LABEL_KEYS[primaryRole] ?? primaryRole) : ''
  const initials = displayName.trim().slice(0, 1).toUpperCase()

  // 抽屉在移动端表现为模态：背景内容设为 inert，焦点已在打开时移入侧栏。
  const drawerModal = drawerOpen && isMobile

  return (
    <div className={cx(styles.shell, collapsed && styles.shellCollapsed, drawerOpen && styles.drawerOpen)}>
      <a href="#admin-main" className={styles.skipLink}>
        {t('adminShell.skipToContent')}
      </a>

      <aside ref={sidebarRef} id="admin-sidebar" className={styles.sidebar} aria-label={t('adminShell.navAriaLabel')}>
        <div className={styles.sidebarHead}>
          <span className={styles.brand}>{t('adminShell.brand')}</span>
          <button
            type="button"
            className={styles.collapseBtn}
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? t('adminShell.expand') : t('adminShell.collapse')}
            aria-pressed={collapsed}
          >
            <span className={cx(styles.collapseIcon, collapsed && styles.collapseIconFlipped)}>
              <ChevronIcon />
            </span>
          </button>
        </div>

        <nav className={styles.nav} aria-label={t('adminShell.navAriaLabel')}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => cx(styles.navItem, isActive && styles.navItemActive)}
              title={collapsed ? t(item.labelKey) : undefined}
            >
              <span className={styles.navIcon} aria-hidden="true">
                {item.icon}
              </span>
              <span className={styles.navLabel}>{t(item.labelKey)}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <button
        type="button"
        className={styles.overlay}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
        tabIndex={-1}
      />

      <div className={styles.contentCol}>
        <header className={styles.topbar}>
          <button
            ref={toggleRef}
            type="button"
            className={styles.hamburger}
            onClick={() => setDrawerOpen((o) => !o)}
            aria-label={drawerOpen ? t('adminShell.closeNav') : t('adminShell.openNav')}
            aria-expanded={drawerOpen}
            aria-controls="admin-sidebar"
          >
            <MenuIcon />
          </button>

          <h1 className={styles.pageTitle}>{pageTitle}</h1>

          <div className={styles.identity}>
            <span className={styles.avatar} aria-hidden="true">
              {user.avatarUrl ? <img src={user.avatarUrl} alt="" className={styles.avatarImg} /> : initials}
            </span>
            <span className={styles.identityText}>
              <span className={styles.identityName}>{displayName}</span>
              {roleLabel && <span className={styles.identityRole}>{roleLabel}</span>}
            </span>
          </div>
        </header>

        <main id="admin-main" className={styles.content} inert={drawerModal || undefined}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
