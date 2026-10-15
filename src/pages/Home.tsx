import { useState, useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { usePagedList, toPagedResult } from '@/hooks/usePagedList'
import { AdminButton, Alert, ButtonLink, EmptyState, Pagination, Skeleton } from '@/components/ui'
import { useReveal } from '@/hooks/useReveal'
import { StoryCard, type PublicContribution } from './StoryCard'
import styles from './Story.module.css'

/** 置顶请求的等待上限：第一页要等置顶与信息流都到了再一起渲染（置顶卡排在最前，
 *  后到会把整排卡片往后挤）；客户端没有通用超时，超过这个时间就当作没有置顶。 */
const PINNED_TIMEOUT_MS = 4000

const PAGE_SIZE = 20

const ArchiveIcon = () => (
  <svg
    width="48"
    height="48"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 5.5h16v14H4z" />
    <path d="M7 5.5V3.75h10V5.5" />
    <path d="M8 10h8" />
    <path d="M8 14h5" />
  </svg>
)

/**
 * 首页入口。搜索已移到独立的 /search 页：旧版首页的搜索链接（`/?search=关键词`）
 * 可能已经被分享出去，这里原样改道到 `/search?q=关键词`，其余参数与 hash 保留。
 */
export const Home = () => {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const legacyQuery = params.get('search')
  if (legacyQuery !== null) {
    params.delete('search')
    if (legacyQuery.trim()) params.set('q', legacyQuery.trim())
    const qs = params.toString()
    return <Navigate to={`/search${qs ? `?${qs}` : ''}${location.hash}`} replace />
  }
  return <HomeFeed />
}

const HomeFeed = () => {
  const { t } = useTranslation()
  const { user } = useAuth()

  // 按页浏览最新故事；hook 内置竞态守卫，丢弃过期响应（loading-08）。
  const { items, page, total, totalPages, stale, staleResults, loadFailed, loading, error, reload, goToPage } =
    usePagedList<PublicContribution>({
      fetchPage: async (targetPage) => {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(targetPage) })
        const result = await get<PublicContribution[]>(`/public/contributions?${params}`)
        if (!result.ok) throw new Error(result.error.message || t('home.errorLoad'))
        return toPagedResult(result.data, result.pagination)
      },
      deps: [],
    })

  /* 置顶稿：独立端点一次性拉取（置顶稿已从默认信息流排除，两边不会重复），
     在第一页作为普通故事卡排在最前、带「置顶」标记。置顶不一定是公告，也可能是想让更多人
     读到的故事，所以不另开分区。拉取失败或超时静默降级为「没有置顶」，不挡主信息流。 */
  const [pinned, setPinned] = useState<PublicContribution[]>([])
  const [pinnedLoading, setPinnedLoading] = useState(true)
  useEffect(() => {
    /* settled：这次置顶请求已有定论（返回、超时或卸载），之后到达的结果一律作废。
       超时必须在这里直接结束等待：abort 只能中断 fetch 本身，401 时客户端会先等一次
       共享的 token 刷新（不受本 signal 控制，自身上限 10s），光靠 abort 首页会被拖住。
       超时后作废结果也保证了置顶卡不会在故事卡渲染之后才插到最前面。 */
    let settled = false
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      controller.abort()
      setPinnedLoading(false)
    }, PINNED_TIMEOUT_MS)
    get<PublicContribution[]>('/public/contributions/pinned', { signal: controller.signal })
      .then((result) => {
        if (!settled && result.ok) setPinned(result.data)
      })
      .catch(() => {})
      .finally(() => {
        window.clearTimeout(timer)
        if (settled) return
        settled = true
        setPinnedLoading(false)
      })
    return () => {
      settled = true
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [])

  /* 滚动 reveal（§6.4）。依赖列表里带上数据，翻页后新渲染的卡片
     也要被重新收集观察，否则它们会永远停在 opacity:0。 */
  const revealRef = useReveal<HTMLDivElement>([items, pinned, loading, error, pinnedLoading])

  /* 置顶稿只在第一页出现（翻页后不重复）。
     第一页等置顶请求结束（最多 PINNED_TIMEOUT_MS）再出卡片，置顶卡不会后到插队。 */
  const showPinned = page === 1
  const pinnedShown = showPinned ? pinned : []
  const pinnedIds = new Set(pinnedShown.map((p) => p.id))
  /* staleResults：屏幕上的普通故事已不属于当前这次加载（加载失败），只排除它们——
     已取得的置顶稿与信息流是两个请求，不该被另一个请求的失败连带隐藏。
     防御：后端已把置顶稿从信息流排除；万一重复，以置顶那份为准，避免同 key 的两张卡。 */
  const currentItems = staleResults ? [] : items.filter((i) => !pinnedIds.has(i.id))
  const entries = [...pinnedShown, ...currentItems]
  const waitingForPinned = showPinned && pinnedLoading
  /* 骨架只用于「还没有任何可读内容」：首轮加载（信息流尚无结论时与置顶一起等）、
     或当前确实一条都没有。信息流失败后重试时，已显示的置顶卡保留，改用顶部加载条。 */
  const showSkeleton = waitingForPinned || (loading && (entries.length === 0 || (items.length === 0 && !loadFailed)))

  const submitTarget = user ? '/submit' : '/auth/login?redirect=%2Fsubmit'

  return (
    <div className={styles.page} ref={revealRef}>
      {/* 首页页头：站点的自我介绍，安静而清楚——灰色小字定位、中等字号的标语、一句导语。
          不放粉色按钮（投稿入口在顶栏），不加分隔线；搜索在顶栏的独立搜索页。
          身份的另一半在顶栏站名上，每一页都有，这里不必放大音量。 */}
      <header className={styles.pageHead}>
        <p className={styles.pageKicker}>{t('home.eyebrow')}</p>
        <h1 className={styles.pageTitle}>{t('home.heroTitle')}</h1>
        <p className={styles.pageLede}>{t('home.heroLede')}</p>
      </header>

      <section className={styles.section} aria-labelledby="home-feed-heading">
        <h2 id="home-feed-heading" className={styles.sectionLabel}>
          {t('home.latestHeading')}
        </h2>

        {/* 必须给一个重试入口：首页请求失败后分页条被置灰，没有其他办法重新加载。 */}
        {error && (
          <Alert tone="error">
            <span className={styles.errorRow}>
              {error}
              <AdminButton variant="secondary" size="sm" onClick={() => void reload()} disabled={loading}>
                {t('common.retry')}
              </AdminButton>
            </span>
          </Alert>
        )}

        {showSkeleton ? (
          <Skeleton variant="feed" rows={6} />
        ) : entries.length === 0 ? (
          /* 加载失败且没有可展示的条目：只留上方的错误提示与重试，不显示「暂无」空态。 */
          staleResults ? null : (
            <EmptyState
              title={t('home.empty')}
              description={t('home.emptyDescription')}
              icon={<ArchiveIcon />}
              headingLevel="h3"
              action={
                <ButtonLink variant="primary" to={submitTarget}>
                  {user ? t('home.submitLink') : t('home.submitLoginLink')}
                </ButtonLink>
              }
            />
          )
        ) : (
          <>
            {/* 已有内容时刷新 / 翻页：保留旧列表，顶部显示轻量加载条，避免清空闪烁或旧数据被误读 */}
            {loading && (
              <div className={styles.loadingBar} role="status" aria-live="polite">
                {t('home.loading')}
              </div>
            )}
            <ul className={styles.feed}>
              {entries.map((item, i) => (
                <StoryCard key={item.id} item={item} index={i} pinned={pinnedIds.has(item.id)} />
              ))}
            </ul>
          </>
        )}

        {/* 分页留在空态判断之外：翻到后续页时若该页恰好为空
            （并发删除、状态变更），读者仍需要能退回上一页。
            控件本身在只有一页时会自行隐藏。 */}
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={PAGE_SIZE}
          disabled={loading || stale}
          onChange={goToPage}
        />
      </section>
    </div>
  )
}
