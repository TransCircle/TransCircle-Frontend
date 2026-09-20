import { useEffect, useRef } from 'react'

/**
 * 阅读进度条（DESIGN.md v3.0 §5.10）。
 *
 * 返回挂在进度条填充元素上的 ref；滚动时直接写它的 `transform: scaleX()`。
 * 刻意不走 React state：进度每帧都在变，走 state 会让整棵子树每帧重渲染。
 * scaleX 在合成层上跑，不触发布局。
 *
 * 减少动画偏好下仍然更新——进度条传达的是位置信息，不是装饰动画；
 * 它本身没有过渡，不构成「动效」。
 */
export const useReadingProgress = <T extends HTMLElement = HTMLElement>() => {
  const barRef = useRef<T | null>(null)

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return

    let frame = 0

    const update = () => {
      frame = 0
      const doc = document.documentElement
      // 可滚动的总距离；内容不足一屏时为 0，此时进度恒为 0，避免除零。
      const scrollable = doc.scrollHeight - window.innerHeight
      const ratio = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0
      bar.style.transform = `scaleX(${ratio})`
    }

    // rAF 节流：scroll 事件的触发频率远高于渲染帧率。
    const onScroll = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(update)
    }

    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  return barRef
}
