import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { get, post } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { usePagedList } from '@/hooks/usePagedList'
import { useStepUpAction } from '@/hooks/useStepUpAction'
import { limitByUnicode } from '@/utils/string'
import { useFormatTs } from '@/utils/datetime'
import {
  AdminButton,
  Alert,
  ConfirmDialog,
  EmptyState,
  Pagination,
  ReasonPromptDialog,
  Select,
  Skeleton,
  StatusBadge,
  type BadgeTone,
} from '@/components/ui'
import shell from './Page.module.css'

interface AdminComment {
  id: string
  contributionId: string
  contributionTitle: string | null
  author: { displayName: string; avatarUrl: string | null }
  content: string | null
  parentId: string | null
  status: 'visible' | 'hidden' | 'deleted'
  deletedAt: number | null
  reportCount: number
  createdAt: number
  updatedAt: number
}

type StatusFilter = 'all' | 'visible' | 'hidden' | 'deleted'

const STATUS_TONE: Record<AdminComment['status'], BadgeTone> = {
  visible: 'green',
  hidden: 'amber',
  deleted: 'muted',
}

export const AdminComments = () => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { accessToken, loading: authLoading, permissions } = useAuth()
  const { stepUpElement, runWithStepUp } = useStepUpAction(accessToken)

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [hideTarget, setHideTarget] = useState<AdminComment | null>(null)
  const [hideReason, setHideReason] = useState('')
  const [hideSubmitting, setHideSubmitting] = useState(false)
  const [hideError, setHideError] = useState('')
  const [restoreTarget, setRestoreTarget] = useState<AdminComment | null>(null)
  const [restoreSubmitting, setRestoreSubmitting] = useState(false)
  const [restoreError, setRestoreError] = useState('')

  const { items, pageIndex, knownPages, hasMore, loading, error, reload, goToPage } = usePagedList<AdminComment>({
    fetchPage: async (cursorVal) => {
      const params = new URLSearchParams({ limit: '50' })
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<AdminComment[]>(`/admin/comments?${params}`)
      if (!result.ok) throw new Error(result.error.message)
      return {
        data: result.data,
        nextCursor: result.pagination?.nextCursor ?? null,
        hasMore: result.pagination?.hasMore ?? false,
      }
    },
    deps: [statusFilter],
    autoLoad: false,
  })

  useEffect(() => {
    if (authLoading || !accessToken) return
    if (!hasPermission(permissions, PERMISSIONS.COMMENT_MODERATE)) return
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken, statusFilter, permissions])

  const performHide = async () => {
    if (!hideTarget) return
    if (!hideReason.trim()) {
      setHideError(t('adminComments.reasonRequired'))
      return
    }
    if (hideReason.length > 200) {
      setHideError(t('adminComments.reasonTooLong'))
      return
    }
    setHideSubmitting(true)
    setHideError('')
    const result = await post<{ id: string; status: string; updatedAt: number }>(`/admin/comments/${hideTarget.id}/hide`, {
      reason: hideReason,
      expectedVersion: hideTarget.updatedAt,
    })
    setHideSubmitting(false)
    if (!result.ok) {
      if (result.status === 403 && result.error.code === 'STEP_UP_REQUIRED') {
        runWithStepUp(performHide)
        return
      }
      setHideError(result.error?.message || t('adminComments.hideError'))
      return
    }
    setHideTarget(null)
    setHideReason('')
    await reload()
  }

  const performRestore = async () => {
    if (!restoreTarget) return
    setRestoreSubmitting(true)
    setRestoreError('')
    const result = await post<{ id: string; status: string; updatedAt: number }>(`/admin/comments/${restoreTarget.id}/restore`, {
      expectedVersion: restoreTarget.updatedAt,
    })
    setRestoreSubmitting(false)
    if (!result.ok) {
      setRestoreError(result.error?.message || t('adminComments.restoreError'))
      return
    }
    setRestoreTarget(null)
    await reload()
  }

  const statusLabel = (status: AdminComment['status']) => {
    if (status === 'visible') return t('adminComments.statusVisible')
    if (status === 'hidden') return t('adminComments.statusHidden')
    return t('adminComments.statusDeleted')
  }

  return (
    <div className={shell.page}>
      <div className={shell.stickyHead}>
        <div className={shell.toolbar}>
          <Select<StatusFilter>
            value={statusFilter}
            onChange={setStatusFilter}
            ariaLabel={t('adminComments.status')}
            fieldClassName={shell.grow}
            options={[
              { value: 'all', label: t('adminComments.statusAll') },
              { value: 'visible', label: t('adminComments.statusVisible') },
              { value: 'hidden', label: t('adminComments.statusHidden') },
              { value: 'deleted', label: t('adminComments.statusDeleted') },
            ]}
          />
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {loading && items.length === 0 ? (
        <Skeleton rows={8} />
      ) : items.length === 0 ? (
        <EmptyState title={t('adminComments.empty')} />
      ) : (
        <>
          {loading && (
            <div className={shell.loadingBar} role="status" aria-live="polite">
              {t('adminComments.loading')}
            </div>
          )}
          <ul className={shell.list}>
            {items.map((comment) => (
              <li key={comment.id} className={shell.rowStatic}>
                <span className={shell.rowMain}>
                  <span className={shell.rowTitle}>
                    {comment.content ? limitByUnicode(comment.content, 120) : t('comment.deletedPlaceholder')}
                  </span>
                  <span className={shell.rowMeta}>
                    <span>{t('adminComments.author')}: {comment.author.displayName}</span>
                    <span className={shell.rowMetaSep}>·</span>
                    <span>{t('adminComments.contribution')}: {limitByUnicode(comment.contributionTitle ?? comment.contributionId, 28)}</span>
                    <span className={shell.rowMetaSep}>·</span>
                    <span>{t('adminComments.reportCount')}: {comment.reportCount}</span>
                    <span className={shell.rowMetaSep}>·</span>
                    <span>{formatTs(comment.createdAt)}</span>
                  </span>
                </span>
                <span className={shell.rowRight}>
                  <StatusBadge tone={STATUS_TONE[comment.status]} label={statusLabel(comment.status)} />
                  {comment.status === 'visible' && (
                    <AdminButton variant="ghost" size="sm" onClick={() => { setHideTarget(comment); setHideReason(''); setHideError('') }}>
                      {t('adminComments.hide')}
                    </AdminButton>
                  )}
                  {comment.status === 'hidden' && (
                    <AdminButton variant="secondary" size="sm" onClick={() => { setRestoreTarget(comment); setRestoreError('') }}>
                      {t('adminComments.restore')}
                    </AdminButton>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <Pagination
            pageIndex={pageIndex}
            knownPages={knownPages}
            hasMore={hasMore}
            disabled={loading}
            onChange={goToPage}
          />
        </>
      )}

      <ReasonPromptDialog
        open={hideTarget !== null}
        title={t('adminComments.hideTitle')}
        prompt={t('adminComments.hidePrompt')}
        placeholder={t('adminComments.hidePlaceholder')}
        value={hideReason}
        onChange={setHideReason}
        onSubmit={() => void performHide()}
        onCancel={() => { setHideTarget(null); setHideReason(''); setHideError('') }}
        submitText={t('adminComments.hide')}
        cancelText={t('common.cancel')}
        maxLength={200}
        error={hideError}
        variant="danger"
        submitting={hideSubmitting}
      />

      <ConfirmDialog
        open={restoreTarget !== null}
        title={t('adminComments.restoreTitle')}
        message={t('adminComments.restoreConfirm')}
        confirmText={t('adminComments.restore')}
        cancelText={t('common.cancel')}
        confirmLoading={restoreSubmitting}
        onConfirm={() => void performRestore()}
        onCancel={() => { setRestoreTarget(null); setRestoreError('') }}
      />
      {restoreError && <Alert tone="error">{restoreError}</Alert>}
      {stepUpElement}
    </div>
  )
}
