import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { usePagedList, toPagedResult } from '@/hooks/usePagedList'
import { AdminButton, Alert, EmptyState, Pagination, SearchField, Skeleton } from '@/components/ui'
import { useFormatTs } from '@/utils/datetime'
import styles from './Story.module.css'

/** 即时搜索的防抖间隔：够短到跟手，够长到不会每敲一个字就发一次请求。 */
const SEARCH_DEBOUNCE_MS = 300

const PAGE_SIZE = 20

interface PublicContribution {
  id: string
  title: string
  summary: string | null
  tags: string[]
  language: string
  author: {
    displayName: string
    avatarUrl: string | null
  }
  publishedAt: number
  pinnedAt?: number | null
}

/** 头像回退：取显示名首字，无名时用间隔号占位（不留空圆）。 */
const initialOf = (name: string) => (name ?? '').trim().charAt(0) || '·'

export const Home = () => {
  const { t } = useTranslation()
  const { user } = useAuth()
  const navigate = useNavigate()
  const formatTs = useFormatTs()
  const [searchParams, setSearchParams] = useSearchParams()

  const searchTerm = searchParams.get('search') || ''
  const [searchInput, setSearchInput] = useState(searchTerm)

  // 按页浏览：搜索词变化回到第一页；hook 内置竞态守卫，丢弃过期响应（loading-08）。
  const { items, page, total, totalPages, stale, staleResults, loading, error, reload, goToPage } =
    usePagedList<PublicContribution>({
      fetchPage: async (targetPage) => {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(targetPage) })
        if (searchTerm) params.set('keyword', searchTerm)
        const result = await get<PublicContribution[]>(`/public/contributions?${params}`)
        if (!result.ok) throw new Error(result.error.message || t('home.errorLoad'))
        return toPagedResult(result.data, result.pagination)
      },
      deps: [searchTerm],
    })

  /* 置顶公告：独立端点一次性拉取，不参与游标分页（置顶稿也从默认信息流
     排除了，两边各管各的，不会重复）。拉取失败静默降级——置顶区是增强，
     不该挡住主信息流。 */
  const [pinned, setPinned] = useState<PublicContribution[]>([])
  useEffect(() => {
    let cancelled = false
    get<PublicContribution[]>('/public/contributions/pinned')
      .then((result) => {
        if (!cancelled && result.ok) setPinned(result.data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  /* 记录「最后一次由本页写进 URL 的搜索词」。
     回填 effect 必须能区分两种 searchTerm 变化：
       · 外部导航（前进/后退、外链带 ?search=）—— 应当回填输入框
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
      if ((live.get('search') || '') !== searchTerm) return

      lastPushedRef.current = next
      /* 在实时 URL 上改 search 这一个参数：整体重写会把外链带来的追踪参数、
         toast 提示等一并抹掉；从 updater 的旧快照上改则会把期间外部导航新增的
         参数丢掉。用 replace 写入，避免每敲一个字就往浏览历史里塞一条记录。 */
      setSearchParams(
        () => {
          const params = new URLSearchParams(window.location.search)
          if (next) params.set('search', next)
          else params.delete('search')
          return params
        },
        { replace: true },
      )
      if (!next) window.scrollTo({ top: 0 })
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
  }

  /* 置顶区与主信息流共用同一张卡片：结构只一份，置顶款在署名行前多一枚
     「置顶」徽标。 */
  const renderEntry = (item: PublicContribution, isPinned = false) => (
    <li key={item.id} className={styles.entry}>
      <Link to={`/contributions/${item.id}`} className={styles.entryLink}>
        <span className={styles.byline}>
          {isPinned && <span className={styles.pinBadge}>{t('home.pinnedBadge')}</span>}
          {item.author.avatarUrl ? (
            <img className={styles.avatar} src={item.author.avatarUrl} alt="" loading="lazy" />
          ) : (
            <span className={styles.avatarFallback} aria-hidden="true">
              {initialOf(item.author.displayName)}
            </span>
          )}
          <span className={styles.author}>{item.author.displayName}</span>
          <span className={styles.bylineSep} aria-hidden="true">
            ·
          </span>
          <span className={styles.metaText}>{formatTs(item.publishedAt)}</span>
          {/* 极窄屏下整体隐藏（含前导分隔点），见 Story.module.css 420px 断点 */}
          <span className={styles.bylineLang}>
            <span className={styles.bylineSep} aria-hidden="true">
              ·
            </span>
            {t('submit.languages.' + item.language, { defaultValue: item.language })}
          </span>

          {/* 标签贴元信息行右端，短条目因此少占一整行 */}
          {item.tags?.length > 0 && (
            <span className={styles.tags}>
              {item.tags.map((tag) => (
                <span key={tag} className={styles.tag}>
                  {tag}
                </span>
              ))}
            </span>
          )}
        </span>

        <span className={styles.entryTitle}>{item.title}</span>

        {item.summary && <span className={styles.entrySummary}>{item.summary}</span>}
      </Link>
    </li>
  )

  return (
    <div className={styles.page}>
      {/* 视觉上不画页面标题：顶栏已表明站点，紧跟着的搜索框和列表已表明
          这一页是什么，中间再插一行标题是纯粹的重复。但页面仍需要一个 h1
          供屏幕阅读器与「按标题跳转」定位，所以保留但只对辅助技术可见。
          文案取完整站名而非「故事」二字——读屏时它是这一页的名字，脱离
          视觉上下文单念一个词无法说明落在哪个站点。 */}
      <h1 className={styles.srOnly}>{t('home.title')}</h1>

      <div className={styles.toolbar}>
        <SearchField
          fieldClassName={styles.grow}
          value={searchInput}
          onValueChange={setSearchInput}
          onSearch={runSearch}
          onClear={clearSearch}
          placeholder={t('home.searchPlaceholder')}
          searchAriaLabel={t('home.searchLabel')}
          clearAriaLabel={t('home.clearSearch')}
        />
        {/* 动作并入搜索行右侧，省掉一整行只装两个按钮的报头 */}
        {user && (
          <div className={styles.toolbarActions}>
            <AdminButton variant="primary" onClick={() => navigate('/submit')}>
              {t('home.submitLink')}
            </AdminButton>
            <AdminButton variant="secondary" onClick={() => navigate('/me/contributions')}>
              {t('home.myContributions')}
            </AdminButton>
          </div>
        )}
        {/* 不回显关键词——输入框就在旁边，重复一遍是冗余的 */}
        {searchTerm && !staleResults && (
          <span className={styles.searchNote} role="status" aria-live="polite">
            {loading
              ? t('home.searchExpanding')
              : /* 总数由服务端 pagination.total 给出，不再是「当前这一页的条数」 */
                t('home.searchResultCount', { count: total })}
          </span>
        )}
      </div>

      {/* 必须给一个重试入口：换关键词后首页请求失败时，游标已作废、分页条被置灰，
          而首页是即时搜索——再按一次回车会因为关键词没变而直接返回，用户会卡死在
          这个错误上，只能改关键词再改回来或者刷新整页。 */}
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

      {/* 置顶公告区：仅默认信息流的第一页展示——搜索时让位给结果，
          翻页后不重复占位。置顶稿已从主信息流排除，这里不会出现重复条目。 */}
      {!searchTerm && page === 1 && pinned.length > 0 && (
        <section className={styles.pinnedSection} aria-label={t('home.pinnedSection')}>
          <h2 className={styles.srOnly}>{t('home.pinnedSection')}</h2>
          <ul className={styles.feed}>{pinned.map((item) => renderEntry(item, true))}</ul>
        </section>
      )}

      {loading && items.length === 0 ? (
        <Skeleton variant="feed" rows={5} />
      ) : staleResults ? null : items.length === 0 ? (
        <EmptyState title={searchTerm ? t('home.noMatches') : t('home.empty')} />
      ) : (
        <>
          {/* 已有内容时刷新/搜索：保留旧列表，顶部显示轻量加载条，避免清空闪烁或旧数据被误读 */}
          {loading && (
            <div className={styles.loadingBar} role="status" aria-live="polite">
              {t('home.loading')}
            </div>
          )}
          <ul className={styles.feed}>
            {items.map((item) => renderEntry(item))}
          </ul>
        </>
      )}

      {/* 分页留在空态判断之外：翻到后续页时若该页恰好为空
          （并发删除、状态变更、游标过期），读者仍需要能退回上一页。
          控件本身在只有一页时会自行隐藏。 */}
      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={PAGE_SIZE}
        disabled={loading || stale}
        onChange={goToPage}
      />
    </div>
  )
}
