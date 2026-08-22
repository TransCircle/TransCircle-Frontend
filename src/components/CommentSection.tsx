import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { get, post, del, isRetryableFailure } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { usePagedList } from '@/hooks/usePagedList'
import { useIntentKey } from '@/hooks/useIntentKey'
import { Button, Alert, ConfirmDialog, EmptyState, Pagination, ReasonPromptDialog, Skeleton, TextArea } from '@/components/ui'
import { useFormatTs } from '@/utils/datetime'
import styles from './CommentSection.module.css'

interface CommentAuthor {
  displayName: string
  avatarUrl: string | null
}

/** 头像回退：取显示名首字，无名时用间隔号占位（不留空圆）。 */
const initialOf = (name: string) => (name ?? '').trim().charAt(0) || '·'

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

/**
 * 注意：调用方用 `key={contributionId}` 挂载本组件，切换投稿时整体重挂载。
 * 这样跨投稿的陈旧闭包（提交/删除请求尚在途中时读者跳到另一篇）不可能改写
 * 新投稿的评论列表——旧实例已卸载，它的 setState 不再作用于任何界面。
 */
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

  /* 幂等键按「目标 + 正文」记账：网络失败后原样重试复用同一个键，避免重复评论/举报。
     顶层评论与回复必须各持一份——它们可以并发提交，共用一份的话后发的那次会覆盖
     先发的签名，先发的那条重试时就会拿到新键，服务端再也认不出是同一件事。 */
  const topIntent = useIntentKey()
  const replyIntent = useIntentKey()
  const reportIntent = useIntentKey()

  const { items, pageIndex, knownPages, hasMore, stale, loading, loadFailed, error, reload, refresh, goToPage } = usePagedList<CommentItem>({
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

  /**
   * 发表评论 / 回复。
   *
   * `onDone` 只在草稿仍是提交时那一份时才被调用：请求往返期间输入框并未冻结，
   * 用户完全可能已经改写成下一条评论，无条件 setContent('') 会把它抹掉。
   */
  /* 当前展开的回复框对应哪条父评论。**同步**镜像 replyTo：提交的响应可能在
     同一轮事件循环的后续 microtask 里就到达，读 state 会拿到旧值。 */
  const replyToRef = useRef<string | null>(null)

  /* 所有回复框共用同一份 replyContent，切换父评论时必须清掉，
     否则给 A 写了一半的回复会原样出现在 B 的回复框里，一不留神就发错地方。 */
  const openReply = (id: string) => {
    const next = replyToRef.current === id ? null : id
    replyToRef.current = next
    setReplyTo(next)
    setReplyContent('')
    setReplyError('')
  }

  const closeReply = () => {
    replyToRef.current = null
    setReplyTo(null)
    setReplyContent('')
    setReplyError('')
  }

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
    const intent = parentId ? replyIntent : topIntent
    intent.begin(JSON.stringify([parentId, text]))
    const result = await post<CommentItem>(
      `/contributions/${contributionId}/comments`,
      { content: text, parentId },
      { idempotent: true },
    )
    setBusy(false)
    intent.settle(!result.ok && isRetryableFailure(result.status))
    /* 回复的界面反馈只在「回复框仍然指着当初提交的那条父评论」时才写回。
       否则用户切到父评论 B 之后，A 的成功会清空 B 的草稿、A 的失败会把错误
       显示在 B 的回复框里——两条都指着一件他没做过的事。 */
    const stillOnTarget = parentId === null || replyToRef.current === parentId
    if (!result.ok) {
      if (stillOnTarget) setError(result.error?.message || t('comment.networkError'))
      return
    }
    if (stillOnTarget) onDone?.()
    // 回复的父评论就在当前页，回到第一页会让刚发的回复完全看不见；
    // 新的顶层评论则是「从头开始看」的动作，回第一页是对的。
    await (parentId ? refresh() : reload())
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
    reportIntent.begin(JSON.stringify([reportTarget.id, reportReason]))
    const result = await post(`/public/contributions/${contributionId}/comments/${reportTarget.id}/report`, {
      reason: reportReason,
    }, { idempotent: true })
    setReportSubmitting(false)
    reportIntent.settle(!result.ok && isRetryableFailure(result.status))
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
    // 删除的是当前页的某一条，读者应当留在原地
    await refresh()
  }

  /* 列表最近一次加载失败时锁住条目上的操作：删除成功后紧跟的刷新若失败，
     屏幕上那条评论仍以「未删除」的样子留着，删除按钮也重新可点——再点一次
     就是对一个已经删掉的对象重复发写请求。任何一次成功加载都会解锁。 */
  const itemActionsLocked = loadFailed

  const renderComment = (item: CommentItem, isReply: boolean) => {
    return (
      <div className={isReply ? styles.reply : styles.comment}>
        <div className={styles.meta}>
          {item.author.avatarUrl ? (
            <img className={styles.avatar} src={item.author.avatarUrl} alt="" loading="lazy" />
          ) : (
            <span className={styles.avatarFallback} aria-hidden="true">
              {initialOf(item.author.displayName)}
            </span>
          )}
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
            <Button variant="ghost" size="sm" disabled={itemActionsLocked} onClick={() => openReply(item.id)}>
              {replyTo === item.id ? t('comment.replyCancel') : t('comment.reply')}
            </Button>
          )}
          {user && user.id === item.authorUserId && item.deletedAt === null && (
            <Button
              variant="ghost"
              size="sm"
              disabled={itemActionsLocked}
              onClick={() => {
                setDeleteTarget(item)
                setDeleteError('')
              }}
            >
              {t('comment.delete')}
            </Button>
          )}
          {user && user.id !== item.authorUserId && (
            <Button variant="ghost" size="sm" disabled={itemActionsLocked} onClick={() => { setReportTarget(item); setReportReason(''); setReportError('') }}>
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
              <Button
                variant="ghost"
                size="sm"
                onClick={closeReply}
              >
                {t('comment.replyCancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={replySubmitting}
                onClick={() => {
                  const sent = replyContent
                  void submitComment(
                    item.id,
                    sent,
                    () => setReplyContent((cur) => (cur === sent ? '' : cur)),
                    setReplyError,
                    setReplySubmitting,
                  )
                }}
              >
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
    <section className={styles.section} aria-labelledby="comment-section-title">
      <h2 id="comment-section-title" className={styles.title}>
        {t('comment.title')}
      </h2>

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
            <Button
              variant="primary"
              loading={submitting}
              onClick={() => {
                const sent = content
                void submitComment(
                  null,
                  sent,
                  () => setContent((cur) => (cur === sent ? '' : cur)),
                  setSubmitError,
                  setSubmitting,
                )
              }}
            >
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
        <Skeleton rows={3} />
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

      {(knownPages > 1 || hasMore) && (
        <div className={styles.pager}>
          <Pagination
            pageIndex={pageIndex}
            knownPages={knownPages}
            hasMore={hasMore}
            disabled={loading || stale}
            onChange={goToPage}
          />
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
        error={deleteError}
        onConfirm={() => void doDelete()}
        onCancel={() => {
          setDeleteTarget(null)
          setDeleteError('')
        }}
      />

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
