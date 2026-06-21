import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useAuth } from '@/context/useAuth'
import { get, post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { limitByUnicode } from '@/utils/string'
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
  reviewer: {
    id: string
    displayName: string
  } | null
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
  published: 'admin.statusPublished',
  hidden: 'admin.statusHidden',
}

function formatTs(ts: number | string | null): string {
  if (!ts) return ''
  const n = typeof ts === 'string' ? Number(ts) : ts
  if (isNaN(n)) return String(ts)
  return new Date(n).toISOString().slice(0, 16).replace('T', ' ')
}

export const Admin = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading, accessToken, loginProvider, isAdmin, isFullAdmin, permissions, loginWithGitHub } = useAuth()
  const [tempToken, setTempToken] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [activeTab, setActiveTab] = useState<Status>('pending')
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Submission | null>(null)
  const [reviewNotes, setReviewNotes] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [reviewEvents, setReviewEvents] = useState<ReviewEvent[]>([])
  const [reviewEventsLoading, setReviewEventsLoading] = useState(false)
  const fetchSeq = useRef(0)

  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = {}
    if (accessToken) h.Authorization = `Bearer ${accessToken}`
    else if (tempToken) h.Authorization = `Bearer ${tempToken}`
    return h
  }, [accessToken, tempToken])

  const fetchSubmissions = useCallback(async (cursor?: string | null) => {
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ status: activeTab, limit: '50' })
      if (cursor) params.set('cursor', cursor)

      const result = await get<Submission[]>(`/admin/contributions?${params}`, {
        headers: authHeaders(),
        skipRefresh: !accessToken, // tempToken users can't auto-refresh
      })
      if (seq !== fetchSeq.current) return
      if (result.status === 403 || result.status === 401) {
        setTempToken('')
        setLoading(false)
        return
      }
      if (!result.ok) {
        if (seq !== fetchSeq.current) return
        throw new Error(result.error.message || t('admin.errorLoad'))
      }

      if (seq !== fetchSeq.current) return

      const items = result.data
      const isLoadMore = !!cursor

      if (isLoadMore) {
        setSubmissions(prev => [...prev, ...items])
      } else {
        setSubmissions(items)
      }
      const pagination = result.pagination
      setNextCursor(pagination?.nextCursor || null)
      setHasMore(pagination?.hasMore ?? false)
    } catch (err) {
      if (seq !== fetchSeq.current) return
      setError(err instanceof Error ? err.message : t('admin.errorLoad'))
    } finally {
      if (seq === fetchSeq.current) setLoading(false)
    }
  }, [activeTab, authHeaders, t, accessToken])

  useEffect(() => {
    if (!isAdmin && !tempToken) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSubmissions()
  }, [activeTab, isAdmin, tempToken, authHeaders, t, accessToken]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchDetail = async (id: string) => {
    setError('')
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
        internalNote: internalNote || null,
        expectedVersion: v,
      }, { headers: authHeaders(), skipRefresh: !accessToken })

      if (!result.ok) {
        if (result.error.code === ERRORS.VERSION_CONFLICT && selected) {
          setError(t('admin.versionConflictRefreshed'))
          fetchDetail(selected.id)
        } else {
          setError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      setSelected(null)
      fetchSubmissions(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.errorReview'))
    }
  }

  const handlePublish = async () => {
    if (!selected) return
    const v = selected.version || 1
    const result = await post(`/admin/contributions/${selected.id}/publish`, {
      expectedVersion: v,
      publicNote: null,
    }, { headers: authHeaders(), skipRefresh: !accessToken })
    if (!result.ok) {
      if (result.error.code === ERRORS.VERSION_CONFLICT && selected) {
        setError(t('admin.versionConflictRefreshed'))
        fetchDetail(selected.id)
      } else {
        setError(result.error.message || t('admin.errorReview'))
      }
      return
    }
    setSelected(null)
    fetchSubmissions()
  }

  const [actionReason, setActionReason] = useState('')
  const [actionType, setActionType] = useState<'hide' | 'delete' | null>(null)

  const handleHide = async () => {
    if (!selected) return
    if (actionType !== 'hide') {
      setActionType('hide')
      setActionReason('')
      setError('')
      return
    }
    const reason = actionReason.trim()
    if (!reason || reason.length > 200) {
      setError(t('admin.hideReasonRequired'))
      return
    }
    setActionType(null)
    setActionReason('')
    const v = selected.version || 1
    const result = await post(`/admin/contributions/${selected.id}/hide`, {
      expectedVersion: v,
      reason,
      publicNote: null,
      internalNote: null,
    }, { headers: authHeaders(), skipRefresh: !accessToken })
    if (!result.ok) {
      if (result.error.code === ERRORS.VERSION_CONFLICT && selected) {
        setError(t('admin.versionConflictRefreshed'))
        fetchDetail(selected.id)
      } else {
        setError(result.error.message || t('admin.errorReview'))
      }
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
      reason: t('admin.restoreReason'),
      publicNote: null,
      internalNote: null,
    }, { headers: authHeaders(), skipRefresh: !accessToken })
    if (!result.ok) {
      if (result.error.code === ERRORS.VERSION_CONFLICT && selected) {
        setError(t('admin.versionConflictRefreshed'))
        fetchDetail(selected.id)
      } else {
        setError(result.error.message || t('admin.errorReview'))
      }
      return
    }
    setSelected(null)
    fetchSubmissions()
  }

  const handleDelete = async () => {
    if (!selected) return
    if (actionType !== 'delete') {
      setActionType('delete')
      setActionReason('')
      setError('')
      return
    }
    const reason = actionReason.trim()
    if (!reason || reason.length > 200) {
      setError(t('admin.deleteReasonRequired'))
      return
    }
    if (!window.confirm(t('admin.deleteConfirm'))) {
      setActionType(null)
      setActionReason('')
      return
    }
    setActionType(null)
    setActionReason('')
    const v = selected.version || 1
    const result = await post(`/admin/contributions/${selected.id}/delete`, {
      expectedVersion: v,
      reason,
    }, { headers: authHeaders(), skipRefresh: !accessToken })
    if (!result.ok) {
      if (result.error.code === ERRORS.VERSION_CONFLICT && selected) {
        setError(t('admin.versionConflictRefreshed'))
        fetchDetail(selected.id)
      } else {
        setError(result.error.message || t('admin.errorReview'))
      }
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
      try {
        // Verify the token has reviewer role by making an authenticated apiRequest
        // with the manual Authorization header (apiRequest will not interfere since
        // _memoryToken is null at this point for non-OAuth users).
        const result = await get('/admin/contributions?status=pending&limit=1', {
          headers: { Authorization: `Bearer ${raw}` },
          skipRefresh: true,
        })
        if (result.ok) {
          setTempToken(raw)
        } else if (result.status === 403 || result.status === 401) {
          setError(t('admin.accessDenied'))
        } else {
          setError(t('admin.errorLoad'))
        }
      } catch {
        setError(t('admin.networkError'))
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
      { key: 'published', label: t('admin.statusPublished') },
      { key: 'hidden', label: t('admin.statusHidden') },
    ]

    const countLabel = hasMore
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
              {user ? `${user.username} (${loginProvider ?? 'oauth'})` : `${t('admin.tempAdmin')} (${t('admin.tempAdminHint')})`}
            </span>
            {isAdmin && (
              <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.75rem', fontSize: '0.85rem', flexWrap: 'wrap' }}>
                {isFullAdmin && (
                  <>
                    <Link to="/admin/users" style={{ color: 'var(--accent-pink)' }}>{t('admin.usersLink')}</Link>
                    <Link to="/admin/audit-logs" style={{ color: 'var(--accent-pink)' }}>{t('admin.auditLogsLink')}</Link>
                  </>
                )}
                <Link to="/admin/edit-requests" style={{ color: 'var(--accent-pink)' }}>{t('admin.editRequestsLink')}</Link>
              </div>
            )}
          </div>
        </div>

        <nav className={styles.tabs} role="tablist" aria-label={t('admin.tabsAriaLabel', '投稿审核')}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
              aria-selected={activeTab === tab.key}
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
                <li key={s.id}>
                  <button
                    type="button"
                    className={styles.itemButton}
                    onClick={() => fetchDetail(s.id)}
                  >
                  <div className={styles.itemMain}>
                    <div className={styles.itemTitle}>{s.title}</div>
                    <div className={styles.itemMeta}>
                      {s.author?.displayName || t('admin.authorAnonymous')} · {formatTs(s.createdAt)}
                    </div>
                  </div>
                    <span className={styles.itemCategory}>{s.summary ? limitByUnicode(s.summary, 20) : '-'}</span>
                  </button>
                </li>
              ))}
            </ul>
            {hasMore && (
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
            <strong style={{ color: 'var(--accent-pink)' }}>{t('admin.internalNoteLabel')}</strong>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem' }}>{selected.review.internalNote}</p>
          </div>
        )}

        {/* Review history (api.md §6.3: audit trail) */}
        {reviewEventsLoading ? (
          <div className={styles.detailContact} style={{ marginBottom: '1.25rem', fontSize: '0.85rem' }}>
            {t('admin.reviewEventsLoading')}
          </div>
        ) : reviewEvents.length > 0 && (
          <div className={styles.detailContact} style={{ marginBottom: '1.25rem' }}>
            <strong>{t('admin.reviewEventsTitle')}</strong>
            <ul style={{ margin: '0.5rem 0 0', padding: '0 0 0 1.2rem', fontSize: '0.82rem', lineHeight: 1.8 }}>
              {reviewEvents.map(ev => (
                <li key={ev.id}>
                  {ev.fromStatus} → {ev.toStatus}
                  {ev.reviewer?.displayName ? ` · ${t('admin.reviewerPrefix')}${ev.reviewer.displayName}` : ''}
                  {ev.publicNote ? ` · ${t('admin.notePrefix')}${ev.publicNote}` : ''}
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

        {actionType && (
          <div style={{ margin: '1rem 0', padding: '0.75rem', border: '1px solid var(--divider-color)', borderRadius: '8px', background: 'var(--hover-bg)' }}>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              {actionType === 'hide' ? t('admin.hideReasonPrompt') : t('admin.deleteReasonPrompt')}
            </p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="text"
                value={actionReason}
                onChange={e => setActionReason(e.target.value)}
                placeholder={t('admin.reasonPlaceholder')}
                aria-label={t('admin.reasonAriaLabel', '操作原因')}
                autoFocus
                style={{ flex: 1, padding: '0.4rem 0.6rem', border: '1.5px solid var(--divider-color)', borderRadius: '8px', fontSize: '0.85rem', fontFamily: 'inherit' }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    if (actionType === 'hide') handleHide()
                    else handleDelete()
                  }
                  if (e.key === 'Escape') { setActionType(null); setActionReason('') }
                }}
              />
              <button className={styles.btnPrimary} onClick={actionType === 'hide' ? handleHide : handleDelete}
                style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }}>
                {t('admin.confirmReason')}
              </button>
              <button className={styles.btnSecondary} onClick={() => { setActionType(null); setActionReason('') }}
                style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }}>
                {t('admin.cancelReason')}
              </button>
            </div>
          </div>
        )}

        {(selected.status === 'pending' || selected.status === 'in_review') && (
          <>
            <textarea
              className={styles.reviewTextarea}
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              placeholder={t('admin.reviewTextareaPlaceholder')}
            />
            <textarea
              className={styles.reviewTextarea}
              value={internalNote}
              onChange={(e) => setInternalNote(e.target.value)}
              placeholder={t('admin.internalNotePlaceholder')}
              style={{ marginTop: '0.5rem', minHeight: '3rem' }}
            />

            <div className={styles.reviewActions}>
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_REVIEW) && (
                <button className={styles.btnPrimary} onClick={() => handleReview('approved')}>
                  {t('admin.approve')}
                </button>
              )}
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_REVIEW) && (
                <button className={styles.btnReject} onClick={() => handleReview('rejected')}>
                  {t('admin.reject')}
                </button>
              )}
            </div>
          </>
        )}

        {/* Post-review actions: publish for approved, hide/delete for published, restore/delete for hidden, delete for rejected (api.md §6.4, §6.5, §6.6) */}
        {selected.status === 'approved' && (
          <div className={styles.reviewActions}>
            {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_PUBLISH) && (
              <button className={styles.btnPrimary} onClick={handlePublish}>
                {t('admin.publishButton')}
              </button>
            )}
            {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
              <button className={styles.btnReject} onClick={handleDelete}>
                {t('admin.deleteButton')}
              </button>
            )}
          </div>
        )}
        {selected.status === 'published' && (
          <div className={styles.reviewActions}>
            {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_HIDE) && (
              <button className={styles.btnReject} onClick={handleHide}>
                {t('admin.hideButton')}
              </button>
            )}
          </div>
        )}
        {selected.status === 'hidden' && (
          <div className={styles.reviewActions}>
            {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_RESTORE) && (
              <button className={styles.btnPrimary} onClick={handleRestore}>
                {t('admin.restoreButton')}
              </button>
            )}
            {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
              <button className={styles.btnReject} onClick={handleDelete}>
                {t('admin.deleteButton')}
              </button>
            )}
          </div>
        )}
        {selected.status === 'rejected' && (
          <div className={styles.reviewActions}>
            {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
              <button className={styles.btnReject} onClick={handleDelete}>
                {t('admin.deleteButton')}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  )
}


