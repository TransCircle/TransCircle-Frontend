import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../admin/cx'
import styles from './Pagination.module.css'

const ChevronLeft = () => (
  <svg
    width="16"
    height="16"
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
    width="16"
    height="16"
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

/**
 * 页码序列：首页、末页、当前页 ±1 恒显示，中间折叠为省略号。
 * 数字项可直达；`'gap-l'` / `'gap-r'` 是不可点的折叠占位（两侧各一，key 需唯一）。
 */
function pageList(current: number, total: number): Array<number | 'gap-l' | 'gap-r'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const out: Array<number | 'gap-l' | 'gap-r'> = [1]
  const from = Math.max(2, current - 1)
  const to = Math.min(total - 1, current + 1)
  if (from > 2) out.push('gap-l')
  for (let i = from; i <= to; i++) out.push(i)
  if (to < total - 1) out.push('gap-r')
  out.push(total)
  return out
}

/**
 * 换页后把列表滚回顶部：后台页在 `#admin-main` 内部滚动、前台页走文档滚动，
 * 因此从控件自身向上找最近的可滚动祖先，找不到就滚窗口——调用方无需关心自己
 * 处在哪种滚动容器里。
 */
function scrollListToTop(from: HTMLElement | null): void {
  let node: HTMLElement | null = from?.parentElement ?? null
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      node.scrollTo({ top: 0 })
      return
    }
    node = node.parentElement
  }
  window.scrollTo({ top: 0 })
}

export interface PaginationProps {
  /** 当前页码，从 1 开始 */
  page: number
  /** 总页数，至少为 1 */
  totalPages: number
  /** 命中筛选条件的总条数（用于「共 N 条 · 第 x–y 条」） */
  total: number
  /** 每页条数，用于推算当前页的条目区间 */
  pageSize: number
  onChange: (page: number) => void
  /** 加载中：禁用全部换页按钮，避免连点堆叠请求 */
  disabled?: boolean
  className?: string
}

/**
 * 页码分页控件：页码直达 + 上/下一页 + 「共 N 条 · 第 x–y 条」。
 *
 * 依赖后端返回 `total` / `totalPages`（apidocs.md §通用约定「分页」）——总页数
 * 与「跳到第 N 页」都是 offset 分页才给得出的能力。
 */
export function Pagination({ page, totalPages, total, pageSize, onChange, disabled, className }: PaginationProps) {
  const { t } = useTranslation()
  const navRef = useRef<HTMLElement>(null)

  if (total === 0) return null

  const first = (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)

  // 用 aria-disabled 而非 disabled：按钮会在自身被聚焦时变为不可用（点到末页、
  // 或加载中整条禁用），真 disabled 会让焦点掉回 body，键盘用户得重新 Tab 回来。
  const go = (target: number, inactive: boolean) => {
    if (inactive || target < 1 || target > totalPages || target === page) return
    onChange(target)
    scrollListToTop(navRef.current)
  }

  const atFirst = disabled || page <= 1
  const atLast = disabled || page >= totalPages

  return (
    <nav ref={navRef} className={cx(styles.nav, className)} aria-label={t('pagination.label')}>
      <p className={styles.summary}>{t('pagination.summary', { total, first, last })}</p>

      {totalPages > 1 && (
        <div className={styles.controls}>
          <button
            type="button"
            className={cx(styles.btn, styles.step)}
            onClick={() => go(page - 1, atFirst)}
            aria-disabled={atFirst || undefined}
          >
            <ChevronLeft />
            {t('pagination.prev')}
          </button>

          <span className={styles.numbers}>
            {pageList(page, totalPages).map((item) =>
              typeof item === 'string' ? (
                <span key={item} className={styles.gap} aria-hidden="true">
                  …
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  className={cx(styles.btn, item === page && styles.current)}
                  onClick={() => go(item, Boolean(disabled))}
                  aria-disabled={disabled || undefined}
                  aria-current={item === page ? 'page' : undefined}
                  aria-label={t('pagination.goToPage', { page: item })}
                >
                  {item}
                </button>
              ),
            )}
          </span>

          {/* 窄屏下页码列表隐藏，用「第 x / 共 y 页」代替，避免换行成两三排 */}
          <span className={styles.compact}>{t('pagination.current', { page, totalPages })}</span>

          <button
            type="button"
            className={cx(styles.btn, styles.step)}
            onClick={() => go(page + 1, atLast)}
            aria-disabled={atLast || undefined}
          >
            {t('pagination.next')}
            <ChevronRight />
          </button>
        </div>
      )}
    </nav>
  )
}
