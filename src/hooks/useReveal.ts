import { useEffect, useRef, type DependencyList } from 'react'

/** 滚动 reveal 的目标选择器。元素自带全局 `.reveal` 类（见 styles/index.css），
 *  由本 hook 在进入视口时补上 `.is-visible`。 */
const REVEAL_SELECTOR = '[data-reveal]'
const VISIBLE_CLASS = 'is-visible'

/**
 * 滚动 reveal（DESIGN.md v3.0 §6.4）。
 *
 * 返回一个 ref，挂到容器元素上；容器内所有带 `data-reveal` 的后代会被观察，
 * 进入视口时加上 `.is-visible` 并**立即取消观察**（只触发一次）。
 * 交错延迟由各元素自己的 `--i` 决定（CSS 里 `calc(var(--i) * 60ms)`）。
 *
 * 降级路径有两条，都必须让内容可见——`.reveal` 默认是 opacity:0，
 * 任何一条漏掉都会造成整页空白：
 *   · `prefers-reduced-motion: reduce` —— CSS 侧已强制 opacity:1，这里直接不观察；
 *   · 无 IntersectionObserver —— 手动把所有目标标成可见。
 *
 * @param deps 列表数据等依赖；变化时重新收集目标（新渲染出的卡片也要被观察）。
 */
export const useReveal = <T extends HTMLElement = HTMLElement>(deps: DependencyList = []) => {
  const containerRef = useRef<T | null>(null)

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const targets = Array.from(root.querySelectorAll<HTMLElement>(REVEAL_SELECTOR))
    if (targets.length === 0) return

    const markAllVisible = () => {
      for (const el of targets) el.classList.add(VISIBLE_CLASS)
    }

    // 降级：减少动画偏好 —— 内容恒可见，不做入场。
    const prefersReduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced) {
      markAllVisible()
      return
    }

    // 降级：无 IntersectionObserver —— 同样必须可见，否则整页停在 opacity:0。
    if (typeof IntersectionObserver === 'undefined') {
      markAllVisible()
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add(VISIBLE_CLASS)
          // 只触发一次：入场动画不该在来回滚动时重放。
          observer.unobserve(entry.target)
        }
      },
      // 底部留 8% 余量，元素露头一点点就开始，不必等完全进入视口。
      { rootMargin: '0px 0px -8% 0px', threshold: 0.01 },
    )

    for (const el of targets) observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return containerRef
}
