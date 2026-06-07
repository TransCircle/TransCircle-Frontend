import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { get } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import styles from './Admin.module.css'

interface MyContribution {
  id: string
  title: string
  status: string
  createdAt: number
  updatedAt: number
  review: {
    publicNote: string | null
    reviewedAt: number | null
  }
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return ''
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

export const MyContributions = () => {
  const navigate = useNavigate()
  const { user } = useAuth()

  const [items, setItems] = useState<MyContribution[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  const fetchList = async (cursorVal?: string | null) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '20' })
      if (filterStatus) params.set('status', filterStatus)
      if (cursorVal) params.set('cursor', cursorVal)

      const result = await get<MyContribution[]>(`/me/contributions?${params}`)
      if (!result.ok) throw new Error(result.error.message)

      if (cursorVal) {
        setItems(prev => [...prev, ...result.data])
      } else {
        setItems(result.data)
      }
      setCursor(result.pagination?.nextCursor || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!user) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchList()
  }, [user, filterStatus])

  if (!user) {
    return (
      <main className={styles.container}>
        <p style={{ textAlign: 'center', padding: '2rem' }}>请先登录</p>
      </main>
    )
  }

  return (
    <main className={styles.container}>
      <header>
        <h1 className={styles.heading}>我的投稿</h1>
      </header>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {['', 'draft', 'pending', 'in_review', 'approved', 'rejected', 'published', 'hidden', 'withdrawn'].map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`${styles.tab} ${filterStatus === s ? styles.tabActive : ''}`}
            style={{ fontSize: '0.85rem', padding: '0.3rem 0.75rem' }}
          >
            {{
              '': '全部',
              draft: '草稿',
              pending: '待审核',
              approved: '已通过',
              rejected: '未通过',
              published: '已发布',
            }[s] || s}
          </button>
        ))}
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      {loading && items.length === 0 ? (
        <div className={styles.loading}>加载中...</div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>暂无投稿</div>
      ) : (
        <>
          <ul className={styles.list}>
            {items.map(item => (
              <li
                key={item.id}
                className={styles.item}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/me/contributions/${item.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/me/contributions/${item.id}`) } }}
              >
                <div className={styles.itemMain}>
                  <div className={styles.itemTitle}>{item.title}</div>
                  <div className={styles.itemMeta}>
                    {item.status} · {formatTs(item.createdAt)}
                    {item.review.publicNote ? ` · ${item.review.publicNote}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {cursor && (
            <button
              className={styles.btnSecondary}
              onClick={() => fetchList(cursor)}
              disabled={loading}
              style={{ display: 'block', margin: '1rem auto' }}
            >
              加载更多
            </button>
          )}
        </>
      )}
    </main>
  )
}
