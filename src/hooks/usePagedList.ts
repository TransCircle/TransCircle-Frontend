/**
 * usePagedList —— 统一的页码分页列表 hook。
 *
 * 收敛各列表页（Home / MyContributions / Admin / AdminUsers / AdminAuditLogs /
 * AdminEditRequests / AdminComments / CommentSection）重复的拉取样板：竞态守卫、
 * loading/error 状态、切页替换列表、总数与总页数回填。
 *
 * 接口侧是 offset 分页（apidocs.md §通用约定「分页」）：请求带 `page` + `limit`，
 * 响应回 `{ limit, page, total, totalPages, hasMore }`。因此这里能直接跳到任意一页
 * 并显示总页数 —— 这是它取代「加载更多」和更早那版游标翻页的原因：游标既给不出
 * 总数，也无法在不经过前序页的情况下定位第 N 页，页码簿记（游标缓存、末页判定、
 * 链路分叉截断）也随之整块消失。
 *
 * 设计约束：
 * - 由调用方提供 fetchPage(page)：返回 { data, page, total, totalPages } 或抛错；
 * - 首次挂载自动加载（autoLoad=true 默认）；
 * - 切换筛选/搜索时调用 reload() 回到第 1 页（不清空旧内容，配合 loadingBar 保留观感）；
 * - goToPage(n) 换页，替换而非追加；refresh() 就地重取当前页；
 * - 服务端会把越界页码回落到末页，页码状态一律以响应里的 page 为准。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface PagedResult<T> {
  data: T[]
  /** 服务端实际返回的页码（可能因越界回落而与请求页不同） */
  page: number
  /** 命中筛选条件的总条数 */
  total: number
  /** 总页数，至少为 1 */
  totalPages: number
}

/**
 * 把接口响应映射成 fetchPage 需要的 PagedResult。
 *
 * 缺 `pagination` 时（旧后端或畸形 200 响应）一律按「单页、共 data.length 条」
 * 归一化：`page` 不沿用请求页，否则第 2 页会算出「第 21–20 条」这种自相矛盾的
 * 区间，页码条也会因 totalPages=1 直接消失。
 */
export function toPagedResult<T>(
  data: T[],
  pagination?: { page: number; total: number; totalPages: number },
): PagedResult<T> {
  return {
    data,
    page: pagination?.page ?? 1,
    total: pagination?.total ?? data.length,
    totalPages: pagination?.totalPages ?? 1,
  }
}

export interface UsePagedListOptions<T> {
  /** 拉取指定页（页码从 1 开始）。调用方负责 URL 参数与错误抛错。 */
  fetchPage: (page: number) => Promise<PagedResult<T>>
  /** 重新加载的依赖项（切 tab / 搜索词 / 用户变更等）。变化时回到第 1 页。 */
  deps: ReadonlyArray<unknown>
  /** 是否在挂载/依赖变化时自动加载（默认 true） */
  autoLoad?: boolean
  /** 初始是否处于加载中（避免首帧空态闪屏 FOUC，默认 true） */
  initialLoading?: boolean
}

export function usePagedList<T>({ fetchPage, deps, autoLoad = true, initialLoading = true }: UsePagedListOptions<T>) {
  const [items, setItems] = useState<T[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(initialLoading)
  const [error, setError] = useState('')
  /* 最近一次加载是否失败。与 error 分开记：error 是可写的展示通道，调用方会
     往里塞「版本冲突，已刷新」这类**刷新成功之后**才产生的提示，拿它当「数据
     是否可信」的判据会误锁。这个标志只由 load 自己维护。 */
  const [loadFailed, setLoadFailed] = useState(false)
  /* 屏幕上的数据是否已经不属于当前查询。切筛选/搜索后新查询的第一页失败时会是
     true：旧列表还留在屏幕上，它的 total/totalPages 描述的却是上一份数据。
     暴露给分页条置灰——否则用户点「第 2 页」，看到的页码区间对不上内容。 */
  const [stale, setStale] = useState(false)

  const fetchSeq = useRef(0)
  /* 「用户最后一次要求看的页」。在 load() 入口即写入，而不是等成功——
     翻页请求尚在途中时若发生 refresh()，读已成功页会把用户拽回上一页，
     并顺带取消他正在等的那一页。
     请求失败时回滚到 lastGoodPageRef：失败的那一页并没有显示出来，
     此后的 refresh() 应该刷新「屏幕上真正显示着的那一页」。 */
  const targetPageRef = useRef(1)
  const lastGoodPageRef = useRef(1)
  /* 始终指向**最新**的 fetchPage。
     调用页把 reload/refresh 捕获进了写操作的闭包（「操作成功后刷新列表」），
     那个闭包活得比它所属的那次渲染长得多：用户可以在请求在途时切到另一个
     筛选 tab。若 load 直接闭包捕获 fetchPage，旧回调发出的会是**旧筛选**的
     请求，而它又持有最新的 fetchSeq，结果新 tab 底下显示的是旧 tab 的数据。
     读 ref 就永远用当前筛选，同时也让 load / reload / refresh 保持稳定引用。 */
  const fetchPageRef = useRef(fetchPage)
  useEffect(() => {
    fetchPageRef.current = fetchPage
  })
  /* 组件是否仍挂载。卸载后 setState 在 React 19 里虽是空操作，但在途请求
     仍会跑完整个成功/失败分支；用它把后续写状态一并挡掉，语义上更干净。 */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
    /* 只放下挂载标记，**不**去自增 fetchSeq 作废在途请求。
       StrictMode 的开发期二次挂载会先跑一遍 cleanup：作废了 seq，首屏那次
       加载就再也走不到 setLoading(false)，而调用页的「只载一次」闩锁又已经
       合上，列表会永远停在骨架屏。mountedRef 已经足够挡住卸载后的 setState。 */
  }, [])

  const load = useCallback(async (target: number, opts?: { reset?: boolean }) => {
    /* 组件已经卸载：调用方持有的 reload/refresh 是稳定引用，写操作的回调
       完全可能在卸载之后才跑到「刷新列表」这一步。不在入口拦住的话，会白发
       一次列表请求，并对已卸载的组件调 setLoading/setStale。 */
    if (!mountedRef.current) return
    /* 显式 reset（切筛选、点搜索）意味着「屏幕上这批已经不属于当前查询」，
       在请求成功之前它一直是 stale —— 新查询的第一页若失败，旧列表还留着，
       此时的 total/totalPages 描述的是上一份数据，分页条必须置灰。 */
    if (opts?.reset) setStale(true)
    targetPageRef.current = target
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const result = await fetchPageRef.current(target)
      if (seq !== fetchSeq.current || !mountedRef.current) return // 过期响应或已卸载，丢弃
      setStale(false)
      setLoadFailed(false)
      setItems(result.data)
      // 服务端可能把越界页回落到末页，一律以回显的页码为准
      setPage(result.page)
      targetPageRef.current = result.page
      lastGoodPageRef.current = result.page
      setTotal(result.total)
      setTotalPages(result.totalPages)
    } catch (err) {
      if (seq === fetchSeq.current && mountedRef.current) {
        setLoadFailed(true)
        setError(err instanceof Error ? err.message : String(err))
        // 这一页没能显示出来，回滚意图页，后续 refresh 才会刷新当前可见页
        targetPageRef.current = lastGoodPageRef.current
      }
    } finally {
      if (seq === fetchSeq.current && mountedRef.current) setLoading(false)
    }
  }, [])

  /** 跳到指定页（页码从 1 开始）。 */
  const goToPage = useCallback(
    (target: number) => {
      if (loading) return
      if (target < 1 || target > totalPages || target === page) return
      void load(target)
    },
    [loading, page, totalPages, load],
  )

  /**
   * 重新拉取**当前页**，不回到第 1 页。
   *
   * 用于「本页发生了变更、但读者的位置不该被移走」的场景：审核、隐藏、封禁、
   * 删除本页某一项。用 reload() 会把人甩回第 1 页，若变更发生在第 2 页之后，
   * 改动后的内容反而看不见了。若删掉的正好是末页最后一条，服务端会把越界页
   * 回落到新的末页，因此直接重取当前页是安全的。
   *
   * 页码取自 targetPageRef 而非 state：调用方通常在一个 await 之后才执行
   * refresh()，期间用户可能已经翻页（甚至那一页还在路上），读 state 会拿到
   * 过时的页码，既把人拽回去、又取消了他正在等的那一页。
   */
  const refresh = useCallback(() => load(targetPageRef.current), [load])

  /** 重新从第 1 页开始（切筛选/搜索/手动刷新）。 */
  const reload = useCallback(() => load(1, { reset: true }), [load])

  useEffect(() => {
    if (!autoLoad) return
    // 拉取数据是 effect 对外部数据源的订阅；load 首行的 setLoading(true) 属该模式的同步 setState。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(1, { reset: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  /* 屏幕上这批条目已经不属于当前查询了——换了筛选/搜索词，而新查询的第一页
     又失败了，旧结果还留在那儿。调用页据此停止把它们当作当前条件的结果渲染。
     loading 期间不算：那是正常的切换过程，保留旧列表 + 加载条好过清空闪烁。 */
  const staleResults = stale && !loading

  return {
    items,
    page,
    total,
    totalPages,
    stale,
    staleResults,
    loadFailed,
    loading,
    error,
    setError,
    goToPage,
    reload,
    refresh,
    setItems,
  }
}
