import { useEffect, useState } from 'react'

/** 分区顶端越过「顶栏下沿 + 可视高度的这一比例」即视为进入该分区。 */
const ACTIVATION_RATIO = 0.3
/** 判定线离顶栏的最大距离：超高屏上 30% 会压到首屏正文，停在页顶时误判为已进入第一个分区。 */
const ACTIVATION_MAX_PX = 240
/** 距页面底部不足这么多像素时，直接认定为最后一个分区（末节太短时顶端永远到不了判定线）。 */
const BOTTOM_SLACK_PX = 4

function navHeight(): number {
  const nav = document.querySelector('nav')
  return nav ? nav.getBoundingClientRect().height : 0
}

/** 按当前滚动位置算出所在分区；还在第一个分区之上时返回第一个存在的分区。 */
function computeActive(ids: readonly string[]): string | null {
  const top = navHeight()
  const line = top + Math.min((window.innerHeight - top) * ACTIVATION_RATIO, ACTIVATION_MAX_PX)
  const present = ids.filter((id) => document.getElementById(id) !== null)

  const scroller = document.scrollingElement ?? document.documentElement
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - BOTTOM_SLACK_PX
  if (atBottom && scroller.scrollTop > 0) {
    const last = present[present.length - 1]
    if (last) return last
  }

  let active: string | null = present[0] ?? null
  for (const id of present) {
    const el = document.getElementById(id)
    if (el && el.getBoundingClientRect().top <= line) active = id
  }
  return active
}

/**
 * 滚动监听（scroll spy）：返回视口当前所在分区的 id（移植自 Pass 门户）。
 * 捕获阶段监听 scroll：视口锁定布局里滚的是 <main> 而非 document，两种都能收到；
 * 每帧最多计算一次。
 */
export function useSectionSpy(ids: readonly string[], enabled = true): string | null {
  const [active, setActive] = useState<string | null>(null)
  const key = ids.join('|')

  useEffect(() => {
    if (!enabled) return
    const list = key.split('|')
    let raf = 0
    const update = () => {
      raf = 0
      setActive(computeActive(list))
    }
    const schedule = () => {
      if (raf === 0) raf = window.requestAnimationFrame(update)
    }
    schedule()
    document.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      document.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      if (raf !== 0) window.cancelAnimationFrame(raf)
    }
  }, [key, enabled])

  return enabled ? active : null
}
