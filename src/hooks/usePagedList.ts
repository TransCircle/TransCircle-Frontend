/**
 * usePagedList —— 统一的页码分页列表 hook。
 *
 * 收敛各列表页（Home / MyContributions / Admin / AdminUsers / AdminAuditLogs /
 * AdminEditRequests / AdminComments / CommentSection）重复的拉取样板：fetchSeq
 * 竞态守卫、loading/error 状态、切页替换列表、总数/总页数回填。
 *
 * 接口侧是 offset 分页（apidocs.md §通用约定「分页」）：请求带 `page` + `limit`，
 * 响应回 `{ limit, page, total, totalPages, hasMore }`。因此这里能直接跳到任意
 * 一页并显示总页数 —— 这正是它取代旧 useCursorList（「加载更多」，只能一路往下
 * 追加、给不出总数）的原因。
 *
 * 设计约束：
 * - 由调用方提供 fetchPage(page)：返回 { data, page, total, totalPages } 或抛错；
 * - 首次挂载自动加载（autoLoad=true 默认）；
 * - 切换筛选/搜索时调用 reload() 回到第 1 页（不清空旧内容，配合 loadingBar 保留观感）；
 * - goToPage(n) 换页，替换而非追加；
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
  const fetchSeq = useRef(0)

  // fetchPage 取「最新一次渲染」的那份，而不是调用方闭包里捕获的：隐藏评论这类
  // 异步操作返回时可能已经切了 tab，若 refresh() 沿用旧闭包，就会按旧筛选条件再发
  // 一次请求，且因为序号更大反而覆盖掉新 tab 的数据。
  const fetchPageRef = useRef(fetchPage)
  useEffect(() => {
    fetchPageRef.current = fetchPage
  })

  // 「当前想要的页」——在 load 入口同步写入，而不是等 page state 落定。
  // 已提交的 page 会滞后：在第 5 页切筛选时 load(1) 已在飞，page 仍是 5；此时
  // refresh() 若读 page 就会去请求新筛选的第 5 页，把回第 1 页的请求挤掉。
  const targetPageRef = useRef(1)

  const load = useCallback(async (target: number) => {
    targetPageRef.current = target
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const result = await fetchPageRef.current(target)
      if (seq !== fetchSeq.current) return // 过期响应，丢弃
      setItems(result.data)
      setPage(result.page)
      // 服务端可能把越界页回落到末页，以回显的页码为准
      targetPageRef.current = result.page
      setTotal(result.total)
      setTotalPages(result.totalPages)
    } catch (err) {
      // 换页失败：保留当前页内容与页码，仅提示错误
      if (seq === fetchSeq.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }, [])

  /** 跳到指定页（页码从 1 开始）。 */
  const goToPage = useCallback(
    (target: number) => {
      if (loading || target === page || target < 1) return
      void load(target)
    },
    [loading, page, load],
  )

  /** 首载 / 切筛选 / 搜索：回到第 1 页并替换列表 */
  const reload = useCallback(() => load(1), [load])

  /**
   * 就地刷新当前页（审核、隐藏、删除等改动之后用）。
   *
   * 不能用 reload()：那会把停在第 5 页的人弹回第 1 页。若删掉的正好是末页最后
   * 一条，服务端会把越界页回落到新的末页，所以这里直接重取当前页是安全的。
   * 取 targetPageRef 而非 page：有请求在飞时，要刷的是「正在去的那一页」。
   */
  const refresh = useCallback(() => load(targetPageRef.current), [load])

  // 依赖变化时自动重载（切 tab / 搜索 / 用户变更）
  useEffect(() => {
    if (!autoLoad) return
    // fetch 数据是 effect 对外部数据源的订阅；load 首行 setLoading(true) 属该模式的同步 setState，
    // 与 React 文档「effect 中订阅外部数据」一致，通过禁用规则抑制（与原列表页实现同款）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return {
    items,
    page,
    total,
    totalPages,
    loading,
    error,
    setError,
    goToPage,
    reload,
    refresh,
    setItems,
  }
}
