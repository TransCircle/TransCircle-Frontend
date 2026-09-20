import { useCallback, useRef } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useTheme, type Theme } from '../context/useTheme'
import styles from './ThemeToggle.module.css'

/** 主题切换的圆形遮罩过渡（DESIGN §5.11）。
 *  用 View Transition API 从按钮圆心扩散一个 clip-path 圆；
 *  不支持该 API、或用户偏好减少动画时，直接切换（无动画）。 */
type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { ready: Promise<void>; finished: Promise<void> }
}

/** 过渡期间挂在 <html> 上，让 index.css 的 ::view-transition 覆盖只作用于本次切换，
 *  不影响 @view-transition 的页面导航淡入。 */
const SWITCHING_CLASS = 'theme-switching'

const SunIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
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
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
)

const MoonIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
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
    <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
  </svg>
)

interface ThemeToggleProps {
  className?: string
}

export const ThemeToggle = ({ className = '' }: ThemeToggleProps) => {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const btnRef = useRef<HTMLButtonElement>(null)

  const handleToggle = useCallback(() => {
    const nextTheme: Theme = theme === 'light' ? 'dark' : 'light'
    const btn = btnRef.current
    const doc = document as ViewTransitionDocument
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (!btn || prefersReduced || typeof doc.startViewTransition !== 'function') {
      setTheme(nextTheme)
      return
    }

    const rect = btn.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    // 圆要盖满视口：半径取圆心到最远视口角的距离。
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))

    doc.documentElement.classList.add(SWITCHING_CLASS)
    // flushSync：快照必须在 data-theme 与图标都更新后才拍，否则会先闪一帧旧图标。
    const transition = doc.startViewTransition(() => {
      flushSync(() => setTheme(nextTheme))
    })

    void transition.ready.then(() => {
      doc.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
        {
          duration: 400,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      )
    })

    void transition.finished.finally(() => {
      doc.documentElement.classList.remove(SWITCHING_CLASS)
    })
  }, [theme, setTheme])

  const isDark = theme === 'dark'

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`${styles.toggleBtn} ${className}`.trim()}
        onClick={handleToggle}
        aria-label={isDark ? t('theme.switchToLight') : t('theme.switchToDark')}
      >
        {isDark ? <SunIcon /> : <MoonIcon />}
      </button>
    </>
  )
}
