import { useState, useEffect } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { useCursorList } from '@/hooks/useCursorList'
import { AdminButton, Alert, EmptyState, PageHeader, Pill, SearchField, Skeleton } from '@/components/ui'
import { useFormatTs } from '@/utils/datetime'
import shell from './Page.module.css'

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

const ChevronIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
)

export const Home = () => {
  const { t } = useTranslation()
  const { user } = useAuth()
  const navigate = useNavigate()
  const formatTs = useFormatTs()
  const [searchParams, setSearchParams] = useSearchParams()

  const searchTerm = searchParams.get('search') || ''
  const [searchInput, setSearchInput] = useState(searchTerm)

  // 游标分页列表（统一模板）：搜索词（URL search 参数）变化自动重载；
  // hook 内置 fetchSeq 竞态守卫，丢弃过期响应（loading-08）。
  const { items, cursor, loading, error, loadMore } = useCursorList<PublicContribution>({
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

  const runSearch = () => {
    const q = searchInput.trim()
    setSearchParams(q ? { search: q } : {})
    if (!q) window.scrollTo({ top: 0 })
  }

  const clearSearch = () => {
    setSearchInput('')
    setSearchParams({})
    window.scrollTo({ top: 0 })
  }

  return (
    <div className={shell.page}>
      <div className={shell.head}>
        <PageHeader
          title={t('home.title')}
          description={t('home.subtitle')}
          actions={
            user ? (
              <>
                <AdminButton variant="primary" onClick={() => navigate('/submit')}>
                  {t('home.submitLink')}
                </AdminButton>
                <AdminButton variant="secondary" onClick={() => navigate('/me/contributions')}>
                  {t('home.myContributions')}
                </AdminButton>
              </>
            ) : undefined
          }
        />
        <div className={shell.toolbar}>
          <SearchField
            fieldClassName={shell.grow}
            value={searchInput}
            onValueChange={setSearchInput}
            onSearch={runSearch}
            onClear={clearSearch}
            placeholder={t('home.searchPlaceholder')}
            searchAriaLabel={t('home.searchLabel')}
            clearAriaLabel={t('home.clearSearch')}
          />
          {searchTerm && (
            <span className={shell.count}>
              {loading
                ? t('home.searchExpanding')
                : t('home.localSearchHint', { count: items.length, keyword: searchTerm })}
            </span>
          )}
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {loading && items.length === 0 ? (
        <Skeleton rows={6} />
      ) : items.length === 0 ? (
        <EmptyState title={searchTerm ? t('home.noMatches') : t('home.empty')} />
      ) : (
        <>
          {/* 已有内容时刷新/搜索：保留旧列表，顶部显示轻量加载条，避免清空闪烁或旧数据被误读 */}
          {loading && (
            <div className={shell.loadingBar} role="status" aria-live="polite">
              {t('home.loading')}
            </div>
          )}
          <ul className={shell.list}>
            {items.map((item) => (
              <li key={item.id}>
                <Link to={`/contributions/${item.id}`} className={shell.rowBtn}>
                  <span className={shell.rowMain}>
                    <span className={shell.rowTitle}>{item.title}</span>
                    {item.summary && <span className={shell.rowSummary}>{item.summary}</span>}
                    <span className={shell.rowMeta}>
                      <span>{item.author.displayName}</span>
                      <span className={shell.rowMetaSep}>·</span>
                      <span>{formatTs(item.publishedAt)}</span>
                      <span className={shell.rowMetaSep}>·</span>
                      <span>{item.language}</span>
                      {item.tags?.map((tag) => (
                        <Pill key={tag}>{tag}</Pill>
                      ))}
                    </span>
                  </span>
                  <span className={shell.rowRight}>
                    <span className={shell.chevron} aria-hidden="true">
                      <ChevronIcon />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {cursor && (
            <div className={shell.loadMoreWrap}>
              <AdminButton variant="secondary" loading={loading} onClick={loadMore}>
                {t('home.loadMore')}
              </AdminButton>
            </div>
          )}
        </>
      )}
    </div>
  )
}
