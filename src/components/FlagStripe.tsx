import type { CSSProperties } from 'react'

import { cx } from './admin/cx'
import styles from './FlagStripe.module.css'

export interface FlagStripeProps {
  /** mini = 导航当前项指示条（24×3px，§5.3）；full = 通栏整条（§3.1）。 */
  variant?: 'full' | 'mini'
  /**
   * 条纹归属，用于 §1.5「同一视口只出现一处」的让位判定：
   * `page` = 页面自带的签名条纹（认证舞台顶部）；`footer` = 全站页脚条纹。
   * 页面自带时页脚条纹自动隐藏，见 App.module.css。
   */
  scope?: 'page' | 'footer'
  className?: string
  /** 供调用方传入定位用的 CSS 变量（如导航条纹的滑动位置）。 */
  style?: CSSProperties
}

/**
 * 旗帜条纹（DESIGN.md §3.1）：粉/白/蓝三段等宽实色 span，禁止渐变。
 * 纯装饰，整体 aria-hidden——「当前项」「页脚分界」等语义由调用方的
 * aria-current / landmark 表达，不依赖颜色（§7）。与 Pass 门户同一实现。
 */
export function FlagStripe({ variant = 'full', scope, className, style }: FlagStripeProps) {
  return (
    <span
      className={cx(styles.stripe, variant === 'mini' && styles.mini, className)}
      style={style}
      data-flag-stripe={scope}
      aria-hidden="true"
    >
      <span className={cx(styles.seg, styles.pink)} />
      <span className={cx(styles.seg, styles.white)} />
      <span className={cx(styles.seg, styles.blue)} />
    </span>
  )
}
