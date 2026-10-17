import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Feedback.module.css'

/* ── Spinner ─────────────────────────────────────────────── */

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  /** 内联用于按钮等场景：仅渲染转圈，不创建独立的 live region。 */
  inline?: boolean
  label?: string
}

export function Spinner({ size = 'md', inline, label }: SpinnerProps) {
  const ring = <span className={cx(styles.ring, styles[`ring_${size}`])} aria-hidden="true" />
  if (inline) return ring
  return (
    <span className={styles.spinner} role="status" aria-live="polite">
      {ring}
      {label && <span className={styles.spinnerLabel}>{label}</span>}
    </span>
  )
}

/* ── Alert ───────────────────────────────────────────────── */

export interface AlertProps {
  tone?: 'error' | 'success' | 'info'
  children: ReactNode
  className?: string
}

export function Alert({ tone = 'error', children, className }: AlertProps) {
  return (
    <div className={cx(styles.alert, styles[`alert_${tone}`], className)} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

/* ── EmptyState ──────────────────────────────────────────── */

export interface EmptyStateProps {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  /** 标题层级：默认 h2；嵌在已有 h2 分区里时传 h3，保持标题大纲连续。 */
  headingLevel?: 'h2' | 'h3'
}

export function EmptyState({ title, description, icon, action, headingLevel = 'h2' }: EmptyStateProps) {
  const Heading = headingLevel
  return (
    <div className={styles.empty}>
      {icon && (
        <span className={styles.emptyIcon} aria-hidden="true">
          {icon}
        </span>
      )}
      <Heading className={styles.emptyTitle}>{title}</Heading>
      {description && <p className={styles.emptyDesc}>{description}</p>}
      {action && <div className={styles.emptyAction}>{action}</div>}
    </div>
  )
}
