import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { get, post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { useFormatTs } from '@/utils/datetime'
import { focusIsOrphaned } from '@/components/admin/restoreFocus'
import {
  AdminButton,
  Alert,
  Card,
  DescriptionList,
  EmptyState,
  Skeleton,
  StatusBadge,
  TextArea,
  VoteProgress,
  EDIT_REQUEST_STATUS_TONE,
  EDIT_REQUEST_STATUS_LABEL_KEYS,
  type DescriptionItem,
} from '@/components/admin'
import shell from '../Page.module.css'
import { useAdminPageHeader } from './header'
import type { RowLinkState } from './listParams'
import { getProposedField, getProposedFieldArray, type EditRequestItem } from './editRequests'
import { DiffView } from './DiffView'
import { contentFormatLabel, sameTags } from './versions'
import { emitAdminChange, useAdminChange } from './changes'

/**
 * 修改申请详情（/admin/edit-requests/:id）。
 *
 * 路由按 :id 整页重挂，组件实例即一次详情会话（见 AdminContributionDetail 的说明）。
 * 投票后原地刷新：投票不一定让申请离开当前状态（还差票），审核人要看到新的票数。
 */
export const AdminEditRequestDetail = () => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { id = '' } = useParams()
  const location = useLocation()
  const { permissions, user } = useAuth()

  const [backTo] = useState(() => {
    const from = (location.state as Partial<RowLinkState> | null)?.from
    return typeof from === 'string' ? from : '/admin/edit-requests'
  })

  const [detail, setDetail] = useState<EditRequestItem | null>(null)
  const [detailLoading, setDetailLoading] = useState(true)
  /** 打不开这一条（首次加载失败，或投票成功后读不回新状态）：整页换成错误态。 */
  const [loadError, setLoadError] = useState('')
  const [voteSubmitting, setVoteSubmitting] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [voteNote, setVoteNote] = useState('')
  /** 本页实例的身份：收到自己发出的变更广播时忽略。 */
  const [instance] = useState(() => ({}))

  /* 详情拉取的竞态守卫：投票后的重读与手动重试可能交错返回，只有最新一次请求能写入。 */
  const detailSeq = useRef(0)
  /* 详情会话序号：只在卸载时自增，在途投票据此判断用户是否已经离开。 */
  const sessionSeq = useRef(0)
  const sameSession = (session: number) => sessionSeq.current === session
  /* 提交锁的归属序号：卸载后旧投票的收尾不能再动锁。 */
  const voteSeqRef = useRef(0)

  /**
   * 拉取详情，返回本次请求的序号。
   * `keepOnError`：写操作**失败**后重读版本号时为 true——草稿还在、还要接着改，读不回来也别清掉视图。
   * 首次加载和投票**成功**后的重读失败时换成错误态：屏幕上那份的状态已经未知。
   */
  const fetchDetail = async (opts: { keepOnError?: boolean } = {}): Promise<number> => {
    const seq = ++detailSeq.current
    setDetailLoading(true)
    try {
      const result = await get<EditRequestItem>(`/admin/edit-requests/${encodeURIComponent(id)}`)
      if (seq !== detailSeq.current) return seq // 过期响应，丢弃
      if (result.ok) {
        setLoadError('')
        setDetail(result.data)
      } else if (opts.keepOnError) {
        setDetailError(result.error.message)
      } else {
        setDetail(null)
        setLoadError(result.error.message || t('adminEditRequests.loadError'))
      }
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false)
    }
    return seq
  }

  useEffect(() => {
    const detailRef = detailSeq
    const session = sessionSeq
    const vote = voteSeqRef
    // 拉取数据是 effect 对外部数据源的订阅；fetchDetail 首行的 setDetailLoading 属该模式的同步 setState
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchDetail()
    return () => {
      detailRef.current++
      session.current++
      vote.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleVote = async (vote: 'approve' | 'reject') => {
    if (!detail || voteSubmitting) return
    const session = sessionSeq.current
    const mySeq = ++voteSeqRef.current
    setVoteSubmitting(true)
    setDetailError('')
    try {
      const result = await post(`/admin/edit-requests/${encodeURIComponent(detail.id)}/vote`, {
        vote,
        note: voteNote.trim() || null,
        expectedVersion: detail.version,
        // 这一票基于屏幕上对照的那一版原投稿：后端发现原投稿已被改过就拒绝（409 CONTRIBUTION_CHANGED），
        // 决定性的一票不会覆盖投票人没看过的改动
        ...(typeof detail.contribution?.version === 'number'
          ? { expectedContributionVersion: detail.contribution.version }
          : {}),
      })
      /* 写成功就广播（哪怕已经离开）：当前挂着的列表 / 同一条详情要重读，旧会话本身不再动界面。 */
      if (result.ok) {
        emitAdminChange({ kind: 'editRequest', id: detail.id, source: instance })
        /* 决定性的一票会让后端把修改直接写进原投稿（routes/admin.ts 投票决议），投稿也变了：
           同时通知投稿列表 / 投稿详情重读。不知道这一票是否决定性，宁可多读一次。 */
        const contributionId = detail.contribution?.id ?? detail.contributionId
        if (contributionId) emitAdminChange({ kind: 'contribution', id: contributionId, source: instance })
      }
      if (!sameSession(session)) return
      if (result.ok) {
        /* 这一票已经用掉，备注显式清掉。keepOnError 用默认的 false：万一读不回新状态，
           屏幕上那份的状态就是未知的，留着它等于把一个还能再投一次的按钮交给用户。 */
        setVoteNote('')
        await fetchDetail()
      } else if (result.error.code === ERRORS.VERSION_CONFLICT || result.error.code === ERRORS.CONTRIBUTION_CHANGED) {
        // 版本冲突 / 原投稿已被改过：重读（对照随之刷新，保留草稿），提示写在重读**之后**，否则会拿旧版本号再撞一次
        const refreshedSeq = await fetchDetail({ keepOnError: true })
        if (detailSeq.current === refreshedSeq) {
          setDetailError(
            (cur) =>
              cur ||
              (result.error.code === ERRORS.CONTRIBUTION_CHANGED
                ? t('adminEditRequests.contributionChangedRefreshed')
                : t('admin.versionConflictRefreshed')),
          )
        }
      } else {
        setDetailError(result.error.message)
      }
    } finally {
      if (voteSeqRef.current === mySeq) setVoteSubmitting(false)
    }
  }

  /* 别处写成功了同一条：重读（投票不清草稿——这里的重读走默认路径，草稿备注不受影响）。 */
  useAdminChange((change) => {
    if (change.kind !== 'editRequest' || change.id !== id || change.source === instance) return
    void fetchDetail()
  })

  /* 打不开 → 重试成功：错误态里的重试按钮被换掉，焦点会掉到 body；只在焦点确实没人认领时接回 main。 */
  const hasDetail = detail !== null
  useEffect(() => {
    if (hasDetail && focusIsOrphaned()) document.getElementById('admin-main')?.focus({ preventScroll: true })
  }, [hasDetail])

  /* 后端的投票前置条件（routes/admin.ts /edit-requests/:id/vote）：申请仍在进行中、不是自己提交的、
     每人只能投一次。不满足的情况直接说明原因，而不是给一个点了必然报错的按钮。 */
  const isOwnRequest = !!user && !!detail?.requester?.id && detail.requester.id === user.id
  const hasVoted = !!detail?.myVote
  // 原投稿已删除：申请再也无法应用（后端投票返回 CONTRIBUTION_DELETED），不给必然失败的按钮
  const contributionDeleted = !!detail?.contribution?.deleted
  /* 进行中：pending，以及存量数据里的 in_review（后端两者都可投票） */
  const inProgress = detail?.status === 'pending' || detail?.status === 'in_review'
  const canVote =
    inProgress &&
    !isOwnRequest &&
    !hasVoted &&
    !contributionDeleted &&
    hasPermission(permissions, PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE)
  /* 投票成功后投票区整块卸载（已投过票），按钮上的焦点会掉到 body：没人认领时接回 main。 */
  useEffect(() => {
    if (!canVote && focusIsOrphaned()) document.getElementById('admin-main')?.focus({ preventScroll: true })
  }, [canVote])

  useAdminPageHeader({
    title: detail?.contribution?.title
      ? t('adminEditRequests.detailTitleFor', { title: detail.contribution.title })
      : t('adminEditRequests.detailTitle'),
    back: { to: backTo, label: t('adminEditRequests.backToList'), focusRow: id },
    badge: detail
      ? {
          tone: EDIT_REQUEST_STATUS_TONE[detail.status] ?? 'neutral',
          label: t(EDIT_REQUEST_STATUS_LABEL_KEYS[detail.status] ?? detail.status),
        }
      : undefined,
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

  const proposedTitle = getProposedField(detail, 'title', 'proposedTitle')
  const proposedSummary = getProposedField(detail, 'summary', 'proposedSummary')
  const proposedContent = getProposedField(detail, 'content', 'proposedContent')
  const proposedContentFormat = getProposedField(detail, 'contentFormat', 'proposedContentFormat')
  const proposedTags = getProposedFieldArray(detail, 'tags', 'proposedTags')
  const contributionId = detail.contribution?.id ?? detail.contributionId ?? null
  const required = detail.votes?.required ?? null
  /** 投票记录（按投票时间先后） */
  const history = detail.votes?.history ?? []
  /* 进行中的申请：离结论还差几票。阈值取接口回传的 votes.required，不在前端写死。 */
  const progressNote = (() => {
    if (detail.status === 'approved') return t('adminEditRequests.resolvedApproved')
    if (detail.status === 'rejected') return t('adminEditRequests.resolvedRejected')
    if (detail.status === 'withdrawn') return t('adminEditRequests.resolvedWithdrawn')
    if (detail.status === 'superseded') return t('adminEditRequests.resolvedSuperseded')
    if (!inProgress || !detail.votes) return null
    return t('adminEditRequests.remaining', {
      approve: Math.max(0, detail.votes.required - detail.votes.approve),
      reject: Math.max(0, detail.votes.required - detail.votes.reject),
    })
  })()
  const rulesValue = required
    ? t('adminRules.editRequest', { returnObjects: true, required })
    : t('adminRules.editRequestNoCount', { returnObjects: true })
  const rules = Array.isArray(rulesValue) ? rulesValue.filter((x): x is string => typeof x === 'string') : []

  const metaItems: DescriptionItem[] = [
    {
      term: t('adminEditRequests.contribution'),
      value: contributionId ? (
        // 原投稿已删除：详情页打不开，不给链接
        contributionDeleted ? (
          t('adminEditRequests.deletedContribution', { title: detail.contribution?.title || contributionId })
        ) : hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ) ? (
          <Link to={`/admin/contributions/${encodeURIComponent(contributionId)}`} className={shell.textLink}>
            {detail.contribution?.title || contributionId}
          </Link>
        ) : (
          detail.contribution?.title || contributionId
        )
      ) : (
        '—'
      ),
    },
    { term: t('adminEditRequests.requester'), value: detail.requester?.displayName || '—' },
    { term: t('adminEditRequests.version'), value: t('common.versionShort', { version: detail.version }) },
    { term: t('adminEditRequests.created'), value: formatTs(detail.createdAt) || '—' },
  ]

  /* 按后端通过时的写入规则（routes/admin.ts 投票决议）算出「实际会变什么」：
     - 标题、正文：非空才写入；
     - 摘要：申请里明确给了（字符串）才写入，空串 = 清空；null = 没改（申请时没填摘要）；
     - 标签：是数组就写入（空数组 = 清空）。
     值与对照基准相同的项不列出；会清空已有内容的项单独警示；正文按行对照。
     对照基准：进行中的申请用原投稿**当前**内容（通过时就是覆盖它）；已结束的申请（已通过 / 已拒绝 /
     已撤回 / 已失效）当前内容已不是申请当时的基础——通过的话改动已经写进去了，拿它对照只会显示「没有改动」——
     改用申请时的内容（baseSnapshot）。旧申请没有快照时不对照，只列出申请的内容。 */
  const open = detail.status === 'pending' || detail.status === 'in_review'
  const current = open
    ? detail.contribution
    : detail.baseSnapshot
      ? {
          title: detail.baseSnapshot.title,
          summary: detail.baseSnapshot.summary,
          contentRaw: detail.baseSnapshot.contentRaw,
          contentFormat: detail.baseSnapshot.contentFormat,
          tags: detail.baseSnapshot.tags,
        }
      : undefined
  const baseLabel = open ? t('adminEditRequests.currentValue') : t('adminEditRequests.baseValue')
  const sep = t('common.enumSeparator')
  const changes: Array<{
    key: string
    label: string
    current: string | null
    next: string
    clears: boolean
  }> = []
  if (proposedTitle && proposedTitle !== current?.title) {
    changes.push({
      key: 'title',
      label: t('adminEditRequests.proposedTitle'),
      current: current?.title ?? null,
      next: proposedTitle,
      clears: false,
    })
  }
  if (typeof proposedSummary === 'string' && (!current || proposedSummary !== (current.summary ?? ''))) {
    changes.push({
      key: 'summary',
      label: t('adminEditRequests.proposedSummary'),
      current: current ? (current.summary ?? '') : null,
      next: proposedSummary,
      clears: proposedSummary === '' && !!current?.summary,
    })
  }
  if (proposedContent && proposedContent !== current?.contentRaw) {
    changes.push({
      key: 'content',
      label: t('adminEditRequests.proposedContent'),
      // 接口带回了原正文就逐行对照；没带回时只能展示拟写入的全文
      current: typeof current?.contentRaw === 'string' ? current.contentRaw : null,
      next: proposedContent,
      clears: false,
    })
  }
  /* 正文格式：后端只在带了正文时写入格式（决定正文按 Markdown 还是纯文本渲染）。
     正文一字不改、只换格式，展示效果也会变，同样要列出来。 */
  if (proposedContent && proposedContentFormat && (!current || proposedContentFormat !== current.contentFormat)) {
    changes.push({
      key: 'contentFormat',
      label: t('adminVersions.contentFormat'),
      current: current?.contentFormat ? contentFormatLabel(t, current.contentFormat) : null,
      next: contentFormatLabel(t, proposedContentFormat),
      clears: false,
    })
  }
  if (Array.isArray(proposedTags) && (!current || !sameTags(proposedTags, current.tags))) {
    changes.push({
      key: 'tags',
      label: t('adminEditRequests.proposedTags'),
      current: current ? (current.tags ?? []).join(sep) : null,
      next: proposedTags.join(sep),
      clears: proposedTags.length === 0 && (current?.tags?.length ?? 0) > 0,
    })
  }

  /* 申请提交后原投稿又改了哪些字段（申请时的快照 vs 当前内容），其中哪些会被这份申请覆盖。
     只有进行中的申请才需要提醒；没有快照（旧申请）时退回到只说「内容改过」。 */
  const base = detail.baseSnapshot
  const live = detail.contribution
  const fieldsChangedSince =
    open && base && live
      ? [
          { key: 'title', label: t('adminContributions.titleLabel'), changed: base.title !== live.title },
          {
            key: 'summary',
            label: t('adminContributions.summary'),
            changed: (base.summary ?? '') !== (live.summary ?? ''),
          },
          { key: 'content', label: t('adminContributions.source'), changed: base.contentRaw !== live.contentRaw },
          {
            key: 'contentFormat',
            label: t('adminVersions.contentFormat'),
            changed: !!live.contentFormat && base.contentFormat !== live.contentFormat,
          },
          {
            key: 'tags',
            label: t('adminContributions.tags'),
            changed: !sameTags(base.tags, live.tags),
          },
        ].filter((f) => f.changed)
      : null
  const overwritten = fieldsChangedSince?.filter((f) => changes.some((c) => c.key === f.key)) ?? []

  return (
    <div className={shell.page}>
      <div className={shell.detailGrid}>
        <Card className={shell.detailInfo}>
          <DescriptionList items={metaItems} columns={2} />
        </Card>

        <div className={shell.detailMain}>
          {contributionDeleted && inProgress && (
            <Alert tone="error">{t('adminEditRequests.contributionDeleted')}</Alert>
          )}
          {/* 申请提交后原投稿的内容又被改过：下面的对照以当前内容为准，通过会覆盖那些改动 */}
          {detail.contribution?.contentChangedSinceRequest &&
            open &&
            (fieldsChangedSince && fieldsChangedSince.length > 0 ? (
              <Alert tone="info">
                {t('adminEditRequests.fieldsChangedSinceRequest', {
                  fields: fieldsChangedSince.map((f) => f.label).join(sep),
                })}
                {overwritten.length > 0
                  ? t('adminEditRequests.fieldsWillBeOverwritten', {
                      fields: overwritten.map((f) => f.label).join(sep),
                    })
                  : t('adminEditRequests.fieldsNotOverwritten')}
              </Alert>
            ) : (
              <Alert tone="info">{t('adminEditRequests.contentChangedSinceRequest')}</Alert>
            ))}
          <section className={shell.field} aria-labelledby="edit-request-reason">
            <h2 id="edit-request-reason" className={shell.fieldLabel}>
              {t('adminEditRequests.reason')}
            </h2>
            <p className={shell.contentBlock}>{detail.reason}</p>
          </section>

          {/* 提议的改动：按后端「通过时实际写入什么」来展示（routes/admin.ts 投票决议）：
              标题、正文非空才写；摘要明确给了才写（空串 = 清空）；标签是数组就写（空数组 = 清空）。
              每项给出「当前 → 改为」，正文逐行对照，清空用错误色警示。 */}
          {!open && (
            <p className={shell.subtleNote}>
              {detail.baseSnapshot
                ? t('adminEditRequests.comparedWithBase', { version: detail.baseSnapshot.version })
                : t('adminEditRequests.noBaseSnapshot')}
            </p>
          )}
          {changes.length === 0 ? (
            <p className={shell.subtleNote}>
              {open ? t('adminEditRequests.noEffectiveChange') : t('adminEditRequests.noChangeFromBase')}
            </p>
          ) : (
            changes.map((change) => (
              <section key={change.key} className={shell.field} aria-labelledby={`proposal-${change.key}`}>
                <h2 id={`proposal-${change.key}`} className={shell.fieldLabel}>
                  {change.label}
                </h2>
                {change.clears && (
                  <Alert tone="error">{t('adminEditRequests.willClear', { field: change.label })}</Alert>
                )}
                {change.key === 'content' ? (
                  change.current !== null ? (
                    <DiffView
                      before={change.current}
                      after={change.next}
                      label={change.label}
                      beforeLabel={baseLabel}
                      afterLabel={t('adminEditRequests.nextValue')}
                    />
                  ) : (
                    <pre className={shell.rawSource} tabIndex={0} aria-label={change.label}>
                      {change.next}
                    </pre>
                  )
                ) : (
                  <>
                    {change.current !== null && (
                      <p className={shell.diffOld}>
                        <span className={shell.diffTag}>{baseLabel}</span>
                        {change.current || '—'}
                      </p>
                    )}
                    <p className={shell.contentBlock}>
                      <span className={shell.diffTag}>{t('adminEditRequests.nextValue')}</span>
                      {change.next || t('adminEditRequests.emptyValue')}
                    </p>
                  </>
                )}
              </section>
            ))
          )}
        </div>

        <div className={shell.detailSide}>
          <Card>
            <div className={shell.stackSm}>
              <h2 className={shell.sideHeading}>{t('adminEditRequests.voteProgress')}</h2>
              {detail.votes ? (
                <VoteProgress
                  approve={detail.votes.approve}
                  reject={detail.votes.reject}
                  required={detail.votes.required}
                  total={detail.votes.total}
                  approveLabel={t('adminEditRequests.voteApprove')}
                  rejectLabel={t('adminEditRequests.voteReject')}
                  thresholdLabel={t('adminEditRequests.votesRequired')}
                />
              ) : (
                <p className={shell.subtleNote}>{t('adminEditRequests.noVotes')}</p>
              )}
              {progressNote && <p className={shell.noteText}>{progressNote}</p>}

              {/* 谁投了、投的什么、理由是什么：紧跟进度条，不放到侧栏最底下 */}
              <section className={shell.voteRecords} aria-labelledby="vote-records-heading">
                <h3 id="vote-records-heading" className={shell.voteRecordsHeading}>
                  {t('adminEditRequests.voteHistoryCount', { count: history.length })}
                </h3>
                {history.length === 0 ? (
                  <p className={shell.subtleNote}>{t('adminEditRequests.noVotes')}</p>
                ) : (
                  <ul className={shell.recordList}>
                    {history.map((v) => (
                      <li key={`${v.reviewerId}-${v.createdAt}`} className={shell.recordItem}>
                        <div className={shell.recordHead}>
                          <span className={shell.recordName}>
                            {v.displayName || t('adminEditRequests.unknownVoter')}
                          </span>
                          <StatusBadge
                            tone={v.vote === 'approve' ? 'green' : 'red'}
                            label={
                              v.vote === 'approve'
                                ? t('adminEditRequests.voteApprove')
                                : t('adminEditRequests.voteReject')
                            }
                            size="sm"
                          />
                          <time className={shell.recordTime} dateTime={new Date(v.createdAt).toISOString()}>
                            {formatTs(v.createdAt)}
                          </time>
                        </div>
                        <p className={v.note ? shell.recordNote : shell.recordNoteEmpty}>
                          {v.note || t('adminEditRequests.noNote')}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {detail.myVote && (
                <p className={shell.subtleNote}>
                  {t('adminEditRequests.votedOnce', {
                    vote:
                      detail.myVote === 'approve'
                        ? t('adminEditRequests.voteApprove')
                        : t('adminEditRequests.voteReject'),
                  })}
                </p>
              )}
              {isOwnRequest && inProgress && <p className={shell.subtleNote}>{t('adminEditRequests.ownRequest')}</p>}

              {detailError && <Alert tone="error">{detailError}</Alert>}

              {canVote && (
                <>
                  {/* 提交期间冻结：请求带走的是点按钮那一刻的备注，此时还能改的话，
                    屏幕上显示的和实际发出去的不是同一份，成功后还会清掉刚敲的新内容。 */}
                  <TextArea
                    label={t('adminEditRequests.voteNoteLabel')}
                    value={voteNote}
                    disabled={voteSubmitting}
                    onChange={(e) => setVoteNote(e.target.value)}
                    placeholder={t('adminEditRequests.voteNotePlaceholder')}
                  />
                  <div className={shell.actions}>
                    <AdminButton
                      variant="primary"
                      onClick={() => handleVote('approve')}
                      loading={voteSubmitting}
                      disabled={detailLoading}
                    >
                      {t('adminEditRequests.voteApprove')}
                    </AdminButton>
                    <AdminButton
                      variant="danger"
                      onClick={() => handleVote('reject')}
                      loading={voteSubmitting}
                      disabled={detailLoading}
                    >
                      {t('adminEditRequests.voteReject')}
                    </AdminButton>
                  </div>
                </>
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
        </div>
      </div>
    </div>
  )
}
