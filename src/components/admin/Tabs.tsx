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
  variant?: 'underline' | 'segmented'
  /** 当所有标签共用单个 tabpanel 时传入其 id，避免 aria-controls 指向不存在的元素。 */
  panelId?: string
}

/** WAI-ARIA tablist：roving tabindex + 方向键/Home/End 导航。 */
export function Tabs<K extends string = string>({
  items,
  value,
  onChange,
  ariaLabel,
  variant = 'underline',
  panelId,
}: TabsProps<K>) {
  const refs = useRef<HTMLButtonElement[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  // Roving tabindex: the selected tab is focusable. If `value` matches no item,
  // fall back to the first tab so the tablist never drops out of the tab order.
  const selectedIndex = items.findIndex((t) => t.key === value)
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0

  /* 滑动指示条（DESIGN §5.9）：2px 高的 --pink-600 条，用 transform 在标签间滑动。
     几何量必须实测——标签宽度取决于中文文案长度与字体加载时机，写不死。 */
  const isUnderline = variant === 'underline'
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    if (!isUnderline) return
    const measure = () => {
      const el = refs.current[rovingIndex]
      if (!el) return
      setIndicator({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()

    // 容器尺寸变化（窗口缩放、侧栏展开）与 webfont 落位都会改变标签宽度。
    const ro = new ResizeObserver(measure)
    if (listRef.current) ro.observe(listRef.current)
    for (const el of refs.current) {
      if (el) ro.observe(el)
    }
    return () => ro.disconnect()
  }, [isUnderline, rovingIndex, items])

  // 展示字体是异步加载的，落位后标签宽度会变，指示条需要重测一次。
  useEffect(() => {
    if (!isUnderline || !('fonts' in document)) return
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled) return
      const el = refs.current[rovingIndex]
      if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth })
    })
    return () => {
      cancelled = true
    }
  }, [isUnderline, rovingIndex])

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
    refs.current[next]?.focus()
  }

  return (
    <div
      ref={listRef}
      className={cx(styles.tabs, variant === 'segmented' ? styles.segmented : styles.underline)}
      role="tablist"
      aria-label={ariaLabel}
    >
      {isUnderline && indicator && (
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
