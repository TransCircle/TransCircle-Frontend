import { useEffect, useRef, useState } from 'react'
import { TURNSTILE_SITE_KEY } from '@/config'
import { useTheme } from '@/context/useTheme'

export interface TurnstileWidgetProps {
  onToken: (token: string) => void
  onError?: () => void
  onExpire?: () => void
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        opts: {
          sitekey: string
          callback: (token: string) => void
          'error-callback'?: () => void
          'expired-callback'?: () => void
          theme?: 'light' | 'dark' | 'auto'
        },
      ) => string
      reset: (widgetId: string) => void
      remove: (widgetId: string) => void
    }
  }
}

/**
 * Cloudflare Turnstile widget wrapper（故事站评论/举报人机验证）。
 *
 * - 惰性加载 Turnstile 脚本（跨实例共享）。
 * - VITE_TURNSTILE_SITE_KEY 未配置时返回 null（本地 dev 兜底，后端同步跳过校验）。
 * - 暴露 data-turnstile-widget 属性，调用方可外部 window.turnstile.reset(...)；
 * - 主题跟随页面主题（ThemeContext），切换主题时移除旧 widget 并重渲染，
 *   不用 theme: 'auto'——auto 跟随的是系统配色，页面手动切暗色时不会变。
 * - 令牌是单次使用的：每次成功提交后调用方应重挂载（换 key）以获取新挑战。
 */
export const TurnstileWidget = ({ onToken, onError, onExpire }: TurnstileWidgetProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scriptReady, setScriptReady] = useState(false)
  const { theme } = useTheme()

  // 回调存 ref，渲染 effect 不因父组件每次 render 传新内联函数而重跑。
  const onTokenRef = useRef(onToken)
  const onErrorRef = useRef(onError)
  const onExpireRef = useRef(onExpire)

  useEffect(() => {
    onTokenRef.current = onToken
    onErrorRef.current = onError
    onExpireRef.current = onExpire
  }, [onToken, onError, onExpire])

  // ── 惰性加载 Turnstile 脚本（仅当未加载时执行） ───────────────
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || scriptReady) return

    // 双检：脚本可能在首次渲染和 effect 运行之间加载完毕（同步初始化，
    // 避免重复创建 script 标签或无限等待已加载脚本的 load 事件）。
    if (window.turnstile) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setScriptReady(true)
      return
    }

    let cancelled = false
    const onLoad = () => {
      if (!cancelled) setScriptReady(true)
    }

    // <head> 里已有脚本但还没加载完。
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]',
    )
    if (existing) {
      existing.addEventListener('load', onLoad)
      return () => {
        existing.removeEventListener('load', onLoad)
      }
    }

    // 首次挂载：创建脚本标签。
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
    script.async = true
    script.defer = true
    script.onload = onLoad
    document.head.appendChild(script)

    return () => {
      cancelled = true
    }
  }, [scriptReady])

  // ── 渲染 Turnstile widget ────────────────────────────────────
  useEffect(() => {
    if (!scriptReady || !TURNSTILE_SITE_KEY || !containerRef.current || !window.turnstile) return

    const el = containerRef.current
    const widgetId = window.turnstile.render(el, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token: string) => {
        onTokenRef.current(token)
      },
      'error-callback': () => {
        onErrorRef.current?.()
      },
      'expired-callback': () => {
        onExpireRef.current?.()
      },
      theme,
    })

    // 暴露 widget ID，方便调用方外部 reset。
    el.dataset.turnstileWidget = widgetId

    return () => {
      if (window.turnstile) {
        try {
          /* 卸载/换主题时用 remove 销毁旧 widget：仅 reset 的话旧 iframe 还留在
             容器里，重渲染会在同一容器里叠出第二个 widget。 */
          window.turnstile.remove(widgetId)
        } catch {
          // Widget 已从 DOM 移除，无需销毁。
        }
      }
    }
  }, [scriptReady, theme])

  if (!TURNSTILE_SITE_KEY) return null

  return <div ref={containerRef} />
}
