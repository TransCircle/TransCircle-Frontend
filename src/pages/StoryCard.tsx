import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useFormatTs } from '@/utils/datetime'
import styles from './Story.module.css'

/** 公开故事的列表项：首页信息流、置顶稿与搜索结果共用。 */
export interface PublicContribution {
  id: string
  title: string
  summary: string | null
  tags: string[]
  language: string
  author: {
    displayName: string
    avatarUrl: string | null
  }
  publishedAt: number
  pinnedAt?: number | null
}

/** 图钉（Lucide pin）：「置顶」chip 的前缀，纯装饰。 */
const PinIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </svg>
)

/** 头像回退：取显示名首字，无名时用间隔号占位（不留空圆）。 */
const initialOf = (name: string) => (name ?? '').trim().charAt(0) || '·'

interface StoryCardProps {
  item: PublicContribution
  /** reveal 的交错序号（--i），只影响入场动画先后，不参与任何数据逻辑。 */
  index: number
  /** 置顶稿：标签行最前多一枚「置顶」chip。 */
  pinned?: boolean
}

/**
 * 故事卡（§5.5），标题优先：标题 → 摘要 → 贴底元信息（标签在上、署名在最下）。
 * 卡片链接不设 aria-label：可访问名由标题、摘要、标签与署名自然组成，读屏能读到「置顶」。
 * 渲染为 <li>，放在 Story.module.css 的 .feed 网格里使用。
 */
export const StoryCard = ({ item, index, pinned = false }: StoryCardProps) => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  return (
    <li className={`${styles.entry} reveal`} data-reveal="" style={{ '--i': index } as CSSProperties}>
      <Link to={`/contributions/${item.id}`} className={styles.card}>
        <h3 className={styles.cardTitle}>{item.title}</h3>
        {item.summary && <p className={styles.cardSummary}>{item.summary}</p>}

        {/* 标签在上、署名贴底：同一行卡片无论有无标签，署名行都对齐在底边。 */}
        <div className={styles.cardMeta}>
          {(pinned || item.tags?.length > 0) && (
            <span className={styles.tags}>
              {pinned && (
                <span className={styles.pinBadge}>
                  <PinIcon />
                  {t('home.pinnedBadge')}
                </span>
              )}
              {item.tags?.map((tag) => (
                <span key={tag} className={styles.tag}>
                  {tag}
                </span>
              ))}
            </span>
          )}
          <span className={styles.byline}>
            {item.author.avatarUrl ? (
              <img className={styles.avatar} src={item.author.avatarUrl} alt="" loading="lazy" />
            ) : (
              <span className={styles.avatarFallback} aria-hidden="true">
                {initialOf(item.author.displayName)}
              </span>
            )}
            <span className={styles.author}>{item.author.displayName}</span>
            <span className={styles.sep} aria-hidden="true">
              ·
            </span>
            <span className={styles.metaText}>{formatTs(item.publishedAt)}</span>
            {/* 极窄屏下整体隐藏（含前导分隔点），见 Story.module.css 480px 断点 */}
            <span className={styles.bylineLang}>
              <span className={styles.sep} aria-hidden="true">
                ·
              </span>
              {t('submit.languages.' + item.language, { defaultValue: item.language })}
            </span>
          </span>
        </div>
      </Link>
    </li>
  )
}
