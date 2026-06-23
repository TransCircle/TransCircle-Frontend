import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get, type ApiResult } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import styles from './Admin.module.css'

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

function formatTs(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  })
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

export const Home = () => {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [items, setItems] = useState<PublicContribution[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const searchTerm = searchParams.get('search') || ''

  const [error, setError] = useState('')
  const initialLoaded = useRef(false)

  const doLoad = useCallback(async (keyword?: string) => {
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
  }, [t])

  // 初始加载（无搜索词）或搜索词变化时重新加载
  useEffect(() => {
    initialLoaded.current = false
  }, [searchTerm])

  useEffect(() => {
    if (initialLoaded.current) return
    initialLoaded.current = true
    doLoad(searchTerm || undefined)
  }, [doLoad, searchTerm])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const form = e.currentTarget as HTMLFormElement
    const fd = new FormData(form)
    const q = (fd.get('search') as string || '').trim()
    setSearchParams(q ? { search: q } : {})
    if (!q) window.scrollTo({ top: 0 })
  }

  return (
    <main className={styles.container}>
      <header style={{ marginBottom: '2rem' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label htmlFor="search-input" style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{t('home.searchLabel')}</label>
          <input
            id="search-input"
            name="search"
            type="text"
            defaultValue={searchParams.get('search') || ''}
            placeholder={t('home.searchPlaceholder')}
            style={{ flex: 1, minWidth: '160px', padding: '0.4rem 0.6rem', border: '1.5px solid var(--divider-color)', borderRadius: '8px', fontSize: '0.85rem', fontFamily: 'inherit' }}
          />
          <button type="submit" className={`${styles.btnSecondary}`}>{t('home.searchSubmit')}</button>
          {searchTerm && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {loading ? t('home.searchExpanding') : t('home.localSearchHint', { count: items.length })}
            </span>
          )}
        </form>
        {searchTerm && items.length === 0 && !loading && (
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '-0.5rem', marginBottom: '0.5rem' }}>
            {t('home.noMatches')}
          </p>
        )}
        <h1 className={styles.heading}>TransCircle</h1>
        <p className={styles.headingDesc}>TransCircle</p>
        {user && (
          <div style={{ marginTop: '0.75rem' }}>
            <Link to="/submit" style={{ color: 'var(--accent-pink)' }}>{t('home.submitLink')}</Link>
            {' · '}
            <Link to="/me/contributions" style={{ color: 'var(--accent-pink)' }}>{t('home.myContributions')}</Link>
          </div>
        )}
      </header>

      {error ? (
        <div className={styles.empty} role="alert">{error}</div>
      ) : loading && items.length === 0 ? (
        <div className={styles.empty} role="status" aria-live="polite">{t('home.loading')}</div>
      ) : !loading && items.length === 0 && !searchTerm ? (
        <div className={styles.empty}>{t('home.empty')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {items.map(item => (
            <Link
              to={`/contributions/${item.id}`}
              key={item.id}
              className={styles.detailCard}
              style={{ cursor: 'pointer', textAlign: 'left', width: '100%', border: 'none', display: 'block', textDecoration: 'none', color: 'inherit' }}
            >
              <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.25rem', color: 'var(--text-main)' }}>
                {item.title}
              </h2>
              {item.summary && (
                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: '0 0 0.5rem' }}>
                  {item.summary}
                </p>
              )}
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {item.author.displayName} · {formatTs(item.publishedAt)} · {item.language}
                {item.tags?.map(t => (
                  <span key={t} style={{ marginLeft: '0.5rem', background: 'var(--hover-bg)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>{t}</span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}

      {cursor && (
        <button
          className={styles.btnSecondary}
          onClick={async () => {
            setLoading(true)
            try {
              // 保持搜索词，否则「加载更多」会拉到未过滤的下一页
              const result = await fetchPage(cursor, searchTerm || undefined)
              if (result.ok) {
                setItems(prev => [...prev, ...result.data])
                setCursor(result.pagination?.nextCursor || null)
              }
            } catch {
              // handled in fetchPage
            } finally {
              setLoading(false)
            }
          }}
          disabled={loading}
          style={{ display: 'block', margin: '1.5rem auto' }}
        >
          {loading ? t('home.loading') : t('home.loadMore')}
        </button>
      )}
    </main>
  )
}
