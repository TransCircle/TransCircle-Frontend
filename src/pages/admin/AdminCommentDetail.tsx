import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get, post } from '@/api/client'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { ERRORS } from '@/api/errors'
import { useStepUpAction } from '@/hooks/useStepUpAction'
import { useFormatTs } from '@/utils/datetime'
import { focusIsOrphaned } from '@/components/admin/restoreFocus'
import {
  AdminButton,
  Alert,
  Card,
  DescriptionList,
  EmptyState,
  Pill,
  ReasonPromptDialog,
  SectionLabel,
  Skeleton,
  StatusBadge,
  type BadgeTone,
  type DescriptionItem,
} from '@/components/admin'
import shell from '../Page.module.css'
import { useAdminPageHeader } from './header'
import type { RowLinkState } from './listParams'
import { emitAdminChange, useAdminChange } from './changes'
import { setReturnIntent } from './returnIntent'

type CommentStatus = 'visible' | 'hidden' | 'deleted'

interface PersonRef {
  id: string
  displayName: string
}

/** 父评论 / 回复的摘要（后端 §5A.7 parent、replies.items） */
interface CommentBrief {
  id: string
  author: PersonRef
  /** 已删除的评论为 null */
  content: string | null
  status: CommentStatus
  /** 审核状态是否为隐藏，与是否已删除无关（先被隐藏、后被作者删除的父评论 status 为 deleted，但仍挡着它下面的回复） */
  isHidden?: boolean
  createdAt: number
}

interface CommentDetail {
  id: string
  contributionId: string
  /** 投稿行已不存在时为 null；已删除时 deleted=true */
  contribution: { id: string; title: string; status: string; deleted: boolean } | null
  author: PersonRef & { avatarUrl: string | null }
  content: string | null
  parentId: string | null
  status: CommentStatus
  /** 仅隐藏中的评论；cascaded = 上级评论被隐藏时连带隐藏（没有单独的原因） */
  hidden: { by: PersonRef | null; reason: string | null; cascaded: boolean } | null
  parent: CommentBrief | null
  /** 仅顶层评论：visible = 隐藏时会一起隐藏的，cascaded = 恢复时会一起恢复的 */
  replies: { total: number; visible: number; cascaded: number; items: CommentBrief[] } | null
  reportCount: number
  reports: Array<{ id: string; reason: string; reporter: PersonRef; createdAt: number }>
  history: Array<{
    id: string
    action: 'hide' | 'restore'
    actor: PersonRef | null
    reason: string | null
    createdAt: number
  }>
  deletedAt: number | null
  createdAt: number
  updatedAt: number
}

const STATUS_TONE: Record<CommentStatus, BadgeTone> = {
  visible: 'green',
  hidden: 'amber',
  deleted: 'muted',
}

const STATUS_LABEL_KEYS: Record<CommentStatus, string> = {
  visible: 'adminComments.statusVisible',
  hidden: 'adminComments.statusHidden',
  deleted: 'adminComments.statusDeleted',
}

/** 隐藏原因 1–200 字（routes/comments.ts handleHideRestore） */
const HIDE_REASON_MAX = 200

/**
 * 评论详情（/admin/comments/:id）。
 *
 * 处理一条评论的依据都在这里：完整正文、它回复的评论或它下面的回复、每条举报的理由、
 * 当前的隐藏信息与历次处理记录。隐藏 / 恢复只在这里做——列表只放得下一行摘要，看不到这些就下判断不稳妥。
 * 路由按 :id 整页重挂，组件实例即一次详情会话（见 AdminContributionDetail）。
 */
export const AdminCommentDetail = () => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { id = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { accessToken, permissions } = useAuth()
  // 隐藏需要二次验证：返回 STEP_UP_REQUIRED 时弹 step-up 并重放
  const { runWithStepUp, stepUpElement } = useStepUpAction(accessToken)

  const [origin] = useState(() => {
    const from = (location.state as Partial<RowLinkState> | null)?.from
    const fromList = typeof from === 'string' ? from : null
    return {
      backTo: fromList ?? '/admin/comments',
      /* 从列表行点进来的：处理完用 back() 退回那个列表（不在历史里堆一条重复的列表）。
         从别处进来（父评论 / 回复的链接、审计日志、直接打开）没有来源列表：处理完留在原地。 */
      canGoBack: fromList !== null && ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0,
    }
  })

  const [detail, setDetail] = useState<CommentDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(true)
  /** 打不开这条评论（首次加载失败，或操作成功后读不回新状态）：整页换成错误态。 */
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  /** 留在原地处理成功时的提示（没有来源列表可退回）。 */
  const [actionDone, setActionDone] = useState('')
  const [hideDialogOpen, setHideDialogOpen] = useState(false)
  const [hideReason, setHideReason] = useState('')
  const [hideError, setHideError] = useState('')
  /** 本页实例的身份：收到自己发出的变更广播时忽略。 */
  const [instance] = useState(() => ({}))

  /* 隐藏 / 恢复的进行中锁：避免重复写；step-up 只有一个待重放槽位，并发两次会互相覆盖。 */
  const [actionSubmitting, setActionSubmitting] = useState(false)
  const actionSeqRef = useRef(0)
  /* 详情拉取的竞态守卫，只有最新一次请求能写入。 */
  const detailSeq = useRef(0)
  /* 详情会话序号：只在卸载时自增。用户已经离开时，step-up 不再弹、错误不再写、不再跳转。 */
  const sessionSeq = useRef(0)
  const sameSession = (session: number) => sessionSeq.current === session
  /* 隐藏理由弹窗是对着打开那一刻的版本写的：期间评论变了（别人隐藏了、作者删了），不能换成新版本号照样提交——
     那样「已隐藏」会直接返回成功，填的理由却没生效。null = 弹窗没开。 */
  const hideVersionRef = useRef<number | null>(null)

  const fetchDetail = async () => {
    const seq = ++detailSeq.current
    setDetailLoading(true)
    try {
      const result = await get<CommentDetail>(`/admin/comments/${encodeURIComponent(id)}`)
      if (seq !== detailSeq.current) return // 过期响应，丢弃
      if (result.ok) {
        setLoadError('')
        setDetail(result.data)
        const opened = hideVersionRef.current
        if (opened !== null && (result.data.status !== 'visible' || result.data.updatedAt !== opened)) {
          hideVersionRef.current = null
          setHideDialogOpen(false)
          setActionError(t('adminComments.changedWhileHiding'))
        }
      } else {
        // 理由弹窗属于这条评论，详情换成错误态时一起收掉
        hideVersionRef.current = null
        setHideDialogOpen(false)
        setDetail(null)
        setLoadError(result.error.message || t('adminComments.loadError'))
      }
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false)
    }
  }

  useEffect(() => {
    const detailRef = detailSeq
    const session = sessionSeq
    const action = actionSeqRef
    void fetchDetail()
    return () => {
      detailRef.current++
      session.current++
      action.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 处理成功后：从列表来的退回列表（带提示、聚焦原行）；否则原地重读并提示。 */
  const settle = async (action: 'hide' | 'restore') => {
    const toast = action === 'hide' ? 'comment_hidden' : 'comment_restored'
    if (origin.canGoBack) {
      setReturnIntent({ href: origin.backTo, focusRow: id, toast })
      navigate(-1)
      return
    }
    await fetchDetail()
    setActionDone(t(action === 'hide' ? 'common.toast.commentHidden' : 'common.toast.commentRestored'))
  }

  /** 隐藏 / 恢复共用的流程：expectedVersion 是做决定时看到的那一版，STEP_UP_REQUIRED 交给 step-up 重放。 */
  const runAction = async (action: 'hide' | 'restore', body: Record<string, unknown>, expectedVersion: number) => {
    if (!detail || actionSubmitting) return
    const commentId = detail.id
    const parentId = detail.parentId
    const session = sessionSeq.current
    const mySeq = ++actionSeqRef.current
    setActionSubmitting(true)
    setActionError('')
    setActionDone('')
    let handedOff = false
    const attempt = async () => {
      const result = await post(`/admin/comments/${encodeURIComponent(commentId)}/${action}`, {
        ...body,
        expectedVersion,
      })
      /* 写成功就广播（哪怕已经离开）：挂着的列表、同一条评论 / 它的上级 / 它的回复的详情要重读。 */
      if (result.ok) emitAdminChange({ kind: 'comment', id: commentId, parentId, source: instance })
      if (!sameSession(session)) return
      if (result.ok) {
        await settle(action)
      } else if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
        handedOff = true
        runWithStepUp(attempt, () => {
          if (actionSeqRef.current === mySeq) setActionSubmitting(false)
        })
      } else if (
        result.error.code === ERRORS.VERSION_CONFLICT ||
        result.error.code === 'INVALID_STATE_TRANSITION' ||
        result.error.code === 'COMMENT_NOT_FOUND'
      ) {
        /* 别人刚处理过 / 作者刚删了：手里的状态已经过期，原样再点只会再撞一次。重读给出最新状态再决定。 */
        await fetchDetail()
        if (sameSession(session)) setActionError(t('admin.versionConflictRefreshed'))
      } else {
        setActionError(
          result.error.message || t(action === 'hide' ? 'adminComments.hideError' : 'adminComments.restoreError'),
        )
      }
    }
    try {
      await attempt()
    } finally {
      if (!handedOff && actionSeqRef.current === mySeq) setActionSubmitting(false)
    }
  }

  const openHide = () => {
    if (!detail || detail.status !== 'visible') return
    hideVersionRef.current = detail.updatedAt
    setHideReason('')
    setHideError('')
    setActionError('')
    setActionDone('')
    setHideDialogOpen(true)
  }

  const closeHide = () => {
    hideVersionRef.current = null
    setHideDialogOpen(false)
    setHideError('')
  }

  const submitHide = async () => {
    const reason = hideReason.trim()
    if (!reason) {
      setHideError(t('adminComments.reasonRequired'))
      return
    }
    if (reason.length > HIDE_REASON_MAX) {
      setHideError(t('adminComments.reasonTooLong'))
      return
    }
    const version = hideVersionRef.current
    if (actionSubmitting || version === null) return
    closeHide()
    await runAction('hide', { reason }, version)
  }

  /* 别处（另一个详情实例）处理了：这一条；它的上级（隐藏 / 恢复上级会连带它）；它的任一条回复（「会连带几条」随之变）。
     回复按广播带的 parentId 认，不按截断后的回复列表。还在首次加载时一律重读——那次读可能早于这次写。 */
  useAdminChange((change) => {
    if (change.kind !== 'comment' || change.source === instance) return
    if (!detail) {
      if (!loadError) void fetchDetail()
      return
    }
    if (change.id === id || change.id === detail.parentId || change.parentId === id) void fetchDetail()
  })

  /* 打不开 → 重试成功：错误态里的重试按钮被换掉，焦点会掉到 body；只在焦点确实没人认领时接回 main。 */
  const hasDetail = detail !== null
  useEffect(() => {
    if (hasDetail && focusIsOrphaned()) document.getElementById('admin-main')?.focus({ preventScroll: true })
  }, [hasDetail])

  useAdminPageHeader({
    title: detail
      ? t('adminComments.detailTitle', { name: detail.author.displayName })
      : t('adminComments.detailTitleLoading'),
    back: { to: origin.backTo, label: t('adminComments.backToList'), focusRow: id },
    badge: detail ? { tone: STATUS_TONE[detail.status], label: t(STATUS_LABEL_KEYS[detail.status]) } : undefined,
  })

  if (!detail && loadError) {
    return (
      <div className={shell.page}>
        <EmptyState
          title={loadError}
          /* 返回入口在标题栏里，这里只给重试 */
          action={
            <AdminButton variant="primary" onClick={() => void fetchDetail()} loading={detailLoading}>
              {t('common.retry')}
            </AdminButton>
          }
        />
      </div>
    )
  }

  if (!detail) {
    return (
      <div className={shell.page} aria-busy="true">
        <Skeleton variant="card" />
      </div>
    )
  }

  const canOpenUsers = hasPermission(permissions, PERMISSIONS.USER_READ)
  const canOpenContribution = hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ)

  const personLink = (person: PersonRef): ReactNode =>
    canOpenUsers ? (
      <Link to={`/admin/users/${encodeURIComponent(person.id)}`} className={shell.textLink}>
        {person.displayName}
      </Link>
    ) : (
      person.displayName
    )

  const time = (ts: number) => (
    <time className={shell.recordTime} dateTime={new Date(ts).toISOString()}>
      {formatTs(ts)}
    </time>
  )

  /* 所属投稿：有投稿读取权限且没被删除时链到后台投稿详情；投稿行已不存在时说明情况，不拿 ID 充当名称 */
  const contributionValue: ReactNode = !detail.contribution ? (
    <span className={shell.auditMuted}>{t('adminComments.contributionMissing')}</span>
  ) : (
    <span className={shell.inlineMeta}>
      {canOpenContribution && !detail.contribution.deleted ? (
        <Link to={`/admin/contributions/${encodeURIComponent(detail.contribution.id)}`} className={shell.textLink}>
          {detail.contribution.title}
        </Link>
      ) : (
        detail.contribution.title
      )}
      {detail.contribution.deleted && <span className={shell.auditMuted}>{t('adminAuditLogs.deleted')}</span>}
    </span>
  )

  const metaItems: DescriptionItem[] = [
    { term: t('adminComments.author'), value: personLink(detail.author) },
    { term: t('adminComments.postedAt'), value: formatTs(detail.createdAt) || '—' },
    {
      term: t('adminComments.kind'),
      value: detail.parentId ? t('adminComments.kindReply') : t('adminComments.kindTopLevel'),
    },
    { term: t('adminComments.reportCount'), value: detail.reportCount },
    { term: t('adminComments.contribution'), value: contributionValue },
  ]

  const isTopLevel = detail.parentId === null
  const canHide = detail.status === 'visible'
  const canRestore = detail.status === 'hidden'
  /* 上级评论的审核状态为隐藏（含「先被隐藏、后被作者删除」）：公开评论区只显示可见的顶层评论下的回复 */
  const parentHidden = detail.parent ? (detail.parent.isHidden ?? detail.parent.status === 'hidden') : false

  /* 规则说明：按当前状态写清点下去的真实后果（routes/comments.ts handleHideRestore；公开评论区只显示可见的顶层评论及其可见回复） */
  const rules: string[] = []
  if (canHide) {
    rules.push(t('adminComments.ruleHideStepUp'))
    if (!isTopLevel) rules.push(t('adminComments.ruleHideReply'))
    else if ((detail.replies?.visible ?? 0) > 0)
      rules.push(t('adminComments.ruleHideCascade', { count: detail.replies?.visible ?? 0 }))
    else rules.push(t('adminComments.ruleHideNoReplies'))
    rules.push(t('adminComments.ruleHideReason'))
  } else if (canRestore) {
    rules.push(t('adminComments.ruleRestoreNoStepUp'))
    if (isTopLevel) {
      rules.push(
        (detail.replies?.cascaded ?? 0) > 0
          ? t('adminComments.ruleRestoreCascade', { count: detail.replies?.cascaded ?? 0 })
          : t('adminComments.ruleRestoreNoCascade'),
      )
    } else if (parentHidden) {
      rules.push(
        t(
          detail.parent?.status === 'deleted'
            ? 'adminComments.ruleRestoreParentHiddenDeleted'
            : 'adminComments.ruleRestoreParentHidden',
        ),
      )
    }
  }

  const briefItem = (c: CommentBrief, linkLabel: string) => (
    <li key={c.id} className={shell.recordItem}>
      <div className={shell.recordHead}>
        <span className={shell.recordName}>{c.author.displayName}</span>
        <StatusBadge tone={STATUS_TONE[c.status]} label={t(STATUS_LABEL_KEYS[c.status])} size="sm" />
        {time(c.createdAt)}
      </div>
      <p className={c.content ? shell.recordNoteClamp : shell.recordNoteEmpty}>
        {c.content ?? t('comment.deletedPlaceholder')}
      </p>
      <Link to={`/admin/comments/${encodeURIComponent(c.id)}`} className={`${shell.textLink} ${shell.recordLink}`}>
        {linkLabel}
      </Link>
    </li>
  )

  return (
    <div className={shell.page}>
      <div className={shell.detailGrid}>
        <Card className={shell.detailInfo}>
          <DescriptionList items={metaItems} columns={2} />
        </Card>

        <div className={shell.detailMain}>
          <Card>
            <SectionLabel>{t('adminComments.contentHeading')}</SectionLabel>
            {detail.content !== null ? (
              <p className={shell.commentBody}>{detail.content}</p>
            ) : (
              <p className={shell.subtleNote}>{t('adminComments.contentDeleted')}</p>
            )}
          </Card>

          {/* 回复的上下文：这条是回复时给出它回复的评论；是顶层评论时列出它下面的回复（隐藏时会被连带） */}
          {detail.parent && (
            <Card tone="subtle">
              <SectionLabel>{t('adminComments.parentHeading')}</SectionLabel>
              <ul className={shell.recordList}>{briefItem(detail.parent, t('adminComments.openParent'))}</ul>
            </Card>
          )}

          {detail.replies && detail.replies.total > 0 && (
            <Card>
              <SectionLabel>{t('adminComments.repliesHeading', { count: detail.replies.total })}</SectionLabel>
              <ul className={shell.recordList}>
                {detail.replies.items.map((r) => briefItem(r, t('adminComments.openReply')))}
              </ul>
              {detail.replies.total > detail.replies.items.length && (
                <p className={shell.subtleNoteSpaced}>
                  {t('adminComments.repliesTruncated', { shown: detail.replies.items.length })}
                </p>
              )}
            </Card>
          )}

          <Card>
            <SectionLabel>{t('adminComments.reportsHeading', { count: detail.reportCount })}</SectionLabel>
            {detail.reports.length === 0 ? (
              <p className={shell.subtleNote}>{t('adminComments.noReports')}</p>
            ) : (
              <ul className={shell.recordList}>
                {detail.reports.map((r) => (
                  <li key={r.id} className={shell.recordItem}>
                    <div className={shell.recordHead}>
                      <span className={shell.recordName}>{r.reporter.displayName}</span>
                      {time(r.createdAt)}
                    </div>
                    <p className={shell.recordNote}>{r.reason}</p>
                  </li>
                ))}
              </ul>
            )}
            {detail.reportCount > detail.reports.length && (
              <p className={shell.subtleNoteSpaced}>
                {t('adminComments.reportsTruncated', { shown: detail.reports.length })}
              </p>
            )}
          </Card>
        </div>

        <div className={shell.detailSide}>
          <Card>
            <div className={shell.stackSm}>
              <h2 className={shell.sideHeading}>{t('adminComments.actionsHeading')}</h2>
              {actionError && <Alert tone="error">{actionError}</Alert>}
              {actionDone && <Alert tone="success">{actionDone}</Alert>}

              {detail.hidden && (
                <DescriptionList
                  columns={1}
                  items={[
                    {
                      term: t('adminComments.hiddenBy'),
                      value: detail.hidden.by ? personLink(detail.hidden.by) : '—',
                    },
                    {
                      term: t('adminComments.hiddenReason'),
                      value: detail.hidden.cascaded ? (
                        <span className={shell.inlineMeta}>
                          {t('adminComments.hiddenCascaded')}
                          {detail.parentId && (
                            <Link
                              to={`/admin/comments/${encodeURIComponent(detail.parentId)}`}
                              className={shell.textLink}
                            >
                              {t('adminComments.openParent')}
                            </Link>
                          )}
                        </span>
                      ) : (
                        detail.hidden.reason || '—'
                      ),
                    },
                  ]}
                />
              )}

              {detail.status === 'deleted' && <p className={shell.subtleNote}>{t('adminComments.deletedNoAction')}</p>}

              {(canHide || canRestore) && (
                <div className={shell.actions}>
                  {canHide && (
                    <AdminButton variant="danger" disabled={actionSubmitting || detailLoading} onClick={openHide}>
                      {t('adminComments.hide')}
                    </AdminButton>
                  )}
                  {canRestore && (
                    <AdminButton
                      variant="primary"
                      loading={actionSubmitting}
                      disabled={detailLoading}
                      onClick={() => void runAction('restore', {}, detail.updatedAt)}
                    >
                      {t('adminComments.restore')}
                    </AdminButton>
                  )}
                </div>
              )}

              {rules.length > 0 && (
                <ul className={shell.ruleList} aria-label={t('adminRules.heading')}>
                  {rules.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          {detail.history.length > 0 && (
            <Card tone="subtle" padding="sm">
              <SectionLabel>{t('adminComments.historyHeading')}</SectionLabel>
              <ul className={shell.recordList}>
                {detail.history.map((h) => (
                  <li key={h.id} className={shell.recordItem}>
                    <div className={shell.recordHead}>
                      <span className={shell.recordName}>
                        {h.actor?.displayName ?? t('adminAuditLogs.actorSystem')}
                      </span>
                      <Pill>
                        {t(h.action === 'hide' ? 'adminComments.historyHide' : 'adminComments.historyRestore')}
                      </Pill>
                      {time(h.createdAt)}
                    </div>
                    {h.reason && <p className={shell.recordNote}>{h.reason}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <ReasonPromptDialog
        open={hideDialogOpen}
        title={t('adminComments.hideTitle')}
        prompt={t('adminComments.hidePrompt')}
        placeholder={t('adminComments.hidePlaceholder')}
        value={hideReason}
        onChange={setHideReason}
        onSubmit={submitHide}
        onCancel={closeHide}
        submitText={t('adminComments.hide')}
        cancelText={t('admin.cancelReason')}
        maxLength={HIDE_REASON_MAX}
        counterText={t('admin.ui.charCount', { n: hideReason.length, max: HIDE_REASON_MAX })}
        error={hideError || undefined}
        variant="danger"
      />

      {stepUpElement}
    </div>
  )
}
