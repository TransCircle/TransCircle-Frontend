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
  /* 最近一次加载是否失败。与 error 分开记：error 是可写的展示通道，调用方会
     往里塞「版本冲突，已刷新」这类**刷新成功之后**才产生的提示，拿它当「数据
     是否可信」的判据会误锁。这个标志只由 load 自己维护。 */
  const [loadFailed, setLoadFailed] = useState(false)
  /* 屏幕上的数据是否已经不属于当前查询。切筛选/搜索后新查询的第一页失败时会是
     true：旧列表还留在屏幕上，但它的游标已经作废，任何翻页都只能从第一页重来。
     暴露给分页条置灰——否则用户点「第 2 页」，实际加载的是第 1 页。 */
  const [stale, setStale] = useState(false)

  /** cursorsRef[i] = 取第 i 页所需的游标；第 0 页恒为 null。 */
  const cursorsRef = useRef<(string | null)[]>([null])
  const fetchSeq = useRef(0)
  /* 「用户最后一次要求看的页」。在 load() 入口即写入，而不是等成功——
     翻页请求尚在途中时若发生 refresh()，读已成功页会把用户拽回上一页，
     并顺带取消他正在等的那一页。
     请求失败时回滚到 lastGoodPageRef：失败的那一页并没有显示出来，
     此后的 refresh() 应该刷新「屏幕上真正显示着的那一页」。 */
  const targetPageRef = useRef(0)
  const lastGoodPageRef = useRef(0)
  /* 数据集代号。deps 变化即换了一份数据（搜索词变了、筛选 tab 变了），
     此前缓存的游标属于上一份数据，绝不能拿来取这一份的第 N 页——
     那会把「关键词 B + A 的游标」发给后端。dataGenRef 每次 deps 变化时自增，
     cursorsGenRef 只在新数据集的第一页取回成功后才追上它；两者不等
     即表示「屏幕上还是旧数据、新数据的第一页尚未到手」，此时任何取数
     都只能从第一页重新开始。 */
  const dataGenRef = useRef(0)
  const cursorsGenRef = useRef(0)
  /* 已经确认的末页序号（那一页返回了 nextCursor=null），未确认时为 null。
     记序号而不是布尔：hasMore 只反映**这一次响应**，回看第 1 页时它必然又是
     true，若直接照搬，分页条会在已经数清「共 3 页」之后又冒出一个「后面还有、
     总数未知」的省略号。
     两种情况下这个结论作废：游标链分叉（数据被别人改过，见下方 diverged），
     以及重新取到那一页时它这次给出了 nextCursor——说明末页之后又长出了新数据。 */
  const endPageRef = useRef<number | null>(null)
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
     仍会跑完整个成功/失败分支；用它把 seq 一并作废，语义上更干净。 */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
    /* 只放下挂载标记，**不**去自增 fetchSeq 作废在途请求。
       StrictMode 的开发期二次挂载会先跑一遍 cleanup：作废了 seq，首屏那次
       加载就再也走不到 setLoading(false)，而调用页的「只载一次」闩锁又已经
       合上，列表会永远停在骨架屏。mountedRef 已经足够挡住卸载后的 setState，
       在途请求跑完即可，本来也没有别的副作用。 */
  }, [])

  const load = useCallback(
    async (index: number, opts?: { reset?: boolean; truncate?: boolean }) => {
      /* 显式 reset（切筛选、点搜索、变更后重载）意味着「从这一刻起，缓存的游标
         描述的是上一份数据」——代号必须**立即**自增，不能等请求成功。
         autoLoad:false 的页面（AdminUsers / AdminAuditLogs）靠 reload() 换筛选，
         走不到下面那个 deps effect；只在成功时同步的话，新筛选的第一页一旦失败，
         旧游标依旧可用，下一次翻页就会发出「新筛选 + 旧游标」。 */
      const explicitReset = opts?.reset ?? false
      if (explicitReset) {
        dataGenRef.current += 1
        setStale(true)
      }
      /* 组件已经卸载：调用方持有的 reload/refresh 是稳定引用，写操作的回调
         完全可能在卸载之后才跑到「刷新列表」这一步。不在入口拦住的话，会白发
         一次列表请求，并对已卸载的组件调 setLoading/setStale。 */
      if (!mountedRef.current) return
      // 游标缓存属于上一份数据时，只能重新从第一页开始
      const stale = cursorsGenRef.current !== dataGenRef.current
      const reset = explicitReset || stale
      const target = reset ? 0 : index
      targetPageRef.current = target
      const cursor = reset ? null : (cursorsRef.current[target] ?? null)
      const gen = dataGenRef.current
      const seq = ++fetchSeq.current
      setLoading(true)
      setError('')
      try {
        const page = await fetchPageRef.current(cursor)
        if (seq !== fetchSeq.current || !mountedRef.current) return // 过期响应或已卸载，丢弃
        /* 重置只在成功后提交：若在请求前就清空游标与页码，而这一页又失败了，
           屏幕上留着的仍是旧页数据，分页状态却已宣称「只有第 1 页」——两者
           描述的不是同一份数据，分页条还会因此消失，读者退无可退。
           改为成功后提交，失败时一切保持原样，配合错误提示可原地重试。 */
        if (reset) {
          cursorsRef.current = [null]
          cursorsGenRef.current = gen
          endPageRef.current = null
          setKnownPages(1)
        }
        setStale(false)
        setLoadFailed(false)
        setItems(page.data)
        setPageIndex(target)
        lastGoodPageRef.current = target
        /* 已经确认过末页的话，本次响应的 hasMore 不作数（见 endPageRef）。
           但若重新取到的正是那一页（或更靠后），而它这次给出了 nextCursor，
           说明末页之后又长出了新数据，结论作废。 */
        if (page.nextCursor && endPageRef.current !== null && target >= endPageRef.current) {
          endPageRef.current = null
        }
        setHasMore(endPageRef.current !== null ? false : page.hasMore)
        if (page.nextCursor) {
          /* 这一页的下一页游标变了，说明本页的边界移动过（别人插入/删除了内容）。
             游标分页里更深的游标都是从前一页的边界推出来的，边界一动它们就对不上，
             必须连同页数一起截掉，让用户重新走一遍。
             只在**确实分叉**时截断：正常来回翻页时游标不变，已经走过的页码要留着，
             否则每退一页页码列表就缩一截，看起来像列表凭空变短了。 */
          const prevNext = cursorsRef.current[target + 1]
          const diverged = prevNext !== undefined && prevNext !== page.nextCursor
          cursorsRef.current[target + 1] = page.nextCursor
          if (opts?.truncate || diverged) {
            cursorsRef.current.length = target + 2
            // 链子变了，之前数出来的末页结论作废
            endPageRef.current = null
            setHasMore(page.hasMore)
            setKnownPages(target + 2)
          } else {
            setKnownPages((prev) => Math.max(prev, target + 2))
          }
        } else {
          // 到底了：把已知页数收敛到当前页，避免残留一个点不动的页码
          cursorsRef.current.length = target + 1
          endPageRef.current = target
          setKnownPages(target + 1)
        }
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
    },
    // fetchPage 通过 ref 读取，因此这里没有依赖——load 是稳定引用
    [],
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

  /**
   * 重新拉取**当前页**，不重置游标与页码。
   *
   * 用于「本页发生了变更、但读者的位置不该被移走」的场景：删除本页某一项、
   * 或在本页的父项下追加内容。用 reload() 会把人甩回第一页，若变更发生在
   * 第 2 页之后，改动后的内容反而看不见了。
   *
   * 页码取自 targetPageRef 而非 state：调用方通常在一个 await 之后才执行
   * refresh()，期间用户可能已经翻页（甚至那一页还在路上），读 state 会拿到
   * 过时的页码，既把人拽回去、又取消了他正在等的那一页。
   */
  const refresh = useCallback(() => load(targetPageRef.current, { truncate: true }), [load])

  /** 重新从第一页开始（切筛选/搜索/手动刷新）。游标与页码在成功后才重置。 */
  const reload = useCallback(() => load(0, { reset: true }), [load])

  useEffect(() => {
    if (!autoLoad) return
    // reset:true 会在 load 内部自增 dataGenRef，旧游标就此作废（见其注释）
    // 拉取数据是 effect 对外部数据源的订阅；load 首行的 setLoading(true) 属该模式的同步 setState。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(0, { reset: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  /* 屏幕上这批条目已经不属于当前查询了——换了筛选/搜索词，而新查询的第一页
     又失败了，旧结果还留在那儿。调用页据此停止把它们当作当前条件的结果渲染。
     loading 期间不算：那是正常的切换过程，保留旧列表 + 加载条好过清空闪烁。 */
  const staleResults = stale && !loading

  return {
    items,
    pageIndex,
    knownPages,
    hasMore,
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
