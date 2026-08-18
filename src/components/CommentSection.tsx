import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { get, post, del, newIdempotencyKey, setIntentKey } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { useCursorList } from '@/hooks/useCursorList'
import { Button, Alert, ConfirmDialog, EmptyState, ReasonPromptDialog, Skeleton, TextArea } from '@/components/ui'
import { useFormatTs } from '@/utils/datetime'
import styles from './CommentSection.module.css'

interface CommentAuthor {
  displayName: string
  avatarUrl: string | null
}

interface CommentItem {
  id: string
  authorUserId: string
  author: CommentAuthor
  content: string | null
  parentId: string | null
  createdAt: number
  deletedAt: number | null
  replies: CommentItem[]
}

export function CommentSection({ contributionId }: { contributionId: string }) {
  const { t } = useTranslation()
  const { user, accessToken, loginWithPass } = useAuth()
  const formatTs = useFormatTs()

  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyContent, setReplyContent] = useState('')
  const [replyError, setReplyError] = useState('')
  const [replySubmitting, setReplySubmitting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CommentItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [reportTarget, setReportTarget] = useState<CommentItem | null>(null)
  const [reportReason, setReportReason] = useState('')
  const [reportSubmitting, setReportSubmitting] = useState(false)
  const [reportError, setReportError] = useState('')
  const [notice, setNotice] = useState('')

  const { items, cursor, hasMore, loading, error, reload, loadMore } = useCursorList<CommentItem>({
    fetchPage: async (cursorVal) => {
      const params = new URLSearchParams({ limit: '20' })
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<CommentItem[]>(`/public/contributions/${contributionId}/comments?${params}`)
      if (!result.ok) throw new Error(result.error.message)
      return {
        data: result.data,
        nextCursor: result.pagination?.nextCursor ?? null,
        hasMore: result.pagination?.hasMore ?? false,
      }
    },
    deps: [contributionId],
  })

  const submitComment = async (
    parentId: string | null,
    text: string,
    onDone: (() => void) | undefined,
    setError: (msg: string) => void,
    setBusy: (busy: boolean) => void,
  ) => {
    if (!accessToken) return
    const trimmed = text.trim()
    if (!trimmed) {
      setError(t('comment.contentRequired'))
      return
    }
    if (text.length > 2000) {
      setError(t('comment.contentTooLong'))
      return
    }
    setBusy(true)
    setError('')
    setIntentKey(newIdempotencyKey())
    const result = await post<CommentItem>(
      `/contributions/${contributionId}/comments`,
      { content: text, parentId },
      { idempotent: true },
    )
    setBusy(false)
    if (!result.ok) {
      setError(result.error?.message || t('comment.networkError'))
      return
    }
    onDone?.()
    await reload()
  }

  const doReport = async () => {
    if (!reportTarget) return
    if (!reportReason.trim()) {
      setReportError(t('comment.reportReasonRequired'))
      return
    }
    if (reportReason.length > 500) {
      setReportError(t('comment.reportReasonTooLong'))
      return
    }
    setReportSubmitting(true)
    setReportError('')
    setIntentKey(newIdempotencyKey())
    const result = await post(`/public/contributions/${contributionId}/comments/${reportTarget.id}/report`, {
      reason: reportReason,
    }, { idempotent: true })
    setReportSubmitting(false)
    if (!result.ok) {
      setReportError(result.error?.message || t('comment.reportError'))
      return
    }
    setReportTarget(null)
    setReportReason('')
    setNotice(t('comment.reportDone'))
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError('')
    const result = await del(`/me/comments/${deleteTarget.id}`)
    setDeleting(false)
    if (!result.ok) {
      setDeleteError(result.error?.message || t('comment.deleteError'))
      return
    }
    setDeleteTarget(null)
    await reload()
  }

  const renderComment = (item: CommentItem, isReply: boolean) => {
    return (
      <div className={isReply ? styles.reply : styles.comment}>
        <div className={styles.meta}>
          <span className={styles.author}>{item.author.displayName}</span>
          <span className={styles.time}>{formatTs(item.createdAt)}</span>
        </div>
        {item.deletedAt !== null ? (
          <p className={styles.deleted}>{t('comment.deletedPlaceholder')}</p>
        ) : (
          <p className={styles.content}>{item.content}</p>
        )}
        <div className={styles.actions}>
          {!isReply && user && (
            <Button variant="ghost" size="sm" onClick={() => setReplyTo(replyTo === item.id ? null : item.id)}>
              {replyTo === item.id ? t('comment.replyCancel') : t('comment.reply')}
            </Button>
          )}
          {user && user.id === item.authorUserId && item.deletedAt === null && (
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(item)}>
              {t('comment.delete')}
            </Button>
          )}
          {user && user.id !== item.authorUserId && (
            <Button variant="ghost" size="sm" onClick={() => { setReportTarget(item); setReportReason(''); setReportError('') }}>
              {t('comment.report')}
            </Button>
          )}
        </div>
        {replyTo === item.id && (
          <div className={styles.replyComposer}>
            <TextArea
              autoFocus
              value={replyContent}
              onChange={(e) => setReplyContent(e.target.value)}
              placeholder={t('comment.replyPlaceholder')}
              aria-label={t('comment.replyPlaceholder')}
              maxLength={2000}
            />
            {replyError && <Alert tone="error">{replyError}</Alert>}
            <div className={styles.composerActions}>
              <Button variant="ghost" size="sm" onClick={() => setReplyTo(null)}>
                {t('comment.replyCancel')}
              </Button>
              <Button variant="primary" size="sm" loading={replySubmitting} onClick={() => void submitComment(item.id, replyContent, () => setReplyContent(''), setReplyError, setReplySubmitting)}>
                {t('comment.replySubmit')}
              </Button>
            </div>
          </div>
        )}
        {item.replies?.length > 0 && (
          <ul className={styles.replies} role="list">
            {item.replies.map((reply) => (
              <li key={reply.id}>{renderComment(reply, true)}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <section className={styles.section} aria-label={t('comment.title')}>
      <h2 className={styles.title}>{t('comment.title')}</h2>

      {user ? (
        <div className={styles.composer}>
          <TextArea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('comment.placeholder')}
            aria-label={t('comment.placeholder')}
            maxLength={2000}
          />
          {submitError && <Alert tone="error">{submitError}</Alert>}
          <div className={styles.composerActions}>
            <Button variant="primary" loading={submitting} onClick={() => void submitComment(null, content, () => setContent(''), setSubmitError, setSubmitting)}>
              {submitting ? t('comment.submitting') : t('comment.submit')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.loginCta}>
          <p>{t('comment.loginRequired')}</p>
          <Button variant="primary" onClick={() => void loginWithPass(window.location.pathname)}>
            {t('comment.loginCta')}
          </Button>
        </div>
      )}

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {loading && items.length === 0 ? (
        <Skeleton rows={4} />
      ) : !error && items.length === 0 ? (
        <EmptyState title={t('comment.empty')} />
      ) : (
        <ul className={styles.list} role="list">
          {items.map((item) => (
            <li key={item.id} className={styles.listItem}>
              {renderComment(item, false)}
            </li>
          ))}
        </ul>
      )}

      {hasMore && cursor && (
        <div className={styles.loadMore}>
          <Button variant="secondary" onClick={() => void loadMore()} loading={loading}>
            {t('comment.loadMore')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('comment.delete')}
        message={t('comment.deleteConfirm')}
        confirmText={t('comment.delete')}
        cancelText={t('common.cancel')}
        variant="danger"
        confirmLoading={deleting}
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
      {deleteError && <Alert tone="error">{deleteError}</Alert>}

      <ReasonPromptDialog
        open={reportTarget !== null}
        title={t('comment.reportTitle')}
        prompt={t('comment.reportPlaceholder')}
        placeholder={t('comment.reportPlaceholder')}
        value={reportReason}
        onChange={setReportReason}
        onSubmit={() => void doReport()}
        onCancel={() => setReportTarget(null)}
        submitText={t('comment.reportSubmit')}
        cancelText={t('common.cancel')}
        maxLength={500}
        error={reportError}
        submitting={reportSubmitting}
      />
    </section>
  )
}
