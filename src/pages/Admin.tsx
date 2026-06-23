import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { get, post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { limitByUnicode } from '@/utils/string'
import { StepUpDialog } from '@/components/StepUpDialog'
import {
  AdminButton,
  Alert,
  Card,
  EmptyState,
  Pill,
  ReasonPromptDialog,
  SectionLabel,
  Spinner,
  StatusBadge,
  Tabs,
  TextArea,
  CONTRIB_STATUS_TONE,
  type TabItem,
} from '@/components/admin'
import shell from './Page.module.css'

// Temp token is kept in memory only (per api.md §JWT Payload Structure:
// access tokens must not be stored in localStorage or sessionStorage).
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

const ChevronRight = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="m9 18 6-6-6-6" />
  </svg>
)

function formatTs(ts: number | string | null): string {
  if (!ts) return ''
  const n = typeof ts === 'string' ? Number(ts) : ts
  if (isNaN(n)) return String(ts)
  return new Date(n).toISOString().slice(0, 16).replace('T', ' ')
}

export const Admin = () => {
  const { t } = useTranslation()
  const { user, loading: authLoading, accessToken, isAdmin, permissions } = useAuth()
  // 危险操作（隐藏/删除，及配置开启时的发布）可能返回 STEP_UP_REQUIRED → 弹 step-up；
  // 本地因子账号 onSuccess 后重放原操作；IAM 账号在对话框内跳转 IAM 完成后回本页重做。
  const [showStepUp, setShowStepUp] = useState(false)
  const pendingActionRef = useRef<(() => Promise<void>) | null>(null)
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

  // 隐藏/删除原因对话框（替代原生 window.confirm 与内联原因输入框）
  const [reasonDialog, setReasonDialog] = useState<{ kind: 'hide' | 'delete' } | null>(null)
  const [actionReason, setActionReason] = useState('')
  const [reasonError, setReasonError] = useState('')

  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = {}
    if (accessToken) h.Authorization = `Bearer ${accessToken}`
    return h
  }, [accessToken])

  const fetchSubmissions = useCallback(async (cursor?: string | null) => {
    const seq = ++fetchSeq.current
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ status: activeTab, limit: '50' })
      if (cursor) params.set('cursor', cursor)

      const result = await get<Submission[]>(`/admin/contributions?${params}`, {
        headers: authHeaders(),
        skipRefresh: !accessToken,
      })
      if (seq !== fetchSeq.current) return
      if (result.status === 403 || result.status === 401) {
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
    if (!isAdmin) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSubmissions()
  }, [activeTab, isAdmin, authHeaders, t, accessToken]) // eslint-disable-line react-hooks/exhaustive-deps

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
      setInternalNote('')
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
    const id = selected.id
    const v = selected.version || 1
    const doPublish = async () => {
      const result = await post(`/admin/contributions/${id}/publish`, {
        expectedVersion: v,
        publicNote: null,
      }, { headers: authHeaders(), skipRefresh: !accessToken })
      if (!result.ok) {
        if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
          pendingActionRef.current = doPublish
          setShowStepUp(true)
        } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
          setError(t('admin.versionConflictRefreshed'))
          fetchDetail(id)
        } else {
          setError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      setSelected(null)
      fetchSubmissions()
    }
    await doPublish()
  }

  const runHide = async (reason: string) => {
    if (!selected) return
    const id = selected.id
    const v = selected.version || 1
    const doHide = async () => {
      const result = await post(`/admin/contributions/${id}/hide`, {
        expectedVersion: v,
        reason,
        publicNote: null,
        internalNote: null,
      }, { headers: authHeaders(), skipRefresh: !accessToken })
      if (!result.ok) {
        if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
          pendingActionRef.current = doHide
          setShowStepUp(true)
        } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
          setError(t('admin.versionConflictRefreshed'))
          fetchDetail(id)
        } else {
          setError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      setSelected(null)
      fetchSubmissions()
    }
    await doHide()
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

  const runDelete = async (reason: string) => {
    if (!selected) return
    const id = selected.id
    const v = selected.version || 1
    const doDelete = async () => {
      const result = await post(`/admin/contributions/${id}/delete`, {
        expectedVersion: v,
        reason,
      }, { headers: authHeaders(), skipRefresh: !accessToken })
      if (!result.ok) {
        if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
          pendingActionRef.current = doDelete
          setShowStepUp(true)
        } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
          setError(t('admin.versionConflictRefreshed'))
          fetchDetail(id)
        } else {
          setError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      setSelected(null)
      fetchSubmissions()
    }
    await doDelete()
  }

  const openReasonDialog = (kind: 'hide' | 'delete') => {
    setActionReason('')
    setReasonError('')
    setError('')
    setReasonDialog({ kind })
  }

  const submitReason = async () => {
    if (!reasonDialog) return
    const reason = actionReason.trim()
    if (!reason || reason.length > 200) {
      setReasonError(reasonDialog.kind === 'hide' ? t('admin.hideReasonRequired') : t('admin.deleteReasonRequired'))
      return
    }
    const kind = reasonDialog.kind
    setReasonDialog(null)
    setReasonError('')
    if (kind === 'hide') await runHide(reason)
    else await runDelete(reason)
  }

  // ── Loading ──

  if (authLoading) {
    return (
      <div className={shell.page}>
        <Spinner size="md" label={t('admin.verifying')} />
      </div>
    )
  }

  // ── Not admin (OAuth user but no management permission) ──

  if (user && !isAdmin) {
    return (
      <div className={shell.page}>
        <EmptyState
          title={t('admin.accessDenied')}
          description={t('admin.accessDeniedDetail', { username: user.username })}
        />
      </div>
    )
  }

  // ── Submission List ──

  if (!selected) {
    const tabs: Array<TabItem<Status>> = [
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
      <div className={shell.page}>
        <div className={shell.stickyHead}>
          <Tabs items={tabs} value={activeTab} onChange={setActiveTab} ariaLabel={t('admin.tabsAriaLabel', '投稿审核')} panelId="admin-review-panel" />
        </div>

        <div
          id="admin-review-panel"
          role="tabpanel"
          aria-labelledby={`tab-${activeTab}`}
          className={shell.tabpanel}
        >
          <div className={shell.count} role="status" aria-live="polite">{countLabel}</div>

          {error && <Alert tone="error">{error}</Alert>}

          {loading && submissions.length === 0 ? (
            <Spinner size="md" label={t('admin.loading')} />
          ) : submissions.length === 0 ? (
            <EmptyState title={t('admin.empty')} />
          ) : (
            <>
              <ul className={shell.list}>
                {submissions.map((s) => (
                  <li key={s.id}>
                    <button type="button" className={shell.rowBtn} onClick={() => fetchDetail(s.id)}>
                      <span className={shell.rowMain}>
                        <span className={shell.rowTitle}>{s.title}</span>
                        <span className={shell.rowMeta}>
                          {s.author?.displayName || t('admin.authorAnonymous')}
                          <span className={shell.rowMetaSep}>·</span>
                          {formatTs(s.createdAt)}
                        </span>
                      </span>
                      <span className={shell.rowRight}>
                        {s.summary && <Pill>{limitByUnicode(s.summary, 20)}</Pill>}
                        <StatusBadge tone={CONTRIB_STATUS_TONE[s.status] ?? 'neutral'} label={t(STATUS_LABEL_KEYS[s.status])} size="sm" />
                        <span className={shell.chevron} aria-hidden="true"><ChevronRight /></span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <div className={shell.loadMoreWrap}>
                  <AdminButton variant="secondary" onClick={() => fetchSubmissions(nextCursor)} loading={loading}>
                    {t('admin.loadMore')}
                  </AdminButton>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  // ── Submission Detail ──

  const authorDisplay = selected.author?.displayName || t('admin.authorAnonymous')
  const canInternalNote = hasPermission(permissions, PERMISSIONS.CONTRIBUTION_INTERNAL_NOTE_READ)
  const isReviewable = selected.status === 'pending' || selected.status === 'in_review'

  return (
    <div className={shell.page}>
      <div>
        <AdminButton variant="ghost" size="sm" onClick={() => setSelected(null)}>
          {t('admin.back')}
        </AdminButton>
      </div>

      <Card>
        <div className={shell.stack}>
          <div className={shell.detailHead}>
            <h2 className={shell.detailTitle}>{selected.title}</h2>
            <StatusBadge tone={CONTRIB_STATUS_TONE[selected.status] ?? 'neutral'} label={t(STATUS_LABEL_KEYS[selected.status])} />
          </div>

          <div className={shell.metaRow}>
            <span className={shell.metaItem}>{t('admin.category', { category: selected.tags?.[0] || '—' })}</span>
            <span className={shell.metaItem}>{t('admin.authorLabel')}{authorDisplay}</span>
            <span className={shell.metaItem}>{t('admin.submitTime', { time: formatTs(selected.createdAt) })}</span>
          </div>

          <div className={shell.contentBlock}>{selected.contentRaw}</div>

          {/* Internal note — 仅在拥有 contribution:internal-note:read 权限时展示 */}
          {selected.review?.internalNote && canInternalNote && (
            <Card tone="subtle" accent padding="sm">
              <SectionLabel>{t('admin.internalNoteLabel')}</SectionLabel>
              <p className={shell.noteText}>{selected.review.internalNote}</p>
            </Card>
          )}

          {/* Review history (api.md §6.3: audit trail) */}
          {reviewEventsLoading ? (
            <Spinner size="sm" label={t('admin.reviewEventsLoading')} />
          ) : reviewEvents.length > 0 && (
            <Card tone="subtle" padding="sm">
              <SectionLabel>{t('admin.reviewEventsTitle')}</SectionLabel>
              <ul className={shell.history}>
                {reviewEvents.map(ev => (
                  <li key={ev.id} className={shell.historyItem}>
                    <span className={shell.historyHead}>
                      <span>{ev.fromStatus} → {ev.toStatus}</span>
                      {ev.reviewer?.displayName && <span>· {t('admin.reviewerPrefix')}{ev.reviewer.displayName}</span>}
                    </span>
                    {ev.publicNote && <span>{t('admin.notePrefix')}{ev.publicNote}</span>}
                    {ev.createdAt ? <span className={shell.historyTime}>{formatTs(ev.createdAt)}</span> : null}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {selected.review?.publicNote && (
            <Card tone="subtle" padding="sm">
              <p className={shell.noteText}>
                {t('admin.reviewNotes', { notes: selected.review.publicNote })}
                {selected.review.reviewerUserId && t('admin.reviewer', { reviewer: selected.review.reviewerUserId })}
                {selected.review.reviewedAt ? ` · ${formatTs(selected.review.reviewedAt)}` : ''}
              </p>
            </Card>
          )}

          {error && <Alert tone="error">{error}</Alert>}

          {isReviewable && (
            <div className={shell.stackSm}>
              <TextArea
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                placeholder={t('admin.reviewTextareaPlaceholder')}
              />
              {/* 内部备注输入：与后端一致，需 contribution:internal-note:read 权限 */}
              {canInternalNote && (
                <TextArea
                  value={internalNote}
                  onChange={(e) => setInternalNote(e.target.value)}
                  placeholder={t('admin.internalNotePlaceholder')}
                />
              )}
              <div className={shell.actions}>
                {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_REVIEW) && (
                  <AdminButton variant="primary" onClick={() => handleReview('approved')}>
                    {t('admin.approve')}
                  </AdminButton>
                )}
                {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_REVIEW) && (
                  <AdminButton variant="danger" onClick={() => handleReview('rejected')}>
                    {t('admin.reject')}
                  </AdminButton>
                )}
              </div>
            </div>
          )}

          {/* Post-review actions (api.md §6.4, §6.5, §6.6) */}
          {selected.status === 'approved' && (
            <div className={shell.actions}>
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_PUBLISH) && (
                <AdminButton variant="primary" onClick={handlePublish}>{t('admin.publishButton')}</AdminButton>
              )}
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
                <AdminButton variant="danger" onClick={() => openReasonDialog('delete')}>{t('admin.deleteButton')}</AdminButton>
              )}
            </div>
          )}
          {selected.status === 'published' && (
            <div className={shell.actions}>
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_HIDE) && (
                <AdminButton variant="danger" onClick={() => openReasonDialog('hide')}>{t('admin.hideButton')}</AdminButton>
              )}
            </div>
          )}
          {selected.status === 'hidden' && (
            <div className={shell.actions}>
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_RESTORE) && (
                <AdminButton variant="primary" onClick={handleRestore}>{t('admin.restoreButton')}</AdminButton>
              )}
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
                <AdminButton variant="danger" onClick={() => openReasonDialog('delete')}>{t('admin.deleteButton')}</AdminButton>
              )}
            </div>
          )}
          {selected.status === 'rejected' && (
            <div className={shell.actions}>
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
                <AdminButton variant="danger" onClick={() => openReasonDialog('delete')}>{t('admin.deleteButton')}</AdminButton>
              )}
            </div>
          )}
        </div>
      </Card>

      <ReasonPromptDialog
        open={reasonDialog?.kind === 'hide'}
        title={t('admin.hideTitle')}
        prompt={t('admin.hideReasonPrompt')}
        placeholder={t('admin.reasonPlaceholder')}
        value={actionReason}
        onChange={setActionReason}
        onSubmit={submitReason}
        onCancel={() => { setReasonDialog(null); setReasonError('') }}
        submitText={t('admin.hideButton')}
        cancelText={t('admin.cancelReason')}
        maxLength={200}
        counterText={t('admin.ui.charCount', { n: actionReason.length, max: 200 })}
        error={reasonError || undefined}
        variant="danger"
      />
      <ReasonPromptDialog
        open={reasonDialog?.kind === 'delete'}
        title={t('admin.deleteTitle')}
        prompt={t('admin.deleteReasonPrompt')}
        placeholder={t('admin.reasonPlaceholder')}
        value={actionReason}
        onChange={setActionReason}
        onSubmit={submitReason}
        onCancel={() => { setReasonDialog(null); setReasonError('') }}
        submitText={t('admin.deleteButton')}
        cancelText={t('admin.cancelReason')}
        maxLength={200}
        counterText={t('admin.ui.charCount', { n: actionReason.length, max: 200 })}
        error={reasonError || undefined}
        variant="danger"
      />

      {showStepUp && accessToken && (
        <StepUpDialog
          accessToken={accessToken}
          onSuccess={() => { setShowStepUp(false); const a = pendingActionRef.current; pendingActionRef.current = null; void a?.() }}
          onCancel={() => { setShowStepUp(false); pendingActionRef.current = null }}
        />
      )}
    </div>
  )
}
