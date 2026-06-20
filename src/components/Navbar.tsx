import { useState, useRef, useEffect, type ReactNode } from "react";
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ThemeToggle } from "./ThemeToggle";
import { useAuth } from '@/context/useAuth'
import styles from "./Navbar.module.css";

const ExternalLinkIcon = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginLeft: 4, verticalAlign: -1 }}>
    <path d="M6 2h8v8" />
    <path d="M14 2 4 12" />
  </svg>
);

interface MobileLink {
  key: string;
  node: ReactNode;
}

interface NavbarProps {
  customMobileLinks?: (closeMenu: () => void) => MobileLink[];
  customMobileLinkLabel?: string;
}

const MOBILE_BREAKPOINT = 1200;

export const Navbar = ({ customMobileLinks, customMobileLinkLabel }: NavbarProps) => {
  const { t, i18n } = useTranslation()
  const { user, isAdmin, logout } = useAuth()
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const dropdownRef = useRef<HTMLButtonElement>(null);

  const closeMenu = () => setIsOpen(false);

  const openMenu = () => {
    setIsOpen(true);
    requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
        ?.focus();
    });
  };

  useEffect(() => {
    const main = document.querySelector<HTMLElement>("main");
    if (main && window.innerWidth <= MOBILE_BREAKPOINT) {
      main.inert = isOpen;
    }
    return () => {
      if (main) main.inert = false;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeMenu();
        hamburgerRef.current?.focus();
      }
    };
    const handleResize = () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) closeMenu();
    };
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [isOpen]);

  const mobileLinks = customMobileLinks?.(closeMenu);

  const handleDropdownToggle = () => {
    setDropdownOpen((prev) => !prev);
  };

  const handleDropdownKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      setDropdownOpen(true);
      requestAnimationFrame(() => {
        dropdownRef.current
          ?.closest(`.${styles.dropdown}`)
          ?.querySelector<HTMLElement>('.dropdown-menu-link')
          ?.focus();
      });
    } else if (e.key === "Escape") {
      setDropdownOpen(false);
      dropdownRef.current?.focus();
    }
  };

  const handleDropdownMenuKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === "Escape") {
      setDropdownOpen(false);
      dropdownRef.current?.focus();
    }
  };

  const handleDropdownBlur = (e: React.FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropdownOpen(false);
    }
  };

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
              aria-controls="nav-menu"
            >
              <span className={styles.bar}></span>
              <span className={styles.bar}></span>
              <span className={styles.bar}></span>
            </button>

            <div className={styles.logo}><a href="https://transcircle.org">{t('nav.logo')}</a></div>
          </div>

          <ul
            ref={menuRef}
            id="nav-menu"
            className={`${styles.navLinks} ${isOpen ? styles.active : ""}`}
          >
            <li><a href="https://transcircle.org" onClick={closeMenu}>{t('nav.home')}</a></li>
            <li
              className={`${styles.dropdown} ${dropdownOpen ? styles.dropdownOpen : ""}`}
              onBlur={handleDropdownBlur}
            >
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
                aria-label="外部链接"
                role="menu"
                onKeyDown={handleDropdownMenuKeyDown}
              >
                <li role="none"><a role="menuitem" className="dropdown-menu-link" href="https://blog.transcircle.org/" target="_blank" rel="noopener noreferrer" onClick={closeMenu}>博客<ExternalLinkIcon /></a></li>
                <li role="none"><a role="menuitem" className="dropdown-menu-link" href="https://search.transcircle.org/" target="_blank" rel="noopener noreferrer" onClick={closeMenu}>探索<ExternalLinkIcon /></a></li>
              </ul>
            </li>
            <li><Link to="/submit" onClick={closeMenu}>{t('nav.submit')}</Link></li>
            <li><span className={styles.disabled}>{t('nav.archive')}</span></li>
            <li><span className={styles.disabled}>{t('nav.community')}</span></li>

            {user && (
              <>
                <li className={styles.mobileDivider}></li>
                <li><Link to="/me/contributions" onClick={closeMenu}>{t('nav.myContributions')}</Link></li>
                <li><Link to="/settings/security" onClick={closeMenu}>{t('nav.securitySettings')}</Link></li>
                {isAdmin && <li><Link to="/admin" onClick={closeMenu}>{t('nav.adminDashboard')}</Link></li>}
                <li><button onClick={async () => { await logout(); closeMenu(); window.location.href = 'https://transcircle.org' }} style={{
                  background: 'none', border: 'none', color: 'inherit', cursor: 'pointer',
                  fontSize: 'inherit', fontFamily: 'inherit', padding: 0
                }}>{t('nav.logout')}</button></li>
              </>
            )}
            {!user && (
              <li><Link to="/login" onClick={closeMenu}>{t('nav.login')}</Link></li>
            )}

            {mobileLinks && (
              <>
                <li className={styles.mobileDivider}></li>
                {customMobileLinkLabel && (
                  <li className={styles.mobileOnly}>
                    <span className={styles.mobileLinkLabel}>{customMobileLinkLabel}</span>
                  </li>
                )}
                <li className={styles.mobileOnly}>
                  <div className={styles.mobileTOCGroup}>
                    {mobileLinks.map(({ key, node }) => (
                      <div key={key} className={styles.mobileTOCItem}>{node}</div>
                    ))}
                  </div>
                </li>
              </>
            )}

            <li className={styles.mobileDivider}></li>
            <li className={`${styles.mobileOnly} ${styles.mobileThemeToggle}`}>
              <div className={styles.mobileThemeLabel}>{t('nav.mobileThemeLabel')}</div>
              <ThemeToggle className={styles.mobileThemeToggleGroup} />
              <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', justifyContent: 'center', marginTop: '0.25rem' }}>
                <button
                  onClick={() => { localStorage.setItem('transcircle-lang', 'zh-CN'); i18n.changeLanguage('zh-CN') }}
                  style={{ fontSize: '0.8rem', fontWeight: i18n.language === 'zh-CN' ? 700 : 400, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}
                >简体</button>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>/</span>
                <button
                  onClick={() => { localStorage.setItem('transcircle-lang', 'zh-TW'); i18n.changeLanguage('zh-TW') }}
                  style={{ fontSize: '0.8rem', fontWeight: i18n.language === 'zh-TW' ? 700 : 400, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}
                >繁體</button>
              </div>
            </li>
          </ul>

          <div className={styles.rightSection}>
                        <ThemeToggle />
          </div>
        </div>
      </nav>

      <div
        className={`${styles.overlay} ${isOpen ? styles.overlayActive : ""}`}
        onClick={closeMenu}
        aria-hidden="true"
      ></div>
    </>
  );
};
