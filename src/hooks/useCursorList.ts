/**
 * useCursorList —— 统一的游标分页列表 hook。
 *
 * 收敛各列表页（Home / MyContributions / Admin / AdminUsers / AdminAuditLogs /
 * AdminEditRequests）重复的拉取样板：fetchSeq 竞态守卫、loading/error 状态、
 * 追加(loadMore) vs 替换(切 tab/搜索)、nextCursor 更新。
 *
 * 设计约束：
 * - 由调用方提供 fetchPage(cursor?)：返回 { data, nextCursor, hasMore } 或抛错；
 * - 首次挂载自动加载（initialLoad=true 默认）；
 * - 切换筛选/搜索时调用 reload() 替换列表（不清空旧内容，配合 loadingBar 保留观感）；
 * - loadMore() 追加下一页；
 * - 返回的 loading 在「首载/刷新/加载更多」期间统一为 true，供顶部加载条与按钮 spinner 复用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface CursorPage<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}

export interface UseCursorListOptions<T> {
  /** 拉取一页数据；cursor 为 null 表示第一页。调用方负责 URL 参数与错误抛错。 */
  fetchPage: (cursor: string | null) => Promise<CursorPage<T>>
  /** 重新加载的依赖项（切 tab / 搜索词 / 用户变更等）。变化时自动 reload。 */
  deps: ReadonlyArray<unknown>
  /** 是否在挂载/依赖变化时自动加载（默认 true） */
  autoLoad?: boolean
  /** 初始是否处于加载中（避免首帧空态闪屏 FOUC，默认 true） */
  initialLoading?: boolean
}

export function useCursorList<T>({
  fetchPage,
  deps,
  autoLoad = true,
  initialLoading = true,
}: UseCursorListOptions<T>) {
  const [items, setItems] = useState<T[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(initialLoading)
  const [error, setError] = useState('')
  const fetchSeq = useRef(0)

  /** 首载/刷新：替换列表 */
  const reload = useCallback(async () => {
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const page = await fetchPage(null)
      if (seq !== fetchSeq.current) return // Stale response, discard
      setItems(page.data)
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (err) {
      if (seq === fetchSeq.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }, [fetchPage])

  /** 加载更多：追加下一页 */
  const loadMore = useCallback(async () => {
    if (loading || !cursor) return
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const page = await fetchPage(cursor)
      if (seq !== fetchSeq.current) return
      setItems((prev) => [...prev, ...page.data])
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (err) {
      // loadMore 失败：保留已加载内容，仅提示错误
      if (seq === fetchSeq.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }, [loading, cursor, fetchPage])

  // 依赖变化时自动重载（切 tab / 搜索 / 用户变更）
  useEffect(() => {
    if (!autoLoad) return
    // fetch 数据是 effect 对外部数据源的订阅；reload 首行 setLoading(true) 属该模式的同步 setState，
    // 与 React 文档「effect 中订阅外部数据」一致，通过禁用规则抑制（与原列表页实现同款）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { items, cursor, hasMore, loading, error, setError, reload, loadMore, setItems }
}
