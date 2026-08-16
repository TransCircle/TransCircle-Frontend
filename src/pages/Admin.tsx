import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { get, post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { useCursorList } from '@/hooks/useCursorList'
import { useStepUpAction } from '@/hooks/useStepUpAction'
import { limitByUnicode } from '@/utils/string'
import { useFormatTs } from '@/utils/datetime'
import {
  AdminButton,
  Alert,
  Card,
  EmptyState,
  Pill,
  ReasonPromptDialog,
  SectionLabel,
  Skeleton,
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

// 审核历史可展示任意状态迁移（含 draft/withdrawn/deleted），补全全部状态机 i18n 键，
// 避免审核历史把后端英文枚举原样直出（AGENTS.md：所有用户可见文本进 i18n）。
const REVIEW_STATUS_LABEL_KEYS: Record<string, string> = {
  ...STATUS_LABEL_KEYS,
  draft: 'admin.statusDraft',
  withdrawn: 'admin.statusWithdrawn',
  deleted: 'admin.statusDeleted',
}

const ChevronRight = () => (
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

export const Admin = () => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { loading: authLoading, accessToken, isAdmin, permissions } = useAuth()
  // 危险操作（隐藏/删除，及配置开启时的发布）可能返回 STEP_UP_REQUIRED → 弹 step-up；
  // 本地因子账号 onSuccess 后重放原操作；IAM 账号在对话框内跳转 IAM 完成后回本页重做。
  const { runWithStepUp, stepUpElement } = useStepUpAction(accessToken)
  const [activeTab, setActiveTab] = useState<Status>('pending')
  // 游标分页列表（统一模板）：切 tab 自动重载，保留旧列表 + 加载条。
  // 403/401（权限变更后快照过期）在 fetchPage 内捕获并置 accessDenied 文案。
  const { items: submissions, hasMore, loading, error, setError, reload, loadMore } =
    useCursorList<Submission>({
      fetchPage: async (cursorVal) => {
        const params = new URLSearchParams({ status: activeTab, limit: '20' })
        if (cursorVal) params.set('cursor', cursorVal)
        // 不传 authHeaders / skipRefresh：apiRequest 自动注入 Authorization 并处理 401 刷新
        const result = await get<Submission[]>(`/admin/contributions?${params}`)
        if (result.status === 403 || result.status === 401) {
          throw new Error(t('admin.accessDenied'))
        }
        if (!result.ok) throw new Error(result.error.message || t('admin.errorLoad'))
        return {
          data: result.data,
          nextCursor: result.pagination?.nextCursor ?? null,
          hasMore: result.pagination?.hasMore ?? false,
        }
      },
      deps: [activeTab, isAdmin],
      // 首载/切 tab 由下方 effect 显式触发（gate isAdmin，避免无权限时发无谓请求）
      autoLoad: false,
    })

  // 切 tab / 权限就绪时加载列表；非 admin 不发起（页面显示拒绝态）
  useEffect(() => {
    if (!isAdmin) return
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, isAdmin])

  const [selected, setSelected] = useState<Submission | null>(null)
  // 行点击→详情拉取中的 pending 反馈：避免慢网下点击像无效（loading-04）
  const [detailLoading, setDetailLoading] = useState(false)
  const [reviewNotes, setReviewNotes] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [reviewEvents, setReviewEvents] = useState<ReviewEvent[]>([])
  const [reviewEventsLoading, setReviewEventsLoading] = useState(false)

  // 隐藏/删除原因对话框（替代原生 window.confirm 与内联原因输入框）
  const [reasonDialog, setReasonDialog] = useState<{ kind: 'hide' | 'delete' } | null>(null)
  const [actionReason, setActionReason] = useState('')
  const [reasonError, setReasonError] = useState('')

  const fetchDetail = async (id: string) => {
    setError('')
    setDetailLoading(true)
    try {
      const result = await get<Submission>(`/admin/contributions/${id}`)
      if (!result.ok) throw new Error(t('admin.errorDetail'))
      setSelected(result.data)
      setReviewNotes('')
      setInternalNote('')
      // 审核历史需 contribution:audit:read（api.md §6.7）：reviewer 无该权限时
      // 不发起必 403 的无谓请求，历史区保持为空（前端无权限时后端本会拒绝）。
      if (hasPermission(permissions, PERMISSIONS.CONTRIBUTION_AUDIT_READ)) {
        setReviewEventsLoading(true)
        const eventsResult = await get<ReviewEvent[]>(`/admin/contributions/${id}/review-events`)
        if (eventsResult.ok) {
          setReviewEvents(eventsResult.data)
        } else {
          setReviewEvents([])
        }
        setReviewEventsLoading(false)
      }
    } catch {
      setReviewEventsLoading(false)
      setError(t('admin.errorDetail'))
    } finally {
      setDetailLoading(false)
    }
  }

  const handleReview = async (action: ReviewAction) => {
    if (!selected) return
    const v = selected.version || 1
    try {
      const result = await post(
        `/admin/contributions/${selected.id}/review`,
        {
          decision: action,
          publicNote: reviewNotes || null,
          internalNote: internalNote || null,
          expectedVersion: v,
        },
        {
          /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
        },
      )

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
      void reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.errorReview'))
    }
  }

  const handlePublish = async () => {
    if (!selected) return
    const id = selected.id
    const v = selected.version || 1
    const doPublish = async () => {
      const result = await post(
        `/admin/contributions/${id}/publish`,
        {
          expectedVersion: v,
          publicNote: null,
        },
        {
          /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
        },
      )
      if (!result.ok) {
        if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
          runWithStepUp(doPublish)
        } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
          setError(t('admin.versionConflictRefreshed'))
          fetchDetail(id)
        } else {
          setError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      setSelected(null)
      void reload()
    }
    await doPublish()
  }

  const runHide = async (reason: string) => {
    if (!selected) return
    const id = selected.id
    const v = selected.version || 1
    const doHide = async () => {
      const result = await post(
        `/admin/contributions/${id}/hide`,
        {
          expectedVersion: v,
          reason,
          publicNote: null,
          internalNote: null,
        },
        {
          /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
        },
      )
      if (!result.ok) {
        if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
          runWithStepUp(doHide)
        } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
          setError(t('admin.versionConflictRefreshed'))
          fetchDetail(id)
        } else {
          setError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      setSelected(null)
      void reload()
    }
    await doHide()
  }

  const handleRestore = async () => {
    if (!selected) return
    const v = selected.version || 1
    const result = await post(
      `/admin/contributions/${selected.id}/restore`,
      {
        expectedVersion: v,
        reason: t('admin.restoreReason'),
        publicNote: null,
        internalNote: null,
      },
      {
        /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
      },
    )
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
    void reload()
  }

  const runDelete = async (reason: string) => {
    if (!selected) return
    const id = selected.id
    const v = selected.version || 1
    const doDelete = async () => {
      const result = await post(
        `/admin/contributions/${id}/delete`,
        {
          expectedVersion: v,
          reason,
        },
        {
          /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
        },
      )
      if (!result.ok) {
        if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
          runWithStepUp(doDelete)
        } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
          setError(t('admin.versionConflictRefreshed'))
          fetchDetail(id)
        } else {
          setError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      setSelected(null)
      void reload()
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

    // 行点击后的详情拉取中：显示详情骨架，避免慢网下「点击像无效」或无占位跳变（loading-04）
    if (detailLoading) {
      return (
        <div className={shell.page}>
          <Skeleton variant="card" />
        </div>
      )
    }

    const countLabel = hasMore
      ? t('admin.countMore', { count: submissions.length })
      : t('admin.count', { count: submissions.length })

    return (
      <div className={shell.page}>
        <div className={shell.stickyHead}>
          <Tabs
            items={tabs}
            value={activeTab}
            onChange={setActiveTab}
            ariaLabel={t('admin.tabsAriaLabel', '投稿审核')}
            panelId="admin-review-panel"
          />
        </div>

        <div id="admin-review-panel" role="tabpanel" aria-labelledby={`tab-${activeTab}`} className={shell.tabpanel}>
          <div className={shell.count} role="status" aria-live="polite">
            {countLabel}
          </div>

          {error && <Alert tone="error">{error}</Alert>}

          {loading && submissions.length === 0 ? (
            <Skeleton rows={7} />
          ) : submissions.length === 0 ? (
            <EmptyState title={t('admin.empty')} />
          ) : (
            <>
              {/* 切 tab：保留旧列表，顶部轻量加载条，避免旧数据无提示被误读（loading-03） */}
              {loading && (
                <div className={shell.loadingBar} role="status" aria-live="polite">
                  {t('admin.loading')}
                </div>
              )}
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
                        <StatusBadge
                          tone={CONTRIB_STATUS_TONE[s.status] ?? 'neutral'}
                          label={t(STATUS_LABEL_KEYS[s.status])}
                          size="sm"
                        />
                        <span className={shell.chevron} aria-hidden="true">
                          <ChevronRight />
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <div className={shell.loadMoreWrap}>
                  <AdminButton variant="secondary" onClick={() => void loadMore()} loading={loading}>
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
  // 最近一次审核员显示名：优先从已加载的审核历史（reviewer.displayName）解析，
  // 避免把内部 reviewerUserId 直出给用户（AGENTS.md：不暴露内部标识）。
  const reviewerDisplayName = selected.review?.reviewerUserId
    ? (reviewEvents.find((ev) => ev.reviewer?.id === selected.review?.reviewerUserId)?.reviewer?.displayName ?? null)
    : null

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
            <StatusBadge
              tone={CONTRIB_STATUS_TONE[selected.status] ?? 'neutral'}
              label={t(STATUS_LABEL_KEYS[selected.status])}
            />
          </div>

          <div className={shell.metaRow}>
            <span className={shell.metaItem}>{t('admin.category', { category: selected.tags?.[0] || '—' })}</span>
            <span className={shell.metaItem}>
              {t('admin.authorLabel')}
              {authorDisplay}
            </span>
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
          ) : (
            reviewEvents.length > 0 && (
              <Card tone="subtle" padding="sm">
                <SectionLabel>{t('admin.reviewEventsTitle')}</SectionLabel>
                <ul className={shell.history}>
                  {reviewEvents.map((ev) => (
                    <li key={ev.id} className={shell.historyItem}>
                      <span className={shell.historyHead}>
                        <span>
                          {t(REVIEW_STATUS_LABEL_KEYS[ev.fromStatus] ?? ev.fromStatus)} →{' '}
                          {t(REVIEW_STATUS_LABEL_KEYS[ev.toStatus] ?? ev.toStatus)}
                        </span>
                        {ev.reviewer?.displayName && (
                          <span>
                            · {t('admin.reviewerPrefix')}
                            {ev.reviewer.displayName}
                          </span>
                        )}
                      </span>
                      {ev.publicNote && (
                        <span>
                          {t('admin.notePrefix')}
                          {ev.publicNote}
                        </span>
                      )}
                      {ev.createdAt ? <span className={shell.historyTime}>{formatTs(ev.createdAt)}</span> : null}
                    </li>
                  ))}
                </ul>
              </Card>
            )
          )}

          {selected.review?.publicNote && (
            <Card tone="subtle" padding="sm">
              <p className={shell.noteText}>
                {t('admin.reviewNotes', { notes: selected.review.publicNote })}
                {reviewerDisplayName && t('admin.reviewer', { reviewer: reviewerDisplayName })}
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
                <AdminButton variant="primary" onClick={handlePublish}>
                  {t('admin.publishButton')}
                </AdminButton>
              )}
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
                <AdminButton variant="danger" onClick={() => openReasonDialog('delete')}>
                  {t('admin.deleteButton')}
                </AdminButton>
              )}
            </div>
          )}
          {selected.status === 'published' && (
            <div className={shell.actions}>
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_HIDE) && (
                <AdminButton variant="danger" onClick={() => openReasonDialog('hide')}>
                  {t('admin.hideButton')}
                </AdminButton>
              )}
            </div>
          )}
          {selected.status === 'hidden' && (
            <div className={shell.actions}>
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_RESTORE) && (
                <AdminButton variant="primary" onClick={handleRestore}>
                  {t('admin.restoreButton')}
                </AdminButton>
              )}
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
                <AdminButton variant="danger" onClick={() => openReasonDialog('delete')}>
                  {t('admin.deleteButton')}
                </AdminButton>
              )}
            </div>
          )}
          {selected.status === 'rejected' && (
            <div className={shell.actions}>
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
                <AdminButton variant="danger" onClick={() => openReasonDialog('delete')}>
                  {t('admin.deleteButton')}
                </AdminButton>
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
        onCancel={() => {
          setReasonDialog(null)
          setReasonError('')
        }}
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
        onCancel={() => {
          setReasonDialog(null)
          setReasonError('')
        }}
        submitText={t('admin.deleteButton')}
        cancelText={t('admin.cancelReason')}
        maxLength={200}
        counterText={t('admin.ui.charCount', { n: actionReason.length, max: 200 })}
        error={reasonError || undefined}
        variant="danger"
      />

      {stepUpElement}
    </div>
  )
}
