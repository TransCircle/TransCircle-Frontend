import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { API_BASE } from '@/config'
import styles from './Admin.module.css'

// Temp token is kept in memory only (per api.md §JWT Payload Structure:
// access tokens must not be stored in localStorage or sessionStorage).
// On page refresh, admin must re-enter the token.
type Status = 'pending' | 'approved' | 'rejected'
type ReviewAction = 'approved' | 'rejected'

interface Submission {
  id: string
  title: string
  summary: string | null
  contentRaw?: string
  contentHtml?: string
  contentFormat?: string
  tags?: string[]
  language?: string
  status: Status
  version: number
  author: {
    id: string | null
    username?: string
    displayName: string
    avatarUrl: string | null
    emailVerified?: boolean
  }
  createdAt: number
  updatedAt?: number
  submittedAt?: number | null
  publishedAt?: number | null
  review?: {
    reviewerUserId: string | null
    reviewedAt: number | null
    decision: string | null
    publicNote: string | null
    internalNote: string | null
  }
}

interface ListResponse {
  data: Submission[]
  pagination: { nextCursor: string | null; hasMore: boolean; limit: number }
}

const STATUS_LABEL_KEYS: Record<Status, string> = {
  pending: 'admin.statusPending',
  approved: 'admin.statusApproved',
  rejected: 'admin.statusRejected',
}

function formatTs(ts: number | string | null): string {
  if (!ts) return ''
  const n = typeof ts === 'string' ? Number(ts) : ts
  if (isNaN(n)) return String(ts)
  return new Date(n).toISOString().slice(0, 16).replace('T', ' ')
}

export const Admin = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading, accessToken, loginProvider, isAdmin, loginWithGitHub } = useAuth()
  const [tempToken, setTempToken] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [activeTab, setActiveTab] = useState<Status>('pending')
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Submission | null>(null)
  const [reviewNotes, setReviewNotes] = useState('')

  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = {}
    if (accessToken) h.Authorization = `Bearer ${accessToken}`
    else if (tempToken) h.Authorization = `Bearer ${tempToken}`
    return h
  }, [accessToken, tempToken])

  const fetchSubmissions = useCallback(async (cursor?: string | null) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ status: activeTab, limit: '50' })
      if (cursor) params.set('cursor', cursor)

      const res = await fetch(`${API_BASE}/admin/contributions?${params}`, { headers: authHeaders() })
      if (res.status === 403) {
        setTempToken('')
        setLoading(false)
        return
      }
      if (!res.ok) {
        const body = await res.json() as { error?: { message?: string } }
        throw new Error(body.error?.message ?? '加载失败')
      }
      const body = await res.json() as ListResponse

      const items = body.data
      const pageCursor = body.pagination.nextCursor

      if (pageCursor) {
        setSubmissions(prev => [...prev, ...items])
      } else {
        setSubmissions(items)
      }
      setNextCursor(pageCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.errorLoad'))
    } finally {
      setLoading(false)
    }
  }, [activeTab, authHeaders, t])

  useEffect(() => {
    if (!isAdmin && !tempToken) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({ status: activeTab, limit: '50' })
        const res = await fetch(`${API_BASE}/admin/contributions?${params}`, { headers: authHeaders() })
        if (cancelled) return

        if (res.status === 403) {
          setTempToken('')
          return
        }
        if (!res.ok) {
          const body = await res.json() as { error?: { message?: string } }
          throw new Error(body.error?.message ?? t('admin.errorLoad'))
        }
        const body = await res.json() as ListResponse
        if (cancelled) return

        const items = body.data
        const pageCursor = body.pagination.nextCursor
        setSubmissions(pageCursor ? prev => [...prev, ...items] : items)
        setNextCursor(pageCursor)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('admin.errorLoad'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [activeTab, isAdmin, tempToken, authHeaders, t])

  const fetchDetail = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/admin/contributions/${id}`, { headers: authHeaders() })
      if (!res.ok) throw new Error('加载失败')
      const body = await res.json() as { data?: Submission }
      setSelected(body.data ?? null)
      setReviewNotes('')
    } catch {
      setError(t('admin.errorDetail'))
    }
  }

  const handleReview = async (action: ReviewAction) => {
    if (!selected) return
    const v = selected.version || 1
    try {
      const res = await fetch(`${API_BASE}/admin/contributions/${selected.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          decision: action,
          publicNote: reviewNotes || undefined,
          expectedVersion: v,
        }),
      })
      if (!res.ok) {
        const body = await res.json() as { error?: { message?: string } }
        throw new Error(body.error?.message ?? '操作失败')
      }
      setSelected(null)
      fetchSubmissions()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.errorReview'))
    }
  }

  // ── Loading ──

  if (authLoading) {
    return (
      <main className={styles.container}>
        <div className={styles.loading}>{t('admin.verifying')}</div>
      </main>
    )
  }

  // ── Not logged in (no OAuth user + no temp token) ──

  if (!user && !tempToken) {
    const handleTempLogin = () => {
      if (tokenInput.trim()) {
        setTempToken(tokenInput.trim())
      }
    }

    return (
      <main className={styles.container}>
        <header>
          <h1 className={styles.heading}>
            {t('admin.title')}
          </h1>
          <p className={styles.headingDesc}>
            {t('admin.description')}
          </p>
        </header>

        <div className={styles.loginBox}>
          <button className={`${styles.btnPrimary} ${styles.loginBoxBtn}`} onClick={loginWithGitHub}>
            {t('admin.loginWithGithub')}
          </button>

          <div className={styles.loginDivider}>
            <p className={styles.loginDescription}>
              {t('admin.tempTokenDescription')}
            </p>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={t('admin.tempTokenPlaceholder')}
              onKeyDown={(e) => e.key === 'Enter' && handleTempLogin()}
            />
            <button className={styles.btnSecondary} onClick={handleTempLogin}>
              {t('admin.tempTokenLogin')}
            </button>
          </div>
        </div>
      </main>
    )
  }

  // ── Not admin (OAuth user but not in org) ──

  if (user && !isAdmin) {
    return (
      <main className={styles.container}>
        <h1 className={styles.heading}>
          {t('admin.accessDenied')}
        </h1>
        <p className={styles.headingDesc}>
          {t('admin.accessDeniedDetail', { username: user.username })}
        </p>
      </main>
    )
  }

  // ── Submission List ──

  if (!selected) {
    const tabs = [
      { key: 'pending' as Status, label: t('admin.tabs.pending') },
      { key: 'approved' as Status, label: t('admin.tabs.approved') },
      { key: 'rejected' as Status, label: t('admin.tabs.rejected') },
    ]

    const countLabel = nextCursor
      ? t('admin.countMore', { count: submissions.length })
      : t('admin.count', { count: submissions.length })

    return (
      <main className={styles.container}>
        <div className={styles.bar}>
          <div>
            <h1 className={styles.heading}>
              {t('admin.title')}
            </h1>
            <span className={styles.userInfo}>
              {user ? `${user.username} (${loginProvider ?? 'oauth'})` : `${t('admin.tempAdmin')}（仅内存，刷新页面需重新输入）`}
            </span>
          </div>
        </div>

        <nav className={styles.tabs}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className={styles.count}>{countLabel}</div>

        {error && <div className={styles.errorBox} role="alert">{error}</div>}

        {loading && submissions.length === 0 ? (
          <div className={styles.loading}>{t('admin.loading')}</div>
        ) : submissions.length === 0 ? (
          <div className={styles.empty}>{t('admin.empty')}</div>
        ) : (
          <>
            <ul className={styles.list}>
              {submissions.map((s) => (
                <li
                  key={s.id}
                  className={styles.item}
                  role="button"
                  tabIndex={0}
                  onClick={() => fetchDetail(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      fetchDetail(s.id)
                    }
                  }}
                >
                  <div className={styles.itemMain}>
                    <div className={styles.itemTitle}>{s.title}</div>
                    <div className={styles.itemMeta}>
                      {s.author?.displayName || t('admin.authorAnonymous')} · {formatTs(s.createdAt)}
                    </div>
                  </div>
                  <span className={styles.itemCategory}>{s.tags?.[0] || '-'}</span>
                </li>
              ))}
            </ul>
            {nextCursor && (
              <button
                className={`${styles.btnSecondary} ${styles.loadMoreBtn}`}
                onClick={() => fetchSubmissions(nextCursor)}
                disabled={loading}
              >
                {loading ? t('admin.loading') : t('admin.loadMore')}
              </button>
            )}
          </>
        )}
      </main>
    )
  }

  // ── Submission Detail ──

  const authorDisplay = selected.author?.displayName || t('admin.authorAnonymous')

  const statusLabel = STATUS_LABEL_KEYS[selected.status] || selected.status

  return (
    <main className={styles.container}>
      <button className={styles.back} onClick={() => setSelected(null)}>
        {t('admin.back')}
      </button>

      <div className={styles.detailCard}>
        <h2 className={styles.detailTitle}>{selected.title}</h2>

        <div className={styles.detailMeta}>
          <span>{t('admin.category', { category: selected.tags?.[0] || '-' })}</span>
          <span>
            {t('admin.authorLabel')}{authorDisplay}
          </span>
          <span>{t('admin.submitTime', { time: formatTs(selected.createdAt) })}</span>
          <span>{t('admin.status', { status: statusLabel })}</span>
        </div>

        <div className={styles.detailContent}>
          {selected.contentRaw}
        </div>

        {selected.review?.publicNote && (
          <div className={styles.detailContact}>
            {t('admin.reviewNotes', { notes: selected.review.publicNote })}
            {selected.review.reviewerUserId && t('admin.reviewer', { reviewer: selected.review.reviewerUserId })}
            {selected.review.reviewedAt && ` · ${formatTs(selected.review.reviewedAt)}`}
          </div>
        )}

        {error && <div className={styles.errorBox} role="alert">{error}</div>}

        {selected.status === 'pending' && (
          <>
            <textarea
              className={styles.reviewTextarea}
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              placeholder={t('admin.reviewTextareaPlaceholder')}
            />

            <div className={styles.reviewActions}>
              <button className={styles.btnPrimary} onClick={() => handleReview('approved')}>
                {t('admin.approve')}
              </button>
              <button className={styles.btnReject} onClick={() => handleReview('rejected')}>
                {t('admin.reject')}
              </button>
            </div>
          </>
        )}

        {/* Re-review is not supported by the current backend state machine */}
      </div>
    </main>
  )
}
