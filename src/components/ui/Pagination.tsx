import { useTranslation } from 'react-i18next'
import { cx } from '../admin/cx'
import styles from './Pagination.module.css'

const ChevronLeft = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m15 18-6-6 6-6" />
  </svg>
)

const ChevronRight = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
)

export interface PaginationProps {
  /** 当前页序号，从 0 开始。 */
  pageIndex: number
  /** 已知页数（走过的页 + 若还有下一页则再算一页）。 */
  knownPages: number
  /** 是否还有未走到的后续页——决定末尾是否显示省略号。 */
  hasMore: boolean
  onChange: (index: number) => void
  disabled?: boolean
  /** 最多同时显示几个页码（不含上下页按钮），默认 7。 */
  maxNumbers?: number
  className?: string
}

/**
 * 分页控件。
 *
 * 接口是游标分页，拿不到总数，因此这里显示的是**已知**页码：走到哪、页码就长到哪。
 * 末尾的省略号表示「后面还有，但总数未知」。要显示真实总页数、支持直接跳到远端页，
 * 需要后端在 pagination 里补 `total`（详见 usePagedList 的注释）。
 */
export function Pagination({
  pageIndex,
  knownPages,
  hasMore,
  onChange,
  disabled,
  maxNumbers = 7,
  className,
}: PaginationProps) {
  const { t } = useTranslation()

  // 单页且没有更多时不渲染——一页内容不需要分页条
  if (knownPages <= 1 && !hasMore) return null

  // 页码窗口：围绕当前页取一段，两端贴边时窗口顺移
  const half = Math.floor(maxNumbers / 2)
  let start = Math.max(0, pageIndex - half)
  const end = Math.min(knownPages, start + maxNumbers)
  start = Math.max(0, end - maxNumbers)
  const numbers: number[] = []
  for (let i = start; i < end; i++) numbers.push(i)

  return (
    <nav className={cx(styles.nav, className)} aria-label={t('pagination.label')}>
      <button
        type="button"
        className={cx(styles.btn, styles.step)}
        onClick={() => onChange(pageIndex - 1)}
        disabled={disabled || pageIndex === 0}
      >
        <ChevronLeft />
        {t('pagination.prev')}
      </button>

      <span className={styles.numbers}>
        {start > 0 && <span className={styles.more}>…</span>}
        {numbers.map((i) => {
          const current = i === pageIndex
          return (
            <button
              key={i}
              type="button"
              className={cx(styles.btn, current && styles.current)}
              onClick={() => onChange(i)}
              disabled={disabled || current}
              aria-current={current ? 'page' : undefined}
              aria-label={t('pagination.goToPage', { page: i + 1 })}
            >
              {i + 1}
            </button>
          )
        })}
        {/* 右侧省略号有两种成因：窗口没铺到最后一个已知页（end < knownPages），
            或已知页之后还有未走到的页（hasMore）。只判后者会让「翻到第 9 页再
            回到第 1 页」的情况丢掉提示——第 8、9 页被窗口挡住却毫无迹象。 */}
        {(end < knownPages || hasMore) && <span className={styles.more}>…</span>}
      </span>

      {/* 窄屏下页码列表隐藏，用「第 N 页」代替 */}
      <span className={styles.compact}>{t('pagination.current', { page: pageIndex + 1 })}</span>

      <button
        type="button"
        className={cx(styles.btn, styles.step)}
        onClick={() => onChange(pageIndex + 1)}
        disabled={disabled || pageIndex >= knownPages - 1}
      >
        {t('pagination.next')}
        <ChevronRight />
      </button>
    </nav>
  )
}
