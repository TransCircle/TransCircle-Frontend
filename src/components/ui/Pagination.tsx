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
 * 目标区域上方那些「吸顶」元素在滚动口顶部的遮挡下沿。
 *
 * 前台是 RootLayout 的 sticky 导航栏，后台列表页是 `.stickyHead`（标签+工具栏）——
 * 两者都是区域在**上方的兄弟节点**，滚动时若不给它们让位，区域开头就会被盖住。
 * 向上走到滚动容器为止：后台内容区自己是滚动容器，容器之外的导航栏盖不到它里面。
 *
 * 取各元素「吸附位置 + 自身高度」的**最大值**而不是累加：吸顶元素吸住后是互相重叠的
 * 图层，两个 `top: 0` 的叠在一起只遮挡较高的那个；而 `top: 40px` 的元素遮挡下沿是
 * 40 + 自身高度，只算高度会少让一截。
 */
function stickyOffsetAbove(region: HTMLElement, scroller: HTMLElement | null): number {
  let offset = 0
  let node: HTMLElement | null = region
  while (node && node !== scroller) {
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      const style = getComputedStyle(sib)
      // top: auto 的 sticky 不会吸在顶部，不占位
      if (style.position !== 'sticky' || style.top === 'auto') continue
      const pinnedTop = parseFloat(style.top)
      if (Number.isNaN(pinnedTop)) continue
      offset = Math.max(offset, pinnedTop + sib.getBoundingClientRect().height)
    }
    node = node.parentElement
  }
  return offset
}

/**
 * 换页后把「被分页的那块区域」滚到可视区顶部——不是把整页滚到 0。
 *
 * 区域取控件的父元素：列表页是整页容器（等于滚到页顶），文章详情页的评论区则只
 * 滚到评论区开头，不会把读者甩回文章标题；后台页在 `#admin-main` 内部滚动，因此
 * 先向上找最近的可滚动祖先，找不到才滚窗口。两种情况都要减去吸顶元素的高度。
 *
 * 必须显式 `behavior: 'instant'`：全站 `html` 上有 `scroll-behavior: smooth`，
 * 默认的平滑滚动是一段动画，而换页的响应几毫秒后就会重渲列表，重排会把动画掐掉，
 * 结果是一动不动地停在原处（实测如此）。换页本就该是瞬时跳转，不是滑一大段。
 */
function scrollListToTop(nav: HTMLElement | null): void {
  const region = nav?.parentElement
  if (!region) return

  let scroller: HTMLElement | null = region.parentElement
  while (scroller) {
    const overflowY = getComputedStyle(scroller).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break
    scroller = scroller.parentElement
  }

  const regionTop = region.getBoundingClientRect().top
  const stickyOffset = stickyOffsetAbove(region, scroller)
  if (scroller) {
    // clientTop：滚动口从上边框内侧开始，rect.top 是边框盒顶
    const scrollPortTop = scroller.getBoundingClientRect().top + scroller.clientTop
    const top = scroller.scrollTop + regionTop - scrollPortTop - stickyOffset
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'instant' })
    return
  }
  window.scrollTo({ top: Math.max(0, window.scrollY + regionTop - stickyOffset), behavior: 'instant' })
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
