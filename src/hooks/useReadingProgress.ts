import { useCallback } from 'react'

/**
 * 阅读进度条（DESIGN.md v3.0 §5.10）。
 *
 * 返回挂在进度条填充元素上的**回调 ref**；滚动时直接写它的 `transform: scaleX()`。
 * 刻意不走 React state：进度每帧都在变，走 state 会让整棵子树每帧重渲染。
 * scaleX 在合成层上跑，不触发布局。
 *
 * 用回调 ref 而不是 useEffect + useRef：阅读页先渲染加载骨架、数据到达后才挂出进度条，
 * 空依赖的 effect 只在首帧跑一次，那时元素还不存在，监听永远挂不上（进度条恒为 0）。
 * 回调 ref 随元素挂载 / 卸载执行（React 19 支持返回清理函数），时机天然正确。
 *
 * 减少动画偏好下仍然更新——进度条传达的是位置信息，不是装饰动画；它本身没有过渡。
 */
export const useReadingProgress = <T extends HTMLElement = HTMLElement>() =>
  useCallback((bar: T | null) => {
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
