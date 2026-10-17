/**
 * 详情页处理完一条后「退回」列表时的交接。
 *
 * 从列表点进来的详情，退回时用 history.back()：浏览历史里不会多出一条重复的列表记录，
 * 后退键仍然离开列表。但 back() 带不了 location.state，要聚焦的那一行和要提示的话
 * 只能经这里转交——列表挂载时按地址认领，地址对不上就作废，不会落到别的列表上。
 */
export interface ReturnIntent {
  /** 目标列表的 pathname + search（不含 ?toast=）。 */
  href: string
  focusRow?: string
  /** 认领后写进 URL 的 ?toast= 键（RootLayout 的通用提示）。 */
  toast?: string
}

let pending: ReturnIntent | null = null

export function setReturnIntent(intent: ReturnIntent): void {
  pending = intent
}

/**
 * 落到同一个列表才交出，并且只交一次。按路径比对、不比查询参数：
 * 后退落到的是浏览历史里真实的那一条，它的查询参数可能在此期间被 replace 过（比如翻了页），
 * 但仍是同一个列表——焦点、提示照样交给它。落到别的页面则作废。
 */
export function takeReturnIntent(href: string): ReturnIntent | null {
  const intent = pending
  pending = null
  const path = (value: string) => value.split('?')[0]
  return intent && path(intent.href) === path(href) ? intent : null
}
