/**
 * 加载骨架屏 —— 列表 / 卡片首屏加载占位。
 *
 * 替代「整页替换为居中 Spinner」的加载观感：骨架按真实列表行高/卡片高度占位，
 * 避免首帧空态闪屏（FOUC）与数据到达时的布局大跳变。
 *
 * 变体与真实版面一一对应，重绘后必须同步——骨架和落位内容形状不一致，
 * 数据到达时反而会造成更明显的跳变：
 *   list    后台数据行（Page.module.css .rowBtn）
 *   card    通用详情卡片
 *   feed    公共故事流卡片（Story.module.css .entryLink）
 *   article 公共阅读页（标题 + 作者区 + 正文）
 *
 * 无障碍：容器带 role="status" + aria-busy，辅助技术可感知加载中；
 * 动画尊重 prefers-reduced-motion（由样式模块内 media 关闭）。
 */
import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Skeleton.module.css'

export type SkeletonVariant = 'list' | 'card' | 'feed' | 'article'

export interface SkeletonProps {
  /** 行数（list / feed 变体） */
  rows?: number
  variant?: SkeletonVariant
  /** 附加 className（如控制 max-width） */
  className?: string
  /** 自定义占位内容（如精确的行结构）；提供时忽略 rows/variant */
  children?: ReactNode
}

/* CSS Modules 的类型声明把每个类名标成 string | undefined，这里如实标注 */
const VARIANT_CLASS: Record<SkeletonVariant, string | undefined> = {
  list: styles.list,
  card: styles.card,
  feed: styles.feed,
  article: styles.article,
}

/** 故事流卡片占位：头像 + 署名行 / 标题 / 摘要，与 .entryLink 同构。 */
const FeedCard = () => (
  <div className={styles.feedCard}>
    <div className={styles.metaRow}>
      <span className={styles.avatar} />
      <span className={styles.lineShort} />
    </div>
    <span className={styles.lineTitle} />
    <span className={styles.lineWide} />
  </div>
)

/** 阅读页占位：大标题 / 作者区 / 正文段落，与 .article 同构。 */
const ArticleBody = () => (
  <div className={styles.articleBody}>
    <span className={styles.lineDisplay} />
    <span className={styles.lineMid} />
    <div className={styles.authorRow}>
      <span className={styles.avatarLg} />
      <span className={styles.lineShort} />
    </div>
    <span className={styles.lineWide} />
    <span className={styles.lineWide} />
    <span className={styles.lineMid} />
  </div>
)

export const Skeleton = ({ rows = 5, variant = 'list', className, children }: SkeletonProps) => {
  let body: ReactNode = children

  if (body == null) {
    if (variant === 'card') {
      body = (
        <div className={styles.cardBody}>
          <span className={styles.lineWide} />
          <span className={styles.lineMid} />
          <span className={styles.lineWide} />
          <span className={styles.lineNarrow} />
        </div>
      )
    } else if (variant === 'article') {
      body = <ArticleBody />
    } else if (variant === 'feed') {
      body = Array.from({ length: rows }, (_, i) => <FeedCard key={i} />)
    } else {
      body = Array.from({ length: rows }, (_, i) => <div key={i} className={styles.row} />)
    }
  }

  return (
    <div role="status" aria-busy="true" className={cx(styles.root, VARIANT_CLASS[variant], className)}>
      {body}
    </div>
  )
}
