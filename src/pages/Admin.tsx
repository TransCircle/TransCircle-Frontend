import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useAuth } from '@/context/useAuth'
import { get, post, API_BASE } from '@/api/client'
import styles from './Admin.module.css'

// Temp token is kept in memory only (per api.md §JWT Payload Structure:
// access tokens must not be stored in localStorage or sessionStorage).
// On page refresh, admin must re-enter the token.
type Status = 'pending' | 'in_review' | 'approved' | 'rejected' | 'published' | 'hidden'
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
    id: string
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

interface ReviewEvent {
  id: string
  contributionId: string
  reviewerUserId: string
  action: string
  fromStatus: string
  toStatus: string
  publicNote: string | null
  internalNote: string | null
  createdAt: number
}

const STATUS_LABEL_KEYS: Record<Status, string> = {
  pending: 'admin.statusPending',
  approved: 'admin.statusApproved',
  rejected: 'admin.statusRejected',
  in_review: 'admin.statusInReview',
  published: '已发布',
  hidden: '已隐藏',
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
  const [reviewEvents, setReviewEvents] = useState<ReviewEvent[]>([])
  const [reviewEventsLoading, setReviewEventsLoading] = useState(false)

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

      const result = await get<Submission[]>(`/admin/contributions?${params}`, {
        headers: authHeaders(),
        skipRefresh: !accessToken, // tempToken users can't auto-refresh
      })
      if (result.status === 403) {
        setTempToken('')
        setLoading(false)
        return
      }
      if (!result.ok) {
        throw new Error(result.error.message || t('admin.errorLoad'))
      }

      const items = result.data
      const isLoadMore = !!cursor

      if (isLoadMore) {
        setSubmissions(prev => [...prev, ...items])
      } else {
        setSubmissions(items)
      }
      setNextCursor(result.pagination?.nextCursor || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.errorLoad'))
    } finally {
      setLoading(false)
    }
  }, [activeTab, authHeaders, t, accessToken])

  useEffect(() => {
    if (!isAdmin && !tempToken) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({ status: activeTab, limit: '50' })
        const result = await get<Submission[]>(`/admin/contributions?${params}`, {
          headers: authHeaders(),
          skipRefresh: !accessToken,
        })
        if (cancelled) return

        if (result.status === 403) {
          setTempToken('')
          return
        }
        if (!result.ok) {
          throw new Error(result.error.message || t('admin.errorLoad'))
        }

        const items = result.data
        setSubmissions(items)
        setNextCursor(result.pagination?.nextCursor || null)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('admin.errorLoad'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [activeTab, isAdmin, tempToken, authHeaders, t, accessToken])

  const fetchDetail = async (id: string) => {
    try {
      const result = await get<Submission>(`/admin/contributions/${id}`, {
        headers: authHeaders(),
        skipRefresh: !accessToken,
      })
      if (!result.ok) throw new Error(t('admin.errorDetail'))
      setSelected(result.data)
      setReviewNotes('')
      // Also fetch review history (api.md §6.3)
      setReviewEventsLoading(true)
      const eventsResult = await get<ReviewEvent[]>(`/admin/contributions/${id}/review-events`, {
        headers: authHeaders(),
        skipRefresh: !accessToken,
      })
      if (eventsResult.ok) {
        setReviewEvents(eventsResult.data)
      } else {
        setReviewEvents([])
      }
      setReviewEventsLoading(false)
    } catch {
      setReviewEventsLoading(false)
      setError(t('admin.errorDetail'))
    }
  }

  const handleReview = async (action: ReviewAction) => {
    if (!selected) return
    const v = selected.version || 1
    try {
      const result = await post(`/admin/contributions/${selected.id}/review`, {
        decision: action,
        publicNote: reviewNotes || null,
        expectedVersion: v,
      }, { headers: authHeaders(), skipRefresh: !accessToken })

      if (!result.ok) {
        throw new Error(result.error.message || t('admin.errorReview'))
      }
      setSelected(null)
      fetchSubmissions()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.errorReview'))
    }
  }

  const handlePublish = async () => {
    if (!selected) return
    const v = selected.version || 1
    const result = await post(`/admin/contributions/${selected.id}/publish`, {
      expectedVersion: v,
    }, { headers: authHeaders(), skipRefresh: !accessToken })
    if (!result.ok) {
      setError(result.error.message || t('admin.errorReview'))
      return
    }
    setSelected(null)
    fetchSubmissions()
  }

  const handleHide = async () => {
    if (!selected) return
    const reason = prompt('隐藏原因（必填，1-200 字符）：')
    if (!reason || !reason.trim() || reason.trim().length > 200) {
      setError('隐藏原因必填（1-200 字符）')
      return
    }
    const v = selected.version || 1
    const result = await post(`/admin/contributions/${selected.id}/hide`, {
      expectedVersion: v,
      reason: reason.trim(),
    }, { headers: authHeaders(), skipRefresh: !accessToken })
    if (!result.ok) {
      setError(result.error.message || t('admin.errorReview'))
      return
    }
    setSelected(null)
    fetchSubmissions()
  }

  const handleRestore = async () => {
    if (!selected) return
    const v = selected.version || 1
    const result = await post(`/admin/contributions/${selected.id}/restore`, {
      expectedVersion: v,
      reason: '管理员恢复',
    }, { headers: authHeaders(), skipRefresh: !accessToken })
    if (!result.ok) {
      setError(result.error.message || t('admin.errorReview'))
      return
    }
    setSelected(null)
    fetchSubmissions()
  }

  const handleDelete = async () => {
    if (!selected) return
    const reason = prompt('删除原因（必填，1-200 字符）：')
    if (!reason || !reason.trim() || reason.trim().length > 200) {
      setError('删除原因必填（1-200 字符）')
      return
    }
    if (!window.confirm('确定要软删除该投稿？此操作可审计追溯。')) return
    const v = selected.version || 1
    const result = await post(`/admin/contributions/${selected.id}/delete`, {
      expectedVersion: v,
      reason: reason.trim(),
    }, { headers: authHeaders(), skipRefresh: !accessToken })
    if (!result.ok) {
      setError(result.error.message || t('admin.errorReview'))
      return
    }
    setSelected(null)
    fetchSubmissions()
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
    const handleTempLogin = async () => {
      const raw = tokenInput.trim()
      if (!raw) return

      setLoading(true)
      setError('')
      // Verify the token has reviewer role before showing admin UI
      try {
        const res = await fetch(`${API_BASE}/admin/contributions?status=pending&limit=1`, {
          headers: { Authorization: `Bearer ${raw}` },
        })
        if (res.ok) {
          setTempToken(raw)
        } else if (res.status === 403) {
          setError(t('admin.accessDenied') || '权限不足，需要 reviewer 角色')
        } else {
          setError(t('admin.errorLoad') || '令牌无效')
        }
      } catch {
        setError(t('admin.networkError') || '网络错误')
      }
      setLoading(false)
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
    const tabs: Array<{ key: Status; label: string }> = [
      { key: 'pending', label: t('admin.tabs.pending') },
      { key: 'approved', label: t('admin.tabs.approved') },
      { key: 'rejected', label: t('admin.tabs.rejected') },
      { key: 'in_review', label: t('admin.tabs.inReview') },
      { key: 'published', label: '已发布' },
      { key: 'hidden', label: '已隐藏' },
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
            <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.75rem', fontSize: '0.85rem', flexWrap: 'wrap' }}>
              <Link to="/admin/users" style={{ color: 'var(--accent-pink)' }}>用户管理</Link>
              <Link to="/admin/edit-requests" style={{ color: 'var(--accent-pink)' }}>编辑申请</Link>
              <Link to="/admin/audit-logs" style={{ color: 'var(--accent-pink)' }}>审计日志</Link>
              <Link to="/admin" style={{ color: 'var(--text-muted)' }}>投稿审核</Link>
            </div>
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
                  <span className={styles.itemCategory}>{s.summary ? s.summary.slice(0, 20) : '-'}</span>
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

        {/* Internal note — only visible with contribution:internal-note:read permission (api.md §15.10) */}
        {selected.review?.internalNote && (
          <div className={styles.detailContact} style={{ borderLeft: '3px solid var(--accent-pink)', marginBottom: '1.25rem' }}>
            <strong style={{ color: 'var(--accent-pink)' }}>内部备注（仅管理员可见）</strong>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem' }}>{selected.review.internalNote}</p>
          </div>
        )}

        {/* Review history (api.md §6.3: audit trail) */}
        {reviewEventsLoading ? (
          <div className={styles.detailContact} style={{ marginBottom: '1.25rem', fontSize: '0.85rem' }}>
            加载审核历史...
          </div>
        ) : reviewEvents.length > 0 && (
          <div className={styles.detailContact} style={{ marginBottom: '1.25rem' }}>
            <strong>审核历史</strong>
            <ul style={{ margin: '0.5rem 0 0', padding: '0 0 0 1.2rem', fontSize: '0.82rem', lineHeight: 1.8 }}>
              {reviewEvents.map(ev => (
                <li key={ev.id}>
                  {ev.action} · {ev.fromStatus} → {ev.toStatus}
                  {ev.publicNote ? ` · 备注: ${ev.publicNote}` : ''}
                  {ev.createdAt ? ` · ${formatTs(ev.createdAt)}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        {selected.review?.publicNote && (
          <div className={styles.detailContact}>
            {t('admin.reviewNotes', { notes: selected.review.publicNote })}
            {selected.review.reviewerUserId && t('admin.reviewer', { reviewer: selected.review.reviewerUserId })}
            {selected.review.reviewedAt && ` · ${formatTs(selected.review.reviewedAt)}`}
          </div>
        )}

        {error && <div className={styles.errorBox} role="alert">{error}</div>}

        {(selected.status === 'pending' || selected.status === 'in_review') && (
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

        {/* Post-review actions: publish for approved, hide/delete for published, restore/delete for hidden, delete for rejected (api.md §6.4, §6.5, §6.6) */}
        {selected.status === 'approved' && (
          <div className={styles.reviewActions}>
            <button className={styles.btnPrimary} onClick={handlePublish}>
              发布
            </button>
          </div>
        )}
        {selected.status === 'published' && (
          <div className={styles.reviewActions}>
            <button className={styles.btnReject} onClick={handleHide}>
              隐藏
            </button>
            <button className={styles.btnReject} onClick={handleDelete}>
              删除
            </button>
          </div>
        )}
        {selected.status === 'hidden' && (
          <div className={styles.reviewActions}>
            <button className={styles.btnPrimary} onClick={handleRestore}>
              恢复
            </button>
            <button className={styles.btnReject} onClick={handleDelete}>
              删除
            </button>
          </div>
        )}
        {selected.status === 'rejected' && (
          <div className={styles.reviewActions}>
            <button className={styles.btnReject} onClick={handleDelete}>
              删除
            </button>
          </div>
        )}
      </div>
    </main>
  )
}


