import type { ReactNode } from 'react'
import { cx } from '../admin/cx'
import styles from './PageHeader.module.css'

export interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  /** right-aligned action slot (buttons). */
  actions?: ReactNode
  /** small eyebrow label above the title. */
  eyebrow?: ReactNode
  /**
   * page = 账户侧页面标题（--fs-h1）；card = 居中卡/认证舞台里的标题（收一档）；
   * section = 分区标题（--fs-lg）。
   */
  size?: 'page' | 'card' | 'section'
  /** heading level; defaults to h1 for page/card, h2 for section. */
  as?: 'h1' | 'h2'
  align?: 'start' | 'center'
  className?: string
}

/** 统一的标题尺度（与 Pass 门户 PageHeader 同值），供账户侧页面、状态屏共用。 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  size = 'page',
  as,
  align = 'start',
  className,
}: PageHeaderProps) {
  const Heading = as ?? (size === 'section' ? 'h2' : 'h1')
  return (
    <header className={cx(styles.header, styles[size], align === 'center' && styles.center, className)}>
      <div className={styles.texts}>
        {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
        <Heading className={styles.title}>{title}</Heading>
        {description && <p className={styles.desc}>{description}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  )
}
