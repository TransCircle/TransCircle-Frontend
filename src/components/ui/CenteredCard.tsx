import type { ReactNode } from 'react'
import { cx } from '../admin/cx'
import { Card } from '../admin'
import styles from './CenteredCard.module.css'

export interface CenteredCardProps {
  children: ReactNode
  /** max inline width of the card; defaults to var(--w-form) (~26rem). */
  maxWidth?: string
  padding?: 'sm' | 'md'
  /** outer landmark; use 'main' only when rendered outside RootLayout (e.g. error boundary). */
  as?: 'div' | 'main'
  /** className applied to the inner Card. */
  className?: string
}

/**
 * 居中玻璃卡（状态页 / 404 / 错误边界 / 懒加载占位），与 Pass 门户同一版式。
 *
 * 默认渲染 div（RootLayout 持有唯一 <main>）；在 RootLayout 之外渲染时传 as="main"。
 * data-viewport-fit：这类页只有一屏，宽屏下由外壳锁成整屏、页脚常驻屏底
 * （见 App.module.css）；窄屏不锁，回到文档流。
 */
export function CenteredCard({ children, maxWidth, padding = 'md', as = 'div', className }: CenteredCardProps) {
  const Shell = as
  return (
    <Shell className={styles.shell} data-viewport-fit="">
      <div className={styles.holder} style={maxWidth ? { maxWidth } : undefined}>
        <Card padding={padding} className={cx(styles.card, className)}>
          <div className={styles.body}>{children}</div>
        </Card>
      </div>
    </Shell>
  )
}
