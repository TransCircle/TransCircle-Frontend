import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()

  const [items, setItems] = useState<MyContribution[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const fetchSeq = useRef(0)

  const fetchList = async (cursorVal?: string | null) => {
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '20' })
      // api.md §4.1: status param is optional, defaults to all statuses when omitted
      if (filterStatus && filterStatus !== 'all') params.set('status', filterStatus)
      if (cursorVal) params.set('cursor', cursorVal)

      const result = await get<MyContribution[]>(`/me/contributions?${params}`)
      if (seq !== fetchSeq.current) return  // Stale response, discard
      if (!result.ok) throw new Error(result.error.message)

      if (cursorVal) {
        setItems(prev => [...prev, ...result.data])
      } else {
        setItems(result.data)
      }
      setCursor(result.pagination?.nextCursor || null)
    } catch (err) {
      if (seq !== fetchSeq.current) return  // Stale response, discard
      setError(err instanceof Error ? err.message : t('myContributions.error'))
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (!user) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems([])
    setCursor(null)
    fetchList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, filterStatus])

  if (!user) {
    return (
      <main className={styles.container}>
        <p style={{ textAlign: 'center', padding: '2rem' }}>{t('myContributions.loginRequired')}</p>
      </main>
    )
  }

  return (
    <main className={styles.container}>
      <header>
        <h1 className={styles.heading}>{t('myContributions.title')}</h1>
      </header>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {(['all', 'draft', 'pending', 'in_review', 'approved', 'rejected', 'published', 'hidden', 'withdrawn'] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`${styles.tab} ${filterStatus === s ? styles.tabActive : ''}`}
            style={{ fontSize: '0.85rem', padding: '0.3rem 0.75rem' }}
          >
            {{
              all: t('myContributions.filterAll'),
              draft: t('myContributions.filterDraft'),
              pending: t('myContributions.filterPending'),
              in_review: t('myContributions.filterInReview'),
              approved: t('myContributions.filterApproved'),
              rejected: t('myContributions.filterRejected'),
              published: t('myContributions.filterPublished'),
              hidden: t('myContributions.filterHidden'),
              withdrawn: t('myContributions.filterWithdrawn'),
            }[s] || s}
          </button>
        ))}
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      {loading && items.length === 0 ? (
        <div className={styles.loading}>{t('myContributions.loading')}</div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>{t('myContributions.empty')}</div>
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
                    {{
                      draft: t('myContributions.filterDraft'),
                      pending: t('myContributions.filterPending'),
                      in_review: t('myContributions.filterInReview'),
                      approved: t('myContributions.filterApproved'),
                      rejected: t('myContributions.filterRejected'),
                      published: t('myContributions.filterPublished'),
                      hidden: t('myContributions.filterHidden'),
                      withdrawn: t('myContributions.filterWithdrawn'),
                    }[item.status] || item.status} · {formatTs(item.createdAt)}
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
              {t('myContributions.loadMore')}
            </button>
          )}
        </>
      )}
    </main>
  )
}
