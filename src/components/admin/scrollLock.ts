/**
 * 全站共享的页面滚动锁（引用计数）。
 *
 * Modal、StepUpDialog 与导航抽屉共用这一份计数：step-up 有时开在理由/确认弹窗
 * 之上（此时 Modal 已持锁），有时直接弹出；抽屉里也可能再叠弹窗。各写各的
 * 「存原值 → hidden → 还原」会在跨家族、非 LIFO 关闭时把页面永久锁死或提前解锁，
 * 统一计数后只有第一次上锁记录原值、最后一次解锁还原。
 *
 * 与 Pass 门户 `src/utils/scrollLock.ts` 对齐的两点：
 * - **滚动条补偿**：index.css 给 html 常驻了 `scrollbar-gutter: stable`，槽位一直在，
 *   锁滚动不会横移；此时再补等宽 padding 反而把内容推歪。只有不支持该属性的浏览器
 *   才按老办法补偿。
 * - **真正在滚的容器**：宽屏视口锁定的页面（RootLayout 的 data-viewport-fit）滚的是
 *   <main> 而非 document，只锁 body 的话弹窗背后照样能用滚轮滚，这里一并锁住它，
 *   并在 resize 时重新认领（窗口跨过锁定断点时滚动容器会换人）。
 *
 * 本仓保留的一点：**iOS 回弹**。弹窗场景下 body 额外 `position: fixed` + 记录 scrollY，
 * overflow:hidden 单独挡不住 iOS Safari 的橡皮筋滚动。抽屉不用这一档（传
 * `fixedBody: false`）：fixed 会把粘性顶栏连同其上的关闭按钮一起移出视口。
 * 档位由第一次上锁决定，嵌套上锁沿用。
 */

export interface ScrollLockOptions {
  /** 是否用 `position: fixed` 冻结 body（默认 true，挡 iOS 回弹）。 */
  fixedBody?: boolean
}

/** html 是否已经常驻滚动条槽位（true 则锁滚动不会横移，无需 padding 补偿）。 */
const documentReservesGutter = (): boolean =>
  getComputedStyle(document.documentElement).scrollbarGutter?.startsWith('stable') === true

/** 元素自身垂直滚动条宽度（扣掉左右边框，避免有边框时多补一截）。 */
const scrollbarWidthOf = (el: HTMLElement): number => {
  const cs = getComputedStyle(el)
  const borders = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0)
  return Math.max(0, el.offsetWidth - el.clientWidth - borders)
}

/** 把滚动条让出的宽度**叠加**到元素原有的右内边距上。 */
const padForScrollbar = (el: HTMLElement, width: number) => {
  if (width <= 0) return
  const current = parseFloat(getComputedStyle(el).paddingRight) || 0
  el.style.paddingRight = `${current + width}px`
}

/** 当前真正承担页面滚动的 <main>（宽屏视口锁定时），没有则 null。 */
const innerScroller = (): HTMLElement | null => {
  const main = document.querySelector<HTMLElement>('main')
  if (!main) return null
  const overflowY = getComputedStyle(main).overflowY
  return overflowY === 'auto' || overflowY === 'scroll' ? main : null
}

let lockCount = 0
let saved: {
  overflowX: string
  overflowY: string
  paddingRight: string
  position: string
  top: string
  width: string
  scrollY: number
  /** 上锁时的路由：解锁时已换页就不恢复滚动位置。 */
  pathname: string
  fixed: boolean
} | null = null

let lockedScroller: HTMLElement | null = null
let lockedScrollerStyle = { x: '', y: '', paddingRight: '' }

/**
 * 认领 / 交还内部滚动容器。只认领**本来就是滚动容器**的 main：无条件给 main 加
 * overflow:hidden 会把它变成滚动上下文，后台 `top: var(--nav-h)` 的 sticky 会当场跳位。
 */
const adoptScroller = (next: HTMLElement | null) => {
  if (next === lockedScroller) return
  if (lockedScroller) {
    lockedScroller.style.overflowX = lockedScrollerStyle.x
    lockedScroller.style.overflowY = lockedScrollerStyle.y
    lockedScroller.style.paddingRight = lockedScrollerStyle.paddingRight
  }
  lockedScroller = next
  if (!next) {
    lockedScrollerStyle = { x: '', y: '', paddingRight: '' }
    return
  }
  lockedScrollerStyle = {
    x: next.style.overflowX,
    y: next.style.overflowY,
    paddingRight: next.style.paddingRight,
  }
  // 锁定模式的 main 自带 scrollbar-gutter: stable；不支持该属性时才量自身滚动条补偿。
  const width = documentReservesGutter() ? 0 : scrollbarWidthOf(next)
  next.style.overflowX = 'hidden'
  next.style.overflowY = 'hidden'
  padForScrollbar(next, width)
}

/** 先交还再重判：被接管的 main 上写着锁自己的 hidden，直接重判会来回横跳。 */
const onResize = () => {
  adoptScroller(null)
  adoptScroller(innerScroller())
}

export function lockScroll(options: ScrollLockOptions = {}): void {
  if (lockCount === 0) {
    const { body, documentElement } = document
    const fixed = options.fixedBody ?? true
    saved = {
      overflowX: body.style.overflowX,
      overflowY: body.style.overflowY,
      paddingRight: body.style.paddingRight,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      scrollY: window.scrollY,
      pathname: window.location.pathname,
      fixed,
    }
    const scrollbarWidth = documentReservesGutter() ? 0 : window.innerWidth - documentElement.clientWidth
    if (fixed) {
      body.style.position = 'fixed'
      body.style.top = `-${saved.scrollY}px`
      body.style.width = '100%'
    }
    body.style.overflowX = 'hidden'
    body.style.overflowY = 'hidden'
    padForScrollbar(body, scrollbarWidth)
    adoptScroller(innerScroller())
    window.addEventListener('resize', onResize)
  }
  lockCount++
}

export function unlockScroll(): void {
  if (lockCount === 0) return
  lockCount--
  if (lockCount > 0 || !saved) return
  window.removeEventListener('resize', onResize)
  adoptScroller(null)
  const { body } = document
  body.style.overflowX = saved.overflowX
  body.style.overflowY = saved.overflowY
  body.style.paddingRight = saved.paddingRight
  body.style.position = saved.position
  body.style.top = saved.top
  body.style.width = saved.width
  /* instant：html 在 no-preference 下是 scroll-behavior: smooth，还原位置不能变成一段滚动动画。
     持锁期间已换页（弹窗开着时后退、操作后跳转）就不恢复：离开页的位置会盖掉新页的滚动归零。 */
  if (saved.fixed && saved.pathname === window.location.pathname) {
    window.scrollTo({ top: saved.scrollY, behavior: 'instant' })
  }
  saved = null
}
