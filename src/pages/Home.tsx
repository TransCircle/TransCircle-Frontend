import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get } from '@/api/client'
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
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

async function fetchPage(cursorVal?: string | null) {
  const params = new URLSearchParams({ limit: '20' })
  if (cursorVal) params.set('cursor', cursorVal)
  return get<PublicContribution[]>(`/public/contributions?${params}`)
}

export const Home = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [items, setItems] = useState<PublicContribution[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanding, setExpanding] = useState(false)
  const [initialDone, setInitialDone] = useState(false)

  const searchTerm = searchParams.get('search')?.toLowerCase()

  const [error, setError] = useState('')
  const initialLoaded = useRef(false)
  const expandGen = useRef(0)

  const doInitialLoad = useCallback(async () => {
    setLoading(true)
    const result = await fetchPage()
    if (result.ok) {
      setItems(result.data)
      setCursor(result.pagination?.nextCursor || null)
      setError('')
    } else {
      setError(result.error.message || t('home.errorLoad'))
    }
    setLoading(false)
    setInitialDone(true)
  }, [t])

  useEffect(() => {
    if (initialLoaded.current) return
    initialLoaded.current = true
    doInitialLoad()
  }, [doInitialLoad])

  useEffect(() => {
    const gen = ++expandGen.current
    if (!searchTerm || !initialDone) return

    const MAX_PAGES = 5
    let pagesLoaded = 1

    ;(async () => {
      setExpanding(true)
      let currentCursor = cursor
      while (currentCursor && pagesLoaded < MAX_PAGES && gen === expandGen.current) {
        const result = await fetchPage(currentCursor)
        if (!result.ok || gen !== expandGen.current) break
        setItems(prev => [...prev, ...result.data])
        currentCursor = result.pagination?.nextCursor || null
        pagesLoaded++
      }
      if (gen === expandGen.current) {
        setCursor(currentCursor)
        setExpanding(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, initialDone])

  const displayItems = searchTerm
    ? items.filter(item =>
        item.title.toLowerCase().includes(searchTerm) ||
        (item.summary?.toLowerCase().includes(searchTerm)) ||
        item.tags?.some(t => t.toLowerCase().includes(searchTerm))
      )
    : items

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
          <button type="submit" style={{ padding: '0.4rem 0.75rem', cursor: 'pointer' }}>{t('home.searchSubmit')}</button>
          {searchTerm && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {expanding ? t('home.searchExpanding') : t('home.localSearchHint', { count: displayItems.length })}
            </span>
          )}
        </form>
        {searchTerm && displayItems.length === 0 && !loading && !expanding && (
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
      ) : !loading && displayItems.length === 0 && !searchTerm ? (
        <div className={styles.empty}>{t('home.empty')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {displayItems.map(item => (
            <button
              type="button"
              key={item.id}
              className={styles.detailCard}
              onClick={() => navigate(`/contributions/${item.id}`)}
              style={{ cursor: 'pointer', textAlign: 'left', width: '100%', border: 'none' }}
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
            </button>
          ))}
        </div>
      )}

      {cursor && !searchTerm && (
        <button
          className={styles.btnSecondary}
          onClick={() => {
            setLoading(true)
            fetchPage(cursor).then(result => {
              if (result.ok) {
                setItems(prev => [...prev, ...result.data])
                setCursor(result.pagination?.nextCursor || null)
              }
              setLoading(false)
            })
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
