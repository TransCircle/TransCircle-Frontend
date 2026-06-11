import { useState, useRef, useEffect, type ReactNode } from "react";
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ThemeToggle } from "./ThemeToggle";
import { useAuth } from '@/context/useAuth'
import styles from "./Navbar.module.css";

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
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user, isAdmin, logout } = useAuth()
  const [isOpen, setIsOpen] = useState(false);

  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

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
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        closeMenu();
        hamburgerRef.current?.focus();
      }
    };

    const handleResize = () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) {
        closeMenu();
        const main = document.querySelector<HTMLElement>("main");
        if (main) main.inert = false;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [isOpen]);

  const mobileLinks = customMobileLinks?.(closeMenu);

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

            <div className={styles.logo}>{t('nav.logo')}</div>
          </div>

          <ul
            ref={menuRef}
            id="nav-menu"
            className={`${styles.navLinks} ${isOpen ? styles.active : ""}`}
          >
            <li><a href="https://transcircle.org" onClick={closeMenu}>{t('nav.home')}</a></li>
            <li><Link to="/submit" onClick={closeMenu}>{t('nav.submit')}</Link></li>
            <li><a href="#archive" onClick={closeMenu}>{t('nav.archive')}</a></li>
            <li><a href="#community" onClick={closeMenu}>{t('nav.community')}</a></li>

            {user && (
              <>
                <li className={styles.mobileDivider}></li>
                <li><Link to="/me/contributions" onClick={closeMenu}>我的投稿</Link></li>
                <li><Link to="/settings/security" onClick={closeMenu}>安全设置</Link></li>
                {isAdmin && <li><Link to="/admin" onClick={closeMenu}>管理后台</Link></li>}
                <li><button onClick={() => { logout(); closeMenu(); navigate('/') }} style={{
                  background: 'none', border: 'none', color: 'inherit', cursor: 'pointer',
                  fontSize: 'inherit', fontFamily: 'inherit', padding: 0
                }}>退出登录</button></li>
              </>
            )}
            {!user && (
              <li><Link to="/login" onClick={closeMenu}>登录</Link></li>
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
            </li>
          </ul>

          <div className={styles.rightSection}>
            <ThemeToggle />
            <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', marginLeft: '0.5rem' }}>
              {user ? (
                <button onClick={() => { logout(); navigate('/') }} style={{
                  fontSize: '0.8rem', background: 'none', border: '1px solid var(--text-muted)',
                  borderRadius: '50px', padding: '0.2rem 0.75rem', cursor: 'pointer', fontFamily: 'inherit',
                  color: 'var(--text-main)'
                }}>退出</button>
              ) : (
                <Link to="/login" style={{ fontSize: '0.85rem', color: 'var(--accent-pink)' }}>登录</Link>
              )}
            </div>
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
