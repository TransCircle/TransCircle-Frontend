import { useState, useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
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

export const Home = () => {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [items, setItems] = useState<PublicContribution[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchList = async (cursorVal?: string | null) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '20' })
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<PublicContribution[]>(`/public/contributions?${params}`)
      if (result.ok) {
        // Client-side search filtering
        const searchTerm = searchParams.get('search')?.toLowerCase()
        let data = result.data
        if (searchTerm) {
          data = data.filter(item =>
            item.title.toLowerCase().includes(searchTerm) ||
            item.summary?.toLowerCase().includes(searchTerm) ||
            item.tags.some(t => t.toLowerCase().includes(searchTerm))
          )
        }
        if (cursorVal) {
          setItems(prev => [...prev, ...data])
        } else {
          setItems(data)
        }
        setCursor(result.pagination?.nextCursor || null)
      }
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchList();  
  }, [searchParams])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const form = e.currentTarget as HTMLFormElement
    const fd = new FormData(form)
    const q = (fd.get('search') as string || '').trim()
    setSearchParams(q ? { search: q } : {})
  }

  return (
    <main className={styles.container}>
      <header style={{ marginBottom: '2rem' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
          <input
            name="search"
            type="text"
            defaultValue={searchParams.get('search') || ''}
            placeholder="搜索已发布的投稿..."
            style={{ flex: 1, padding: '0.4rem 0.6rem', border: '1.5px solid var(--divider-color)', borderRadius: '8px', fontSize: '0.85rem', fontFamily: 'inherit' }}
          />
          <button type="submit" style={{ padding: '0.4rem 0.75rem', cursor: 'pointer' }}>搜索</button>
        </form>
        <h1 className={styles.heading}>TransCircle</h1>
        <p className={styles.headingDesc}>社区翻译与协作平台</p>
        {user && (
          <div style={{ marginTop: '0.75rem' }}>
            <Link to="/submit" style={{ color: 'var(--accent-pink)' }}>去投稿</Link>
            {' · '}
            <Link to="/me/contributions" style={{ color: 'var(--accent-pink)' }}>我的投稿</Link>
          </div>
        )}
      </header>

      {!loading && items.length === 0 ? (
        <div className={styles.empty}>暂无已发布的投稿</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {items.map(item => (
            <div
              key={item.id}
              className={styles.detailCard}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/contributions/${item.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/contributions/${item.id}`) }}
              style={{ cursor: 'pointer' }}
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
            </div>
          ))}
        </div>
      )}

      {cursor && (
        <button
          className={styles.btnSecondary}
          onClick={() => fetchList(cursor)}
          disabled={loading}
          style={{ display: 'block', margin: '1.5rem auto' }}
        >
          {loading ? '加载中...' : '加载更多'}
        </button>
      )}
    </main>
  )
}
