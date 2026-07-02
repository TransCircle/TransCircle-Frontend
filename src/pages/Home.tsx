import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get, type ApiResult } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { AdminButton, Alert, EmptyState, PageHeader, Pill, SearchField, Spinner } from '@/components/ui'
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

async function fetchPage(cursorVal?: string | null, keywordVal?: string): Promise<ApiResult<PublicContribution[]>> {
  try {
    const params = new URLSearchParams({ limit: '20' })
    if (cursorVal) params.set('cursor', cursorVal)
    if (keywordVal) params.set('keyword', keywordVal)
    return get<PublicContribution[]>(`/public/contributions?${params}`)
  } catch {
    return { ok: false as const, error: { code: 'NETWORK_ERROR', message: '' }, requestId: '', status: 0 }
  }
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

  const [items, setItems] = useState<PublicContribution[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const searchTerm = searchParams.get('search') || ''
  const [searchInput, setSearchInput] = useState(searchTerm)
  const initialLoaded = useRef(false)

  const doLoad = useCallback(
    async (keyword?: string) => {
      setLoading(true)
      const result = await fetchPage(undefined, keyword || undefined)
      if (result.ok) {
        setItems(result.data)
        setCursor(result.pagination?.nextCursor || null)
        setError('')
      } else {
        setError(result.error.message || t('home.errorLoad'))
      }
      setLoading(false)
    },
    [t],
  )

  // 初始加载（无搜索词）或搜索词变化时重新加载
  useEffect(() => {
    initialLoaded.current = false
  }, [searchTerm])

  useEffect(() => {
    if (initialLoaded.current) return
    initialLoaded.current = true
    setSearchInput(searchTerm)
    doLoad(searchTerm || undefined)
  }, [doLoad, searchTerm])

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

  const loadMore = async () => {
    setLoading(true)
    try {
      // 保持搜索词，否则「加载更多」会拉到未过滤的下一页
      const result = await fetchPage(cursor, searchTerm || undefined)
      if (result.ok) {
        setItems((prev) => [...prev, ...result.data])
        setCursor(result.pagination?.nextCursor || null)
      }
    } finally {
      setLoading(false)
    }
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

      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : loading && items.length === 0 ? (
        <Spinner size="lg" label={t('home.loading')} />
      ) : items.length === 0 ? (
        <EmptyState title={searchTerm ? t('home.noMatches') : t('home.empty')} />
      ) : (
        <>
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
