import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { get, post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { useAuth } from '@/context/useAuth'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { usePagedList } from '@/hooks/usePagedList'
import { limitByUnicode } from '@/utils/string'
import {
  AdminButton,
  Alert,
  Card,
  DescriptionList,
  EmptyState,
  SectionLabel,
  Skeleton,
  StatusBadge,
  Tabs,
  TextArea,
  VoteProgress,
  EDIT_REQUEST_STATUS_TONE,
  EDIT_REQUEST_STATUS_LABEL_KEYS,
  type DescriptionItem,
  type TabItem,
} from '@/components/admin'
import { Pagination } from '@/components/ui'
import shell from './Page.module.css'

interface EditRequestItem {
  id: string
  status: string
  version: number
  reason: string
  requester: {
    id: string
    displayName: string
  }
  // Nested structure (api.md §10.5)
  contribution?: {
    id: string
    title: string
  }
  proposed?: {
    title?: string | null
    summary?: string | null
    content?: string | null
    tags?: string[] | null
  } | null
  votes?: {
    approve: number
    reject: number
    total: number
    required: number
    history?: Array<{
      vote: string
      note: string | null
      reviewerId: string
      createdAt: number
    }>
  }
  myVote?: string | null
  // Legacy flat fields for backward compat during migration
  contributionId?: string
  proposedTitle?: string | null
  proposedContent?: string | null
  proposedSummary?: string | null
  proposedTags?: string[] | null
  createdAt: number
  updatedAt: number
}

import { useFormatTs } from '@/utils/datetime'
import { useDetailFocus } from '@/hooks/useDetailFocus'

/**
 * Safely read a proposed-change field, preferring the typed `proposed` sub-object
 * and falling back to the legacy flat field.
 */
/** @deprecated 旧扁平字段映射（迁移兼容），使用属性存在性检查替代 any 断言 */
type OldFlatFieldMap = Record<string, string | string[] | null | undefined>

function getProposedField(
  detail: EditRequestItem | null,
  nestedKey: keyof NonNullable<EditRequestItem['proposed']>,
  flatKey: string,
): string | null | undefined {
  if (!detail) return undefined
  const nested = detail.proposed?.[nestedKey]
  if (typeof nested === 'string') return nested
  if (nested === null) return null
  // 旧扁平结构回退：检查 key 存在后再读取
  const old = detail as unknown as OldFlatFieldMap
  return flatKey in detail ? (old[flatKey] as string | undefined) : undefined
}

function getProposedFieldArray(
  detail: EditRequestItem | null,
  nestedKey: keyof NonNullable<EditRequestItem['proposed']>,
  flatKey: string,
): string[] | null | undefined {
  if (!detail) return undefined
  const nested = detail.proposed?.[nestedKey]
  if (Array.isArray(nested)) return nested
  if (nested === null) return null
  // 旧扁平结构回退
  const old = detail as unknown as OldFlatFieldMap
  return flatKey in detail ? (old[flatKey] as string[] | undefined) : undefined
}

export const AdminEditRequests = () => {
  const { t } = useTranslation()
  const { accessToken, loading: authLoading, permissions } = useAuth()
  const formatTs = useFormatTs()

  // 编辑申请状态筛选：pending / approved / rejected / applied / superseded
  const [statusFilter, setStatusFilter] = useState('pending')

  // 游标分页列表（统一模板）：切 tab（statusFilter 变化）自动重载，保留旧列表 + 加载条
  const { items, pageIndex, knownPages, hasMore, stale, staleResults, loading, error, setError: setListError, reload, refresh, goToPage } = usePagedList<EditRequestItem>({
    fetchPage: async (cursorVal) => {
      const params = new URLSearchParams({ limit: '20', status: statusFilter })
      if (cursorVal) params.set('cursor', cursorVal)
      const result = await get<EditRequestItem[]>(`/admin/edit-requests?${params}`, {
        /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
      })
      if (!result.ok) throw new Error(result.error.message)
      return {
        data: result.data,
        nextCursor: result.pagination?.nextCursor ?? null,
        hasMore: result.pagination?.hasMore ?? false,
      }
    },
    deps: [authLoading, accessToken, statusFilter],
    autoLoad: false,
  })

  // 首载/切 tab：auth 就绪后由 effect 触发（gate authLoading/accessToken）
  useEffect(() => {
    if (authLoading || !accessToken) return
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accessToken, statusFilter])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<EditRequestItem | null>(null)
  // 行点击→详情拉取中的 pending 反馈（loading-04）
  const [detailLoading, setDetailLoading] = useState(false)
  const [voteSubmitting, setVoteSubmitting] = useState(false)
  /* 详情侧的错误自成一路，不能和列表的 error 共用一个通道。
     列表那份由 usePagedList 维护，每次加载都会先 setError('')；而详情里的写操作
     在后台会触发一次列表刷新（哪怕用户已经离开那条详情），刷新一开始就把详情
     刚显示出来的失败提示无声清掉了——用户以为操作成功了。 */
  const [detailError, setDetailError] = useState('')

  const [voteNote, setVoteNote] = useState('')

  /* 详情拉取的竞态守卫：快速连点两行时，先发的响应可能后到并覆盖后发的；
     投票/封禁后的重拉同理。只有最新一次请求可以写入详情状态。 */
  const detailSeq = useRef(0)

  /* 详情会话守卫。**同步**写入，不用 effect 同步：写操作的响应可能在同一轮
     事件循环的后续 microtask 里就到达，而 effect 要等下一次提交后才跑，
     那时 ref 还是旧 id，守卫会失效。 */
  const selectedIdRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  /* 详情会话守卫。只比 id 是不够的：返回列表后再打开同一条申请，id 一模一样，
     但已经是另一次会话——旧投票的回调会清掉新会话里刚写的备注、并重拉详情。
     detailSeq 在每次打开详情、返回列表、组件卸载时自增，捕获它即可区分。 */
  /* 详情**会话**序号，与 detailSeq（详情**请求**竞态序号）是两回事，不能复用：
       · detailSeq —— 每次 fetchDetail 都自增，用来丢弃过期的详情响应；
       · sessionSeq —— 只在「打开另一条 / 返回列表 / 卸载」时自增，标识用户
         正在看的是哪一次会话。
     混用会出这样的错：一次重读（旧操作成功后刷新当前这条）也会自增 detailSeq，
     于是当前正在进行的写操作会以为「用户已经离开」，随后的 step-up 和错误提示
     全被静默丢弃。 */
  const sessionSeq = useRef(0)
  /* 列表 ↔ 详情的键盘焦点接力，见 useDetailFocus 的说明。 */
  const { backRef, focusRowOnReturn } = useDetailFocus(!!selectedId && !!detail && !detailLoading, sessionSeq)
  const sameSession = (session: number) => sessionSeq.current === session

  /** 屏幕上打开的是否正是这条申请（不论经历过几次会话）。 */
  const viewingSame = (id: string) => selectedIdRef.current === id

  /**
   * 拉取详情，返回本次建立的会话序号，供调用方判断「刷回来的这一条是否还在屏幕上」。
   *
   * `refresh` 表示这是对**当前已经显示着的这一条**的重拉（版本冲突后、
   * 或旧投票完成后的跨会话刷新）。两点不同：
   *   · 不清备注——审核人正在写的草稿不能被抹掉；
   *   · 拉取失败时不收起详情——屏幕上那份虽然旧了但仍是有效内容，因为一次
   *     刷新失败就清空，用户会平白丢掉整个视图。
   * 初次打开另一条时两者都相反。
   */
  const fetchDetail = async (
    id: string,
    opts: { keepDraft?: boolean; keepOnError?: boolean } = {},
  ): Promise<number> => {
    const { keepDraft = false, keepOnError = false } = opts
    // keepDraft 即「重读当前这一条」；只有打开另一条才算新会话
    if (!keepDraft) sessionSeq.current++
    const seq = ++detailSeq.current
    selectedIdRef.current = id
    /* 只有「打开另一条」才清详情错误。重读**当前这一条**时不能清：那次重读常常
       是上一次操作的收尾（跨会话刷新），而屏幕上正显示着新会话里刚失败的提示，
       清掉等于把用户刚看到的失败悄悄抹了。各个写操作入口自己会先清一次。 */
    if (!keepDraft) setDetailError('')
    setSelectedId(id)
    if (!keepDraft) setVoteNote('')
    setDetailLoading(true)
    try {
      const result = await get<EditRequestItem>(`/admin/edit-requests/${id}`)
      if (seq !== detailSeq.current) return seq // 过期响应，丢弃
      if (result.ok) setDetail(result.data)
      else {
        /* 初次打开时拉取失败必须把详情清干净：selectedId 已经指向新条目，而
           detail 还留着上一条的数据——不清就会把上一条的内容和操作按钮渲染在
           新 id 下，用户看到的和他点的不是同一件东西。
           刷新失败则保留：屏幕上那份是有效内容，只是没能更新，清掉反而更糟。 */
        if (!keepOnError) {
          // 自动收起也要还焦点：行按钮在加载骨架屏时已被卸载，不还的话焦点停在 body
          focusRowOnReturn(id)
          /* 自动收起同样是「这次会话结束了」：不推进 sessionSeq 的话，另一个在途
             写操作捕获的会话仍会被判为有效，它的错误和 step-up 会弹到列表上，
             成功分支甚至会把刚收起的详情重新打开。 */
          sessionSeq.current++
          setDetail(null)
          setSelectedId(null)
          selectedIdRef.current = null
          /* 详情已经收起，detailError 不会再被渲染——这条必须走列表通道，
             否则「打不开这条申请」的原因就此丢失，界面上只是默默回到了列表。 */
          setListError(result.error.message)
        }
        if (keepOnError) setDetailError(result.error.message)
      }
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false)
    }
    return seq
  }

  /* 提交锁的归属序号。锁本身是页面级的单个布尔值，而操作是详情级的：
     用户可以在请求在途时返回列表、打开另一条并发起新的操作。不记归属的话，
     旧操作结束时会把新操作的锁一起放掉，而返回列表又会让新详情继承一把
     永远解不开的锁。leaveDetail() 自增序号即可让旧操作的释放变成空操作。 */
  const voteSeqRef = useRef(0)

  /** 返回列表：作废在途详情请求与在途操作对锁的归属。 */
  const leaveDetail = () => {
    // 回到列表：把焦点还给当初点开的那一行
    focusRowOnReturn(selectedIdRef.current)
    /* 详情侧的提示随详情一起收掉——它属于刚才那条记录，而详情分支马上就不渲染了。 */
    setDetailError('')
    detailSeq.current++ // 使在途详情请求失效
    sessionSeq.current++ // 会话结束：在途操作的回调不再写这一页
    voteSeqRef.current++
    selectedIdRef.current = null
    setSelectedId(null)
    setDetail(null)
    setVoteSubmitting(false)
  }

  const handleVote = async (vote: 'approve' | 'reject') => {
    if (!selectedId || !detail || voteSubmitting) return
    const actingId = selectedId
    const session = sessionSeq.current
    const mySeq = ++voteSeqRef.current
    setVoteSubmitting(true)
    setDetailError('')
    try {
      const result = await post(
        `/admin/edit-requests/${selectedId}/vote`,
        {
          vote,
          note: voteNote.trim() || null,
          expectedVersion: detail.version,
        },
        {
          /* apiRequest 自动注入 Authorization 并处理 401 刷新 */
        },
      )
      if (result.ok) {
        // 备注框是详情级的：请求在途时用户可能已经切走、甚至又打开了同一条申请
        // 并开始写新备注，无条件清空会把那份草稿抹掉
        if (sameSession(session)) {
          /* 备注在这里显式清掉（这一票已经用掉了）。
             keepOnError 用默认的 false：万一读不回新状态，屏幕上那份的状态就是
             未知的，留着它等于把过期状态和一个还能再投一次的按钮交给用户。 */
          setVoteNote('')
          await fetchDetail(actingId, { keepDraft: true })
        } else if (viewingSame(actingId)) {
          /* 会话换了但用户又把同一条点开了：它显示的还是投票前的旧状态，要刷新。
             refresh —— 不清新会话里刚写的备注，刷新失败也不收起详情。 */
          await fetchDetail(actingId, { keepDraft: true })
        }
        if (mountedRef.current) void refresh()
      } else if (!sameSession(session)) {
        // 已经离开这次详情会话：页面级错误会落到列表或另一条申请上，改为刷新列表
        if (mountedRef.current) void refresh()
      } else if (result.error.code === ERRORS.VERSION_CONFLICT) {
        // 与 Admin.tsx 一致：版本冲突时提示并刷新详情，使重新投票携带最新版本号
        /* 提示写在 fetchDetail **之后**：等新版本号拉回来再让界面可操作，
           否则会拿旧版本号再撞一次冲突。 */
        // 写失败后重读版本号：草稿还在、还要接着改，读不回来也别把视图清了
        const refreshedSeq = await fetchDetail(actingId, { keepDraft: true, keepOnError: true })
        /* fetchDetail 自身会自增 detailSeq，不能再拿进入时的 session 比对。
           用它返回的序号判断：刷回来的这一条仍在屏幕上时才写提示。 */
        if (detailSeq.current === refreshedSeq) {
          setDetailError((cur) => cur || t('admin.versionConflictRefreshed'))
        }
      } else {
        setDetailError(result.error.message)
      }
    } finally {
      if (voteSeqRef.current === mySeq) setVoteSubmitting(false)
    }
  }

  /* 组件卸载（从顶部导航离开，而不是点页内的返回按钮）：作废在途会话与写操作，
     否则旧回调仍会写状态、甚至在卸载后再发一次列表请求。 */
  useEffect(() => {
      // 重新武装：StrictMode 的开发期二次挂载会先跑一遍 cleanup，ref 不会重建
    mountedRef.current = true
    const detail = detailSeq
    const session = sessionSeq
    const vote = voteSeqRef
    const mounted = mountedRef
    const selectedId = selectedIdRef
    return () => {
      detail.current++
      session.current++
      vote.current++
      mounted.current = false
      /* 也要清掉当前详情 id：viewingSame() 只比 id，不清的话组件已经卸载了，
         旧回调仍会认为「这条还开着」，继续写状态、甚至再发一次详情请求。 */
      selectedId.current = null
    }
  }, [])

  // 行点击后的详情拉取中：显示详情骨架，避免慢网下「点击像无效」或无占位跳变（loading-04）
  if (selectedId && detailLoading) {
    return (
      <div className={shell.page}>
        <Skeleton variant="card" />
      </div>
    )
  }

  if (selectedId && detail) {
    const proposedTitle = getProposedField(detail, 'title', 'proposedTitle')
    const proposedSummary = getProposedField(detail, 'summary', 'proposedSummary')
    const proposedContent = getProposedField(detail, 'content', 'proposedContent')
    const proposedTags = getProposedFieldArray(detail, 'tags', 'proposedTags')

    const metaItems: DescriptionItem[] = [
      { term: t('adminEditRequests.contributionId'), value: detail.contribution?.id ?? detail.contributionId ?? '—' },
      {
        term: t('adminEditRequests.status'),
        value: (
          <StatusBadge
            tone={EDIT_REQUEST_STATUS_TONE[detail.status] ?? 'neutral'}
            label={t(EDIT_REQUEST_STATUS_LABEL_KEYS[detail.status] ?? detail.status)}
            size="sm"
          />
        ),
      },
      { term: t('adminEditRequests.version'), value: `v${detail.version}` },
      { term: t('adminEditRequests.created'), value: formatTs(detail.createdAt) || '—' },
    ]

    return (
      <div className={shell.page}>
        <div>
          <AdminButton
            ref={backRef}
            variant="ghost"
            size="sm"
            onClick={leaveDetail}
          >
            {t('adminEditRequests.backToList')}
          </AdminButton>
        </div>

        <Card>
          <div className={shell.stack}>
            <h2 className={shell.detailTitle}>{t('adminEditRequests.detailTitle')}</h2>

            <DescriptionList items={metaItems} columns={2} />

            <div className={shell.contentBlock}>
              <strong>{t('adminEditRequests.reason')}：</strong>
              {detail.reason}
            </div>

            {/* Votes progress */}
            {detail.votes && (
              <Card tone="subtle" padding="sm">
                <SectionLabel>{t('adminEditRequests.voteProgress')}</SectionLabel>
                <VoteProgress
                  approve={detail.votes.approve}
                  reject={detail.votes.reject}
                  required={detail.votes.required}
                  total={detail.votes.total}
                  approveLabel={t('adminEditRequests.voteApprove')}
                  rejectLabel={t('adminEditRequests.voteReject')}
                  thresholdLabel={t('adminEditRequests.votesRequired')}
                />
                {detail.myVote && (
                  <p className={shell.subtleNoteSpaced}>
                    {t('adminEditRequests.myVote')}：
                    {detail.myVote === 'approve'
                      ? t('adminEditRequests.voteApprove')
                      : t('adminEditRequests.voteReject')}
                  </p>
                )}
              </Card>
            )}

            {/* Proposed changes — prefer nested fields, fall back to flat (via type guard) */}
            {(proposedTitle || proposedSummary || proposedContent || (proposedTags && proposedTags.length > 0)) && (
              <div className={shell.stackSm}>
                {proposedTitle && (
                  <p className={shell.noteText}>
                    <strong>{t('adminEditRequests.proposedTitle')}：</strong>
                    {proposedTitle}
                  </p>
                )}
                {proposedSummary && (
                  <p className={shell.noteText}>
                    <strong>{t('adminEditRequests.proposedSummary')}：</strong>
                    {proposedSummary}
                  </p>
                )}
                {proposedContent && (
                  <div className={shell.contentBlock}>
                    <strong>{t('adminEditRequests.proposedContent')}：</strong>
                    <div>{proposedContent}</div>
                  </div>
                )}
                {proposedTags && proposedTags.length > 0 && (
                  <p className={shell.noteText}>
                    <strong>{t('adminEditRequests.proposedTags')}：</strong>
                    {proposedTags.join(', ')}
                  </p>
                )}
              </div>
            )}

            {detailError && <Alert tone="error">{detailError}</Alert>}

            {detail.status === 'pending' && hasPermission(permissions, PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE) && (
              <div className={shell.stackSm}>
                {/* 提交期间冻结：请求带走的是点按钮那一刻的备注，此时还能改的话，
                    屏幕上显示的和实际发出去的不是同一份，成功后还会清掉刚敲的新内容。 */}
                <TextArea
                  value={voteNote}
                  disabled={voteSubmitting}
                  onChange={(e) => setVoteNote(e.target.value)}
                  placeholder={t('adminEditRequests.voteNotePlaceholder')}
                />
                <div className={shell.actions}>
                  <AdminButton variant="primary" onClick={() => handleVote('approve')} loading={voteSubmitting}>
                    {t('adminEditRequests.voteApprove')}
                  </AdminButton>
                  <AdminButton variant="danger" onClick={() => handleVote('reject')} loading={voteSubmitting}>
                    {t('adminEditRequests.voteReject')}
                  </AdminButton>
                </div>
              </div>
            )}

            {detail.votes?.history && detail.votes.history.length > 0 && (
              <Card tone="subtle" padding="sm">
                <SectionLabel>{t('adminEditRequests.voteHistory')}</SectionLabel>
                <ul className={shell.history}>
                  {detail.votes.history.map((v) => (
                    <li key={v.reviewerId} className={shell.historyItem}>
                      <span className={shell.historyHead}>
                        <StatusBadge
                          tone={v.vote === 'approve' ? 'green' : 'red'}
                          label={
                            v.vote === 'approve'
                              ? t('adminEditRequests.voteApprove')
                              : t('adminEditRequests.voteReject')
                          }
                          size="sm"
                        />
                        <span>{v.note || t('adminEditRequests.noNote')}</span>
                      </span>
                      <span className={shell.historyTime}>{formatTs(v.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </Card>
      </div>
    )
  }

  const statusTabs: TabItem[] = [
    { key: 'pending', label: t(EDIT_REQUEST_STATUS_LABEL_KEYS['pending'] ?? 'statusPending') },
    { key: 'approved', label: t(EDIT_REQUEST_STATUS_LABEL_KEYS['approved'] ?? 'statusApproved') },
    { key: 'rejected', label: t(EDIT_REQUEST_STATUS_LABEL_KEYS['rejected'] ?? 'statusRejected') },
    { key: 'applied', label: t(EDIT_REQUEST_STATUS_LABEL_KEYS['applied'] ?? 'statusApplied') },
    { key: 'superseded', label: t(EDIT_REQUEST_STATUS_LABEL_KEYS['superseded'] ?? 'statusSuperseded') },
  ]

  return (
    <div className={shell.page}>
      {error && <Alert tone="error">{error}</Alert>}
      <Tabs
        items={statusTabs}
        value={statusFilter}
        onChange={setStatusFilter}
        ariaLabel={t('adminEditRequests.filterLabel')}
        variant="underline"
        panelId="edit-request-panel"
      />
      <div
        id="edit-request-panel"
        role="tabpanel"
        aria-labelledby={`tab-${statusFilter}`}
        className={shell.tabpanel}
      >
        {loading && items.length === 0 ? (
          <Skeleton rows={6} />
        ) : /* staleResults：屏幕上这批已经不属于当前筛选了（切换后新查询失败，旧结果还留着）。
           不能再把它们摆出来——它们既不是当前条件的结果，行还是可点的，点进去会
           对一个不属于本视图的条目执行操作。此时只显示上面的错误提示。 */
        staleResults ? null : items.length === 0 ? (
          <EmptyState
            title={
              statusFilter === 'pending'
                ? t('adminEditRequests.empty')
                : t('adminEditRequests.emptyWithFilter', {
                    status: t(EDIT_REQUEST_STATUS_LABEL_KEYS[statusFilter] ?? statusFilter),
                  })
            }
          />
        ) : (
          <>
            {loading && (
              <div className={shell.loadingBar} role="status" aria-live="polite">
                {t('adminEditRequests.loading')}
              </div>
            )}
            <ul className={shell.list}>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-row-id={item.id}
                    className={shell.rowBtn}
                    onClick={() => fetchDetail(item.id)}
                  >
                    <span className={shell.rowMain}>
                      <span className={shell.rowTitle}>
                        {item.contribution?.title ??
                          `${t('adminEditRequests.contribPrefix')} ${limitByUnicode(item.contribution?.id ?? item.contributionId ?? '', 20)}…`}
                      </span>
                      <span className={shell.rowMeta}>{limitByUnicode(item.reason, 60)}</span>
                    </span>
                    <span className={shell.rowRight}>
                      <StatusBadge
                        tone={EDIT_REQUEST_STATUS_TONE[item.status] ?? 'neutral'}
                        label={t(EDIT_REQUEST_STATUS_LABEL_KEYS[item.status] ?? item.status)}
                        size="sm"
                      />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <Pagination
          pageIndex={pageIndex}
          knownPages={knownPages}
          hasMore={hasMore}
          disabled={loading || stale}
          onChange={goToPage}
        />
      </div>
    </div>
  )
}
