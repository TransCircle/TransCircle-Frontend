import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { focusRowAndWatch } from '@/components/admin/restoreFocus'
import { takeReturnIntent } from './returnIntent'

/** 从列表点进详情时随导航带过去的状态：返回落点与这一行在页内的位置（「下一条」用）。 */
export interface RowLinkState {
  from: string
  index: number
  /**
   * 浏览历史里这条详情之前的那个列表地址（连续审稿 replace 过来时沿用最初那条）。
   * 连续审稿翻到下一页后 from 会变，而历史里的仍是原页——两者不同就不能用 history.back()。
   */
  historyFrom?: string | null
  /** 连续审稿这一轮里已经处理过的条目：排序会因处理而变化时，找「下一条」要跳过它们。 */
  done?: string[]
}

/** 从详情回到列表时带回来的状态：要重新聚焦的那一行。 */
export interface ReturnState {
  focusRow?: string
}

/**
 * 后台列表的 URL 状态：筛选、关键词、排序、页码都放在查询参数里，
 * 刷新、从详情返回、复制链接都能回到同一个视图。
 *
 * 一律 replace 写入：筛选和翻页不该在浏览历史里堆一串记录，后退应该离开这个列表，
 * 而不是一步步撤销筛选。写入基于实时的 window.location.search（同搜索页），
 * 不会把 RootLayout 的 ?toast= 之类别人刚写进来的参数抹掉。
 */
export function useListParams() {
  const [searchParams, setSearchParams] = useSearchParams()

  /** 改筛选：除非显式给出 page，一律回到第 1 页（换了条件，旧页码没有意义）。 */
  const patch = useCallback(
    (changes: Record<string, string | null>) => {
      setSearchParams(
        () => {
          const next = new URLSearchParams(window.location.search)
          for (const [key, value] of Object.entries(changes)) {
            if (value) next.set(key, value)
            else next.delete(key)
          }
          if (!('page' in changes)) next.delete('page')
          if (next.get('page') === '1') next.delete('page')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const rawPage = Number.parseInt(searchParams.get('page') ?? '', 10)
  const page = Number.isFinite(rawPage) && rawPage > 1 ? rawPage : 1

  const setPage = useCallback((next: number) => patch({ page: next > 1 ? String(next) : null }), [patch])

  return { searchParams, patch, page, setPage }
}

/** 列表地址去掉一次性的 ?toast=：它是 RootLayout 的提示通道，不属于列表视图本身。 */
export function listHref(pathname: string, search: string): string {
  const params = new URLSearchParams(search)
  params.delete('toast')
  const qs = params.toString()
  return qs ? `${pathname}?${qs}` : pathname
}

/** 当前列表的完整地址，作为详情页的返回落点。 */
export function useListHref(): string {
  const location = useLocation()
  return listHref(location.pathname, location.search)
}

/**
 * 从详情回到列表后，把焦点还给当初点开的那一行（替代原来组件内的列表 ↔ 详情焦点接力）。
 *
 * 落点来自两处：详情页标题栏的「返回」链接带的 location.state，或处理完一条后经
 * history.back() 退回时转交的 ReturnIntent（back() 带不了 state，见 returnIntent.ts）。
 * 行要等数据回来才渲染，所以等 ready 再找；只尝试一次。
 * 行已经不在了（操作后条目移出了当前筛选）时不强行聚焦——外壳已经把焦点放在 <main>。
 */
export function useReturnFocus(ready: boolean) {
  const location = useLocation()
  const [, setSearchParams] = useSearchParams()
  /** undefined：还没认领；null：没有要聚焦的行。 */
  const targetRef = useRef<string | null | undefined>(undefined)

  // 挂载时认领一次（effect 里做：开发期 StrictMode 会把渲染跑两遍，认领是一次性的副作用）
  useEffect(() => {
    if (targetRef.current !== undefined) return
    const intent = takeReturnIntent(listHref(location.pathname, location.search))
    targetRef.current = intent?.focusRow ?? (location.state as ReturnState | null)?.focusRow ?? null
    const toast = intent?.toast
    if (toast) {
      setSearchParams(
        () => {
          const next = new URLSearchParams(window.location.search)
          next.set('toast', toast)
          return next
        },
        { replace: true },
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const id = targetRef.current
    if (!ready || !id) return
    targetRef.current = null
    const row = document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)
    if (row) focusRowAndWatch(row)
  }, [ready])
}
