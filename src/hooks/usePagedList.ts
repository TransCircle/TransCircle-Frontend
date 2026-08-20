/**
 * usePagedList —— 在游标分页接口之上提供「按页浏览」语义。
 *
 * 接口侧是纯游标分页（响应只有 `{ limit, nextCursor, hasMore }`，没有总数，
 * 也不接受 offset/page 参数），因此：
 *
 * - **能做**：一次只显示一页（替换而非追加）、上一页/下一页、回跳到已经走过
 *   的任意一页（这些页的游标已经缓存在 cursorsRef 里）。
 * - **做不到**：显示总页数、直接跳到尚未访问过的远端页。游标分页无法在不经过
 *   前序页的情况下定位第 N 页。若要支持，需要后端在 pagination 里补 `total`
 *   （或改为 offset 分页）。
 *
 * 取代原先的 useCursorList（那个 hook 把新页**追加**到列表尾部，即「加载更多」）。
 * fetchPage 签名保持不变，因此各列表页的取数逻辑一行都没有改动。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface PagedResult<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}

export interface UsePagedListOptions<T> {
  /** 拉取一页；cursor 为 null 表示第一页。调用方负责 URL 参数与错误抛错。 */
  fetchPage: (cursor: string | null) => Promise<PagedResult<T>>
  /** 重新加载的依赖项（切 tab / 搜索词 / 用户变更等）。变化时回到第一页。 */
  deps: ReadonlyArray<unknown>
  /** 是否在挂载/依赖变化时自动加载（默认 true） */
  autoLoad?: boolean
  /** 初始是否处于加载中（避免首帧空态闪屏，默认 true） */
  initialLoading?: boolean
}

export function usePagedList<T>({
  fetchPage,
  deps,
  autoLoad = true,
  initialLoading = true,
}: UsePagedListOptions<T>) {
  const [items, setItems] = useState<T[]>([])
  const [pageIndex, setPageIndex] = useState(0)
  /** 已知页数：已走过的页 + 若还有下一页则再算 1 页。 */
  const [knownPages, setKnownPages] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(initialLoading)
  const [error, setError] = useState('')

  /** cursorsRef[i] = 取第 i 页所需的游标；第 0 页恒为 null。 */
  const cursorsRef = useRef<(string | null)[]>([null])
  const fetchSeq = useRef(0)

  const load = useCallback(
    async (index: number) => {
      const cursor = cursorsRef.current[index] ?? null
      const seq = ++fetchSeq.current
      setLoading(true)
      setError('')
      try {
        const page = await fetchPage(cursor)
        if (seq !== fetchSeq.current) return // 过期响应，丢弃
        setItems(page.data)
        setPageIndex(index)
        setHasMore(page.hasMore)
        if (page.nextCursor) {
          cursorsRef.current[index + 1] = page.nextCursor
          setKnownPages((prev) => Math.max(prev, index + 2))
        } else {
          // 到底了：把已知页数收敛到当前页，避免残留一个点不动的页码
          cursorsRef.current.length = index + 1
          setKnownPages(index + 1)
        }
      } catch (err) {
        if (seq === fetchSeq.current) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === fetchSeq.current) setLoading(false)
      }
    },
    [fetchPage],
  )

  /** 跳到指定页（仅限已知页）。 */
  const goToPage = useCallback(
    (index: number) => {
      if (loading) return
      if (index < 0 || index >= knownPages || index === pageIndex) return
      void load(index)
    },
    [loading, knownPages, pageIndex, load],
  )

  /** 重新从第一页开始（切筛选/搜索/手动刷新）。 */
  const reload = useCallback(() => {
    cursorsRef.current = [null]
    setKnownPages(1)
    return load(0)
  }, [load])

  useEffect(() => {
    if (!autoLoad) return
    cursorsRef.current = [null]
    // 拉取数据是 effect 对外部数据源的订阅；load 首行 setLoading(true) 属该模式的
    // 同步 setState。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKnownPages(1)
    void load(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return {
    items,
    pageIndex,
    knownPages,
    hasMore,
    loading,
    error,
    setError,
    goToPage,
    reload,
    setItems,
  }
}
