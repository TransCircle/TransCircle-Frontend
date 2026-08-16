/**
 * 加载骨架屏 —— 列表 / 卡片首屏加载占位。
 *
 * 替代「整页替换为居中 Spinner」的加载观感：骨架按真实列表行高/卡片高度占位，
 * 避免首帧空态闪屏（FOUC）与数据到达时的布局大跳变。
 *
 * 无障碍：容器带 role="status" + aria-busy，辅助技术可感知加载中；
 * 动画尊重 prefers-reduced-motion（由样式模块内 media 关闭）。
 */
import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Skeleton.module.css'

export interface SkeletonProps {
  /** 行数（列表骨架） */
  rows?: number
  /** 变体：list（默认，列表行）/ card（详情卡片） */
  variant?: 'list' | 'card'
  /** 附加 className（如控制 max-width） */
  className?: string
  /** 自定义占位内容（如精确的行结构）；提供时忽略 rows/variant */
  children?: ReactNode
}

export const Skeleton = ({ rows = 5, variant = 'list', className, children }: SkeletonProps) => (
  <div
    role="status"
    aria-busy="true"
    className={cx(styles.root, variant === 'card' ? styles.card : styles.list, className)}
  >
    {children ??
      (variant === 'card' ? (
        <div className={styles.cardBody}>
          <div className={styles.lineWide} />
          <div className={styles.lineMid} />
          <div className={styles.lineWide} />
          <div className={styles.lineNarrow} />
        </div>
      ) : (
        Array.from({ length: rows }, (_, i) => <div key={i} className={styles.row} />)
      ))}
  </div>
)
