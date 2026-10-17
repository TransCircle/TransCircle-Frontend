import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { cx } from './cx'
import styles from './Tabs.module.css'

export interface TabItem<K extends string = string> {
  key: K
  label: string
  badge?: number | string
}

export interface TabsProps<K extends string = string> {
  items: ReadonlyArray<TabItem<K>>
  value: K
  onChange: (key: K) => void
  ariaLabel: string
  /** 当所有标签共用单个 tabpanel 时传入其 id，避免 aria-controls 指向不存在的元素。 */
  panelId?: string
}

/** 右缘淡出遮罩宽度，须与 Tabs.module.css 的 .moreToEnd 一致。 */
const FADE_MASK_PX = 28

/**
 * 横向滚动容器里把某个子元素挪进可视范围：只动容器自己的 scrollLeft。
 * 刻意不用 scrollIntoView——它会连带滚动所有祖先（包括文档本身），切个标签整页纵向跳一截。
 */
function revealInScroller(scroller: HTMLElement, el: HTMLElement) {
  if (scroller.scrollWidth <= scroller.clientWidth) return
  const box = scroller.getBoundingClientRect()
  const item = el.getBoundingClientRect()
  // 右侧还有内容时右缘挂着 28px 淡出遮罩：目标要停在遮罩之外才算完整可见。
  const atEnd = el === scroller.lastElementChild
  const rightInset = atEnd ? 0 : FADE_MASK_PX
  if (item.left < box.left) scroller.scrollLeft -= box.left - item.left
  else if (item.right > box.right - rightInset) scroller.scrollLeft += item.right - (box.right - rightInset)
}

/** WAI-ARIA tablist：roving tabindex + 方向键/Home/End 导航（DESIGN §5.9 下划线样式）。 */
export function Tabs<K extends string = string>({ items, value, onChange, ariaLabel, panelId }: TabsProps<K>) {
  const refs = useRef<HTMLButtonElement[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  // Roving tabindex: the selected tab is focusable. If `value` matches no item,
  // fall back to the first tab so the tablist never drops out of the tab order.
  const selectedIndex = items.findIndex((t) => t.key === value)
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0

  /* 滑动指示条（DESIGN §5.9）：2px 高的 --pink-600 条，用 transform 在标签间滑动。
     几何量必须实测——标签宽度取决于中文文案长度与字体加载时机，写不死。 */
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)
  /** 还有内容藏在右侧：只在这时给右缘挂淡出遮罩，滚到底就摘掉（否则最后一个标签永远发虚）。 */
  const [moreToEnd, setMoreToEnd] = useState(false)
  /* 调用方普遍在渲染时新建 items 数组：依赖只取「标签集合」的稳定签名，
     否则每次重渲染都会重跑测量 → setState → 重渲染，形成死循环。 */
  const itemsKey = JSON.stringify(items.map((it) => [it.key, it.label, it.badge ?? null]))

  /** 几何没变就不更新状态：ResizeObserver 与字体回调会频繁触发同值测量。 */
  const placeIndicator = (el: HTMLButtonElement | undefined) => {
    if (!el) return
    const next = { left: el.offsetLeft, width: el.offsetWidth }
    setIndicator((prev) => (prev && prev.left === next.left && prev.width === next.width ? prev : next))
  }

  const syncOverflow = () => {
    const list = listRef.current
    if (!list) return
    setMoreToEnd(list.scrollLeft + list.clientWidth < list.scrollWidth - 1)
  }

  useLayoutEffect(() => {
    const measure = () => {
      placeIndicator(refs.current[rovingIndex])
      // 容器变窄（缩窗、旋转）时当前标签可能被挤出可视范围，跟着重新显露。
      const list = listRef.current
      const el = refs.current[rovingIndex]
      if (list && el) revealInScroller(list, el)
      syncOverflow()
    }
    measure()

    // 容器尺寸变化（窗口缩放、侧栏展开）与 webfont 落位都会改变标签宽度。
    const ro = new ResizeObserver(measure)
    if (listRef.current) ro.observe(listRef.current)
    for (const el of refs.current) {
      if (el) ro.observe(el)
    }
    return () => ro.disconnect()
  }, [rovingIndex, itemsKey])

  // 当前标签变化（点击、方向键、外部改值）时，把它滚进横向可视范围。
  useLayoutEffect(() => {
    const list = listRef.current
    const el = refs.current[rovingIndex]
    if (list && el) revealInScroller(list, el)
  }, [rovingIndex, itemsKey])

  // 展示字体是异步加载的，落位后标签宽度会变，指示条需要重测一次。
  useEffect(() => {
    if (!('fonts' in document)) return
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled) return
      placeIndicator(refs.current[rovingIndex])
    })
    return () => {
      cancelled = true
    }
  }, [rovingIndex])

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (i + 1) % items.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (i - 1 + items.length) % items.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = items.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    const target = items[next]
    if (!target) return
    onChange(target.key)
    // preventScroll：可视范围交给 revealInScroller，只横向挪动标签条，不带动页面。
    refs.current[next]?.focus({ preventScroll: true })
  }

  return (
    <div
      ref={listRef}
      className={cx(styles.tabs, moreToEnd && styles.moreToEnd)}
      role="tablist"
      aria-label={ariaLabel}
      onScroll={syncOverflow}
    >
      {indicator && (
        <span
          className={styles.indicator}
          aria-hidden="true"
          style={{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }}
        />
      )}
      {items.map((item, i) => {
        const active = item.key === value
        return (
          <button
            key={item.key}
            ref={(el) => {
              if (el) refs.current[i] = el
            }}
            id={`tab-${item.key}`}
            role="tab"
            type="button"
            aria-selected={active}
            aria-controls={panelId ?? `tabpanel-${item.key}`}
            tabIndex={i === rovingIndex ? 0 : -1}
            className={cx(styles.tab, active && styles.active)}
            onClick={() => onChange(item.key)}
            onKeyDown={(e) => handleKeyDown(e, i)}
          >
            <span className={styles.tabLabel}>{item.label}</span>
            {item.badge != null && <span className={styles.badge}>{item.badge}</span>}
          </button>
        )
      })}
    </div>
  )
}
