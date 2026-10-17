import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { usePagedList, toPagedResult } from '@/hooks/usePagedList'
import { AdminButton, Alert, EmptyState, Pagination, SearchField, Skeleton } from '@/components/ui'
import { useReveal } from '@/hooks/useReveal'
import { StoryCard, type PublicContribution } from './StoryCard'
import styles from './Story.module.css'

/** 即时搜索的防抖间隔：够短到跟手，够长到不会每敲一个字就发一次请求。 */
const SEARCH_DEBOUNCE_MS = 300

const PAGE_SIZE = 20

const NoMatchIcon = () => (
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
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
    <path d="M8.5 11h5" />
  </svg>
)

/**
 * 搜索页（/search?q=关键词）：在已发布的故事里按标题、摘要与标签查找。
 * 从顶栏进入时直接聚焦输入框；输入停顿后即时搜索，关键词写进 URL（replace），
 * 结果页可以分享、刷新，前进 / 后退会回填输入框。
 */
export const Search = () => {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()

  const searchTerm = searchParams.get('q') || ''
  const [searchInput, setSearchInput] = useState(searchTerm)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 当前关键词的请求是否已经发出：发出时写入关键词（见 fetchPage），关键词一变就清回 null（见下方 busy）。 */
  const [startedTerm, setStartedTerm] = useState<string | null>(null)
  /* 关键词变化（包括清空后重输同一个词）时，在渲染阶段把「已发出」清回未开始——
     React 推荐的「随前值调整状态」写法，不需要额外的 effect，也不会先提交一帧旧状态。 */
  const [termSeen, setTermSeen] = useState(searchTerm)
  if (termSeen !== searchTerm) {
    setTermSeen(searchTerm)
    setStartedTerm(null)
  }

  // 没有关键词时不请求：页面只显示输入框与说明。hook 内置竞态守卫，丢弃过期响应。
  const { items, page, total, totalPages, stale, staleResults, loading, error, reload, goToPage } =
    usePagedList<PublicContribution>({
      fetchPage: async (targetPage) => {
        setStartedTerm(searchTerm)
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(targetPage), keyword: searchTerm })
        const result = await get<PublicContribution[]>(`/public/contributions?${params}`)
        if (!result.ok) throw new Error(result.error.message || t('search.errorLoad'))
        return toPagedResult(result.data, result.pagination)
      },
      deps: [searchTerm],
      autoLoad: searchTerm !== '',
      initialLoading: searchTerm !== '',
    })

  /* 进入搜索页就是为了输入：聚焦输入框。RootLayout 换页时会把焦点移入 <main>，
     而父级 effect 晚于本页执行——下一帧再聚焦，同设置页 ?tab= 定位的做法。 */
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(raf)
  }, [])

  /* 记录「最后一次由本页写进 URL 的搜索词」。
     回填 effect 必须能区分两种 searchTerm 变化：
       · 外部导航（前进/后退、外链带 ?q=）—— 应当回填输入框
       · 本页防抖刚写进去的 —— 不应回填
     若不加区分地回填，会出现这样的时序：防抖落地 → searchTerm 变化 →
     回填 effect 触发，而用户在这个间隙又敲了一个字，那次回填就会把它吃掉。 */
  const lastPushedRef = useRef(searchTerm)

  const pushSearch = useCallback(
    (next: string) => {
      /* 必须读 window.location.search 而不是 setSearchParams 的 updater 参数：
         react-router 的 updater 收到的是**这次渲染**捕获的 searchParams（v7 里是
         `nextInit(new URLSearchParams(searchParams))`），拿它跟同一次渲染的
         searchTerm 比较恒等，什么也判不出来。浏览器的 location 才是实时的——
         前进/后退在 popstate 时就已经改好了 URL，早于 React 重新渲染。 */
      const live = new URLSearchParams(window.location.search)
      if ((live.get('q') || '') !== searchTerm) return

      lastPushedRef.current = next
      /* 在实时 URL 上改 q 这一个参数：整体重写会把外链带来的追踪参数、
         toast 提示等一并抹掉；从 updater 的旧快照上改则会把期间外部导航新增的
         参数丢掉。用 replace 写入，避免每敲一个字就往浏览历史里塞一条记录。 */
      setSearchParams(
        () => {
          const params = new URLSearchParams(window.location.search)
          if (next) params.set('q', next)
          else params.delete('q')
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams, searchTerm],
  )

  // 仅在外部导航改变搜索词时回填输入框
  useEffect(() => {
    if (searchTerm === lastPushedRef.current) return
    lastPushedRef.current = searchTerm
    setSearchInput(searchTerm)
  }, [searchTerm])

  // 即时搜索：输入停顿后自动生效，不必按回车
  useEffect(() => {
    const next = searchInput.trim()
    if (next === searchTerm) return
    const timer = setTimeout(() => pushSearch(next), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, searchTerm, pushSearch])

  // 回车即刻生效，不等防抖
  const runSearch = () => {
    const q = searchInput.trim()
    if (q === searchTerm) return
    pushSearch(q)
  }

  const clearSearch = () => {
    setSearchInput('')
    pushSearch('')
    inputRef.current?.focus()
  }

  /* 滚动 reveal（§6.4）。依赖列表里带上数据，翻页 / 换关键词后新渲染的卡片
     也要被重新收集观察，否则它们会永远停在 opacity:0。 */
  const revealRef = useReveal<HTMLDivElement>([items, loading, error, searchTerm])

  /* 关键词刚变、分页 hook 的 effect 还没发出请求的那一次提交：hook 的 loading 仍是 false，
     列表还是上一个关键词的（或者是空的），直接渲染会闪出「找到 0 条 / 没有找到」，
     读屏也会收到这条错误的播报。请求发出之前一律按加载中处理。 */
  const busy = loading || (searchTerm !== '' && startedTerm !== searchTerm)

  /* 输入框下方的一行状态：没有关键词时是用法说明，有关键词时是结果数。
     结果已不属于当前关键词（新查询失败）时留空，避免把旧数量当成新结果。 */
  const note = !searchTerm
    ? t('search.help')
    : staleResults
      ? ''
      : busy
        ? t('search.searching')
        : t('search.resultCount', { count: total })

  return (
    <div className={styles.page} ref={revealRef}>
      <header className={`${styles.pageHead} ${styles.searchHead}`}>
        <h1 className={styles.pageTitle}>{t('search.title')}</h1>
        <div className={styles.searchBox}>
          <SearchField
            ref={inputRef}
            value={searchInput}
            onValueChange={setSearchInput}
            onSearch={runSearch}
            onClear={clearSearch}
            placeholder={t('search.placeholder')}
            searchAriaLabel={t('search.label')}
            clearAriaLabel={t('search.clear')}
          />
        </div>
        <p className={styles.searchNote} role="status" aria-live="polite">
          {note}
        </p>
      </header>

      {searchTerm && (
        <section className={styles.section} aria-labelledby="search-results-heading">
          <h2 id="search-results-heading" className={styles.sectionLabel}>
            {t('search.resultsHeading')}
          </h2>

          {/* 必须给一个重试入口：搜索是即时的，关键词没变时再按回车会直接返回，
              用户会卡在这个错误上，只能改关键词再改回来或者刷新整页。 */}
          {error && (
            <Alert tone="error">
              <span className={styles.errorRow}>
                {error}
                <AdminButton variant="secondary" size="sm" onClick={() => void reload()} disabled={busy}>
                  {t('common.retry')}
                </AdminButton>
              </span>
            </Alert>
          )}

          {busy && items.length === 0 ? (
            <Skeleton variant="feed" rows={6} />
          ) : staleResults ? null : items.length === 0 ? (
            <EmptyState
              title={t('search.noMatches')}
              description={t('search.noMatchesDescription')}
              icon={<NoMatchIcon />}
              headingLevel="h3"
              action={
                <AdminButton variant="secondary" onClick={clearSearch}>
                  {t('search.clearAction')}
                </AdminButton>
              }
            />
          ) : (
            <>
              {/* 已有结果时换关键词 / 翻页：保留旧列表，顶部显示轻量加载条，避免清空闪烁。
                  读屏由输入框下方的状态行播报「正在搜索」，这里只做视觉提示，不重复播报。 */}
              {busy && (
                <div className={styles.loadingBar} aria-hidden="true">
                  {t('search.loading')}
                </div>
              )}
              <ul className={styles.feed}>
                {items.map((item, i) => (
                  <StoryCard key={item.id} item={item} index={i} />
                ))}
              </ul>
            </>
          )}

          {/* 分页留在空态判断之外：翻到后续页时若该页恰好为空，读者仍需要能退回上一页。 */}
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            pageSize={PAGE_SIZE}
            disabled={busy || stale}
            onChange={goToPage}
          />
        </section>
      )}
    </div>
  )
}
