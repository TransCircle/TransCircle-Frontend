import { useState, useEffect } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { usePagedList } from '@/hooks/usePagedList'
import { AdminButton, Alert, EmptyState, Pagination, SearchField, Skeleton } from '@/components/ui'
import { useFormatTs } from '@/utils/datetime'
import styles from './Story.module.css'

/** 即时搜索的防抖间隔：够短到跟手，够长到不会每敲一个字就发一次请求。 */
const SEARCH_DEBOUNCE_MS = 300

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
  const { items, pageIndex, knownPages, hasMore, loading, error, goToPage } =
    usePagedList<PublicContribution>({
      fetchPage: async (cursorVal) => {
        const params = new URLSearchParams({ limit: '20' })
        if (cursorVal) params.set('cursor', cursorVal)
        if (searchTerm) params.set('keyword', searchTerm)
        const result = await get<PublicContribution[]>(`/public/contributions?${params}`)
        if (!result.ok) throw new Error(result.error.message || t('home.errorLoad'))
        return {
          data: result.data,
          nextCursor: result.pagination?.nextCursor ?? null,
          hasMore: result.pagination?.hasMore ?? false,
        }
      },
      deps: [searchTerm],
    })

  // 同步搜索输入框到 URL 搜索词（外部导航带 ?search=x 时回填输入框）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearchInput(searchTerm)
  }, [searchTerm])

  // 即时搜索：输入停顿后自动写回 URL 搜索词（进而触发重载），不必按回车。
  // 用 replace 写入，避免每敲一个字就往浏览历史里塞一条记录。
  useEffect(() => {
    const next = searchInput.trim()
    if (next === searchTerm) return
    const timer = setTimeout(() => {
      setSearchParams(next ? { search: next } : {}, { replace: true })
      if (!next) window.scrollTo({ top: 0 })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, searchTerm, setSearchParams])

  // 回车即刻生效，不等防抖
  const runSearch = () => {
    const q = searchInput.trim()
    if (q === searchTerm) return
    setSearchParams(q ? { search: q } : {}, { replace: true })
    if (!q) window.scrollTo({ top: 0 })
  }

  const clearSearch = () => {
    setSearchInput('')
    setSearchParams({}, { replace: true })
    window.scrollTo({ top: 0 })
  }

  // 翻页后回到列表顶部，否则读者会停在上一页的滚动位置
  const handlePageChange = (index: number) => {
    goToPage(index)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

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
        {searchTerm && (
          <span className={styles.searchNote} role="status" aria-live="polite">
            {loading ? t('home.searchExpanding') : t('home.searchResultCount', { count: items.length })}
          </span>
        )}
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {loading && items.length === 0 ? (
        <Skeleton variant="feed" rows={5} />
      ) : items.length === 0 ? (
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
            {items.map((item) => (
              <li key={item.id} className={styles.entry}>
                <Link to={`/contributions/${item.id}`} className={styles.entryLink}>
                  <span className={styles.byline}>
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
            ))}
          </ul>
          <Pagination
            pageIndex={pageIndex}
            knownPages={knownPages}
            hasMore={hasMore}
            disabled={loading}
            onChange={handlePageChange}
          />
        </>
      )}
    </div>
  )
}
