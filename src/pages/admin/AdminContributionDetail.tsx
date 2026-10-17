import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { get, post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { useStepUpAction } from '@/hooks/useStepUpAction'
import { focusIsOrphaned } from '@/components/admin/restoreFocus'
import { useFormatTs } from '@/utils/datetime'
import {
  AdminButton,
  Alert,
  Card,
  DescriptionList,
  EmptyState,
  ReasonPromptDialog,
  SectionLabel,
  Skeleton,
  Spinner,
  TextArea,
  CONTRIB_STATUS_TONE,
  type DescriptionItem,
} from '@/components/admin'
import { Checkbox, Pagination } from '@/components/ui'
import shell from '../Page.module.css'
import { useAdminPageHeader } from './header'
import { listHref, type RowLinkState } from './listParams'
import { setReturnIntent } from './returnIntent'
import { emitAdminChange, useAdminChange } from './changes'
import { useContributionVersions } from './versions'
import { VersionCompare, VersionHistoryCard } from './ContributionVersions'
import {
  ANY_STATUS_LABEL_KEYS,
  AUTHOR_ACTIONS,
  LIST_PATHS,
  isReviewable,
  parseListHref,
  readQuery,
  toApiParams,
  type ContributionListSection,
  type Submission,
} from './contributions'

// 审核历史是详情里的嵌套列表，用独立的分页状态（不走 usePagedList：它随这一条详情生灭）
const REVIEW_EVENTS_PAGE_SIZE = 20

/** 「连续审稿」开关存在 sessionStorage：同一标签页里一直有效，新会话默认关闭。 */
const CONTINUOUS_KEY = 'tc.admin.continuousReview'

type ReviewAction = 'approved' | 'rejected'

interface ReviewEvent {
  id: string
  contributionId: string
  /** 事件类型（后端 §6.7）：审核方 review / publish / hide / restore / delete / reopen / edit_request_resolve，
      作者 submit / withdraw——作者动作里 reviewer 即作者本人 */
  action?: string
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

function readContinuous(): boolean {
  try {
    return window.sessionStorage.getItem(CONTINUOUS_KEY) === '1'
  } catch {
    return false
  }
}

function writeContinuous(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(CONTINUOUS_KEY, '1')
    else window.sessionStorage.removeItem(CONTINUOUS_KEY)
  } catch {
    /* 存储不可用（隐私模式等）：开关只在本页有效，不影响操作本身 */
  }
}

const RULE_KEYS: Record<string, string> = {
  pending: 'adminRules.pending',
  in_review: 'adminRules.pending',
  approved: 'adminRules.approved',
  published: 'adminRules.published',
  hidden: 'adminRules.hidden',
  rejected: 'adminRules.rejected',
  draft: 'adminRules.draft',
  withdrawn: 'adminRules.withdrawn',
}

/** 当前状态下的规则说明（i18n 里是字符串数组）。 */
function statusRules(t: (key: string, opts?: Record<string, unknown>) => unknown, status: string): string[] {
  const key = RULE_KEYS[status]
  if (!key) return []
  const value = t(key, { returnObjects: true })
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

type ReasonKind = 'hide' | 'delete' | 'reopen'

/** 后台可以直接删除的投稿状态（与后端 delete 接口的 directlyDeletable 一致） */
const DELETABLE_STATUSES: readonly string[] = ['draft', 'withdrawn', 'rejected', 'approved', 'hidden']

const REASON_REQUIRED_KEYS: Record<ReasonKind, string> = {
  hide: 'admin.hideReasonRequired',
  delete: 'admin.deleteReasonRequired',
  reopen: 'adminContributions.reopenReasonRequired',
}

/** 审核历史里每条事件的说法（作者动作单独标出操作者是作者） */
const EVENT_ACTION_KEYS: Record<string, string> = {
  review: 'adminHistory.review',
  publish: 'adminHistory.publish',
  hide: 'adminHistory.hide',
  restore: 'adminHistory.restore',
  delete: 'adminHistory.delete',
  reopen: 'adminHistory.reopen',
  edit_request_resolve: 'adminHistory.editRequestResolve',
  submit: 'adminHistory.submit',
  withdraw: 'adminHistory.withdraw',
}

/** 在 URL 上改 page 参数（下一条落在下一页时，返回落点跟着翻过去）。 */
function withPage(href: string, page: number): string {
  const url = new URL(href, window.location.origin)
  if (page > 1) url.searchParams.set('page', String(page))
  else url.searchParams.delete('page')
  return listHref(url.pathname, url.search)
}

/**
 * 投稿详情（/admin/contributions/:id）。
 *
 * 路由按 :id 整页重挂（router 的 KeyedById），所以「这个组件实例」就是一次详情会话：
 * 卸载即离开——在途的详情请求、写操作、step-up 交接都由卸载清理一并作废。原来在同一个
 * 组件里来回切列表 / 详情时需要的会话补偿（换了一条、又点开同一条……）随之不再存在。
 *
 * 写操作成功后：
 * - 默认回到来源列表（从列表点进来的就 history.back()，筛选、页码原样，焦点回到原行）；
 * - 打开「连续审稿」时，按来源列表的同一筛选找到下一条并直接打开；找不到就回列表并提示。
 * 置顶 / 取消置顶是可逆的位次调整，仍原地刷新。
 */
export const AdminContributionDetail = () => {
  const { t } = useTranslation()
  const formatTs = useFormatTs()
  const { id = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { accessToken, permissions } = useAuth()
  // 危险操作（隐藏/删除，及配置开启时的发布）可能返回 STEP_UP_REQUIRED → 弹 step-up；
  // 本地因子账号 onSuccess 后重放原操作；IAM 账号在对话框内跳转 IAM 完成后回本页重做。
  const { runWithStepUp, stepUpElement } = useStepUpAction(accessToken)

  /* 来源列表在挂载时取一次（之后的 replace 导航不该改变这一次详情会话的来源）。 */
  const [origin] = useState(() => {
    const state = location.state as Partial<RowLinkState> | null
    const from = typeof state?.from === 'string' ? state.from : null
    /* 历史里这条详情之前那一条是不是那个列表：
       - 从列表行点进来（state 里没有 historyFrom 这一项）：就是 from；
       - 连续审稿 replace 过来：沿用上一条带来的值——可能是 null（最初就不是从列表进来的，
         比如从审计日志点进来），这时不能凭推测补一个，否则 back() 会回到审计日志。 */
    const historyFrom =
      state && 'historyFrom' in state ? (typeof state.historyFrom === 'string' ? state.historyFrom : null) : from
    return {
      from,
      historyFrom,
      index: typeof state?.index === 'number' ? state.index : null,
      done: Array.isArray(state?.done) ? state.done.filter((x): x is string => typeof x === 'string') : [],
      /* 浏览历史里上一条正是要回去的那个列表（从列表点进来，或连续审稿在同一页内 replace 过来）：
         退回时用 back()，不在历史里堆一条重复的列表。连续审稿翻过页时历史里的仍是原页，不能 back()。 */
      canGoBack:
        from !== null && historyFrom === from && ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0,
    }
  })
  const parsedFrom = parseListHref(origin.from)

  const [selected, setSelected] = useState<Submission | null>(null)
  const [detailLoading, setDetailLoading] = useState(true)
  /** 打不开这一条（首次加载失败，或写成功后读不回新状态）：整页换成错误态。 */
  const [loadError, setLoadError] = useState('')
  const [reviewNotes, setReviewNotes] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [reviewEvents, setReviewEvents] = useState<ReviewEvent[]>([])
  const [reviewEventsLoading, setReviewEventsLoading] = useState(false)
  const [reviewEventsPage, setReviewEventsPage] = useState(1)
  const [reviewEventsTotal, setReviewEventsTotal] = useState(0)
  const [reviewEventsTotalPages, setReviewEventsTotalPages] = useState(1)
  const [reviewEventsError, setReviewEventsError] = useState('')
  const [continuous, setContinuous] = useState(readContinuous)
  /* 写操作完成后读开关的最新值，而不是发起时那次渲染闭包里的值；提交期间复选框也锁住，
     本次操作按提交时的设置走，二者不会不一致。 */
  const continuousRef = useRef(continuous)
  /** 本页实例的身份：收到自己发出的变更广播时忽略（自己已经在跳转或重读）。 */
  const [instance] = useState(() => ({}))

  // 隐藏/删除原因对话框（替代原生 window.confirm 与内联原因输入框）
  const [reasonDialog, setReasonDialog] = useState<{ kind: ReasonKind } | null>(null)
  const [actionReason, setActionReason] = useState('')
  const [reasonError, setReasonError] = useState('')

  /* 详情拉取的竞态守卫：写操作后的重读与重试可能交错返回，只有最新一次请求能写入。 */
  const detailSeq = useRef(0)
  /* 审核历史自己的请求序号：详情重读会作废在途的历史翻页，翻页之间也只认最新一次。 */
  const eventsSeq = useRef(0)
  /* 详情会话序号：只在卸载时自增。写操作 await 之后先比对它——用户已经离开（点了左栏、
     后退、打开了别的条目），403 时后端什么都没做，此时绝不能再弹 step-up、写错误或跳转。 */
  const sessionSeq = useRef(0)
  const sameSession = (session: number) => sessionSeq.current === session
  const mountedRef = useRef(true)

  /* 详情侧的错误（写操作失败、版本冲突提示、重读失败）。 */
  const [detailError, setDetailError] = useState('')

  /* 审核/发布/隐藏等写操作的进行中锁：这些接口带 expectedVersion，
     连点两次时第二次必然版本冲突。用一个统一的 submitting 兜住，按钮同时进入 loading 态。 */
  const [submitting, setSubmitting] = useState(false)
  /** submitting 锁的归属序号：step-up 交接、卸载后旧回调都按它判断能不能释放锁。 */
  const submitSeq = useRef(0)

  /* 详情重拉期间也要锁住操作按钮：屏幕上挂的还是旧版本号，这时点下去必然是一次注定
     版本冲突的无效写请求。 */
  const actionsLocked = submitting || detailLoading

  const section: ContributionListSection =
    parsedFrom?.section ?? (selected && isReviewable(selected.status) ? 'review' : 'contributions')
  const backTo = origin.from ?? LIST_PATHS[section]

  /**
   * 取审核历史的指定页。需 contribution:audit:read（api.md §6.7）：没有该权限时不发起
   * 必 403 的无谓请求，历史区保持为空。
   */
  const loadReviewEvents = async (contributionId: string, targetPage: number) => {
    if (!hasPermission(permissions, PERMISSIONS.CONTRIBUTION_AUDIT_READ)) return
    const seq = ++eventsSeq.current
    setReviewEventsLoading(true)
    setReviewEventsError('')
    const params = new URLSearchParams({
      limit: String(REVIEW_EVENTS_PAGE_SIZE),
      page: String(targetPage),
    })
    const result = await get<ReviewEvent[]>(`/admin/contributions/${contributionId}/review-events?${params}`)
    if (seq !== eventsSeq.current) return // 过期响应，丢弃（loading 交给新请求收尾）
    if (result.ok) {
      setReviewEvents(result.data)
      setReviewEventsPage(result.pagination?.page ?? 1)
      setReviewEventsTotal(result.pagination?.total ?? result.data.length)
      setReviewEventsTotalPages(result.pagination?.totalPages ?? 1)
    } else {
      // 翻页失败不清空已渲染的历史，否则整块连同重试入口一起消失，看起来像「没有审核记录」
      setReviewEventsError(t('admin.reviewEventsError'))
    }
    setReviewEventsLoading(false)
  }

  /**
   * 拉取详情，返回本次请求的序号，供调用方判断「刷回来的这一条是否还是最新的那次」。
   *
   *   · `keepDraft` —— 不清正在写的备注。重读同一条（写操作之后）时为 true。
   *   · `keepOnError` —— 拉取失败时保留屏幕上那份旧详情。只在「写操作**失败**后重读版本号」
   *     时为 true：用户的草稿还在、还要接着改，把视图清掉等于让他白写一遍。
   *
   * 写操作**成功**后的重读必须 keepOnError=false：写已经生效，而这次没读回来，屏幕上那份
   * 的状态是未知的。留着它等于把过期状态和一排可用的操作按钮一起交给用户——换成错误态。
   */
  const fetchDetail = async (opts: { keepDraft?: boolean; keepOnError?: boolean } = {}): Promise<number> => {
    const { keepDraft = false, keepOnError = false } = opts
    const seq = ++detailSeq.current
    setDetailLoading(true)
    /* 作废在途的历史翻页（它们属于重读之前的那份详情），并复位加载态：
       被作废的请求会提前返回，走不到自己的收尾。 */
    eventsSeq.current++
    setReviewEventsLoading(false)
    try {
      const result = await get<Submission>(`/admin/contributions/${encodeURIComponent(id)}`)
      if (seq !== detailSeq.current) return seq // 过期响应，丢弃
      if (!result.ok) throw new Error(t('admin.errorDetail'))
      setLoadError('')
      setSelected(result.data)
      if (!keepDraft) {
        setReviewNotes('')
        setInternalNote('')
      }
      setReviewEvents([])
      await loadReviewEvents(result.data.id, 1)
    } catch {
      if (seq !== detailSeq.current) return seq
      if (keepOnError) {
        setDetailError(t('admin.errorDetail'))
      } else {
        // 理由弹窗属于这一条，详情换成错误态时一起收掉
        setReasonDialog(null)
        setSelected(null)
        setLoadError(t('admin.errorDetail'))
      }
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false)
    }
    return seq
  }

  /* 首次加载。卸载（离开、换一条）时作废所有在途会话与写操作，否则旧回调仍会写状态、
     甚至在卸载后再跳转一次。 */
  useEffect(() => {
    // 重新武装：StrictMode 的开发期二次挂载会先跑一遍 cleanup，ref 不会重建
    mountedRef.current = true
    const detail = detailSeq
    const session = sessionSeq
    const submit = submitSeq
    const mounted = mountedRef
    // 拉取数据是 effect 对外部数据源的订阅；fetchDetail 首行的 setDetailLoading 属该模式的同步 setState
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchDetail()
    return () => {
      detail.current++
      session.current++
      submit.current++
      mounted.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 连续审稿的「下一条」：按来源列表的同一套筛选（与列表页共用 readQuery / toApiParams）重新查。
   *   · 刚处理的这条仍在原位（如「全部」筛选、按创建时间排序）→ 从它后面找；
   *   · 已经移出筛选（待审核 → 已通过），或排序会因处理而变（按更新时间）→ 从它原来的位置往后找；
   *   · 一律跳过这一轮已经处理过的条目（done），不会绕回去重开；
   *   · 本页往后 → 后面各页 → 第 1 页起的前面各页 → 本页前面，整个查询范围都确认没有才算「没有了」。
   * 结果区分「找到了」「确实没有了」「没查成」（含中途离开），后两者给出不同的提示。
   */
  const findNext = async (
    actingId: string,
    session: number,
  ): Promise<{ id: string; index: number; from: string } | 'empty' | 'failed'> => {
    const listUrl = backTo
    const target = parseListHref(listUrl) ?? { section, params: new URLSearchParams() }
    const query = readQuery(target.section, target.params)
    const startPage = Math.max(1, Number.parseInt(target.params.get('page') ?? '', 10) || 1)
    const fetchList = (p: number) => get<Submission[]>(`/admin/contributions?${toApiParams(query, p)}`)
    const skip = new Set([...origin.done, actingId])
    const firstOpen = (rows: Submission[], start = 0, end = rows.length) =>
      rows.slice(start, end).find((r) => !skip.has(r.id))
    const found = (rows: Submission[], row: Submission, page: number) => ({
      id: row.id,
      index: rows.indexOf(row),
      from: withPage(listUrl, page),
    })

    const first = await fetchList(startPage)
    if (!first.ok || !sameSession(session)) return 'failed'
    const rows = first.data
    // 服务端会把越界页回落到末页：以回显页为准
    const servedPage = first.pagination?.page ?? startPage
    const totalPages = first.pagination?.totalPages ?? 1
    const at = rows.findIndex((r) => r.id === actingId)
    const stableOrder = query.sort !== 'updatedAt_desc'
    const startAt = at >= 0 && stableOrder ? at + 1 : Math.min(origin.index ?? 0, rows.length)

    const after = firstOpen(rows, startAt)
    if (after) return found(rows, after, servedPage)

    // 后面各页，再从第 1 页绕回到本页之前
    const order = [
      ...Array.from({ length: Math.max(0, totalPages - servedPage) }, (_, i) => servedPage + 1 + i),
      ...Array.from({ length: servedPage - 1 }, (_, i) => i + 1),
    ]
    for (const p of order) {
      const res = await fetchList(p)
      if (!res.ok || !sameSession(session)) return 'failed'
      const hit = firstOpen(res.data)
      if (hit) return found(res.data, hit, res.pagination?.page ?? p)
    }

    const before = firstOpen(rows, 0, startAt)
    if (before) return found(rows, before, servedPage)
    return 'empty'
  }

  /**
   * 写操作成功后离开这一条：回列表，或（连续审稿）打开下一条。
   * continuable：这次操作是不是「流水线」的一步（审核、发布、删除已通过的稿件）。
   * 开关是会话级的——在待审核稿件上打开后，去处置已发布 / 已隐藏的稿件时它仍是开的，
   * 但那些是逐条处置，不能跟着跳到下一条。
   */
  const leave = async (actingId: string, continuable: boolean) => {
    const session = sessionSeq.current
    let toast: string | undefined
    if (continuable && continuousRef.current) {
      const next = await findNext(actingId, session)
      if (!sameSession(session)) return
      if (typeof next === 'object') {
        navigate(`/admin/contributions/${encodeURIComponent(next.id)}?toast=review_next`, {
          replace: true,
          state: {
            from: next.from,
            index: next.index,
            // 历史里这条详情之前的那条列表没变：沿用最初的地址
            historyFrom: origin.historyFrom,
            // 整轮都要记住，不截断：在「全部」筛选下处理过的条目仍在列表里，忘掉就会被重新打开
            done: [...origin.done, actingId],
          } satisfies RowLinkState,
        })
        return
      }
      toast = next === 'empty' ? 'review_done' : 'review_next_failed'
    }
    if (origin.canGoBack) {
      setReturnIntent({ href: backTo, focusRow: actingId, toast })
      navigate(-1)
      return
    }
    const target = toast ? `${backTo}${backTo.includes('?') ? '&' : '?'}toast=${toast}` : backTo
    navigate(target, { replace: true, state: { focusRow: actingId } })
  }

  /** 写成功后广播：已经离开这条的旧会话不再动界面，但当前挂着的列表 / 同一条详情要重读。 */
  const announce = (actingId: string) => emitAdminChange({ kind: 'contribution', id: actingId, source: instance })

  /* 别处（另一个详情实例）写成功了同一条：重读，保留正在写的备注。 */
  useAdminChange((change) => {
    if (change.kind !== 'contribution' || change.id !== id || change.source === instance) return
    void fetchDetail({ keepDraft: true })
  })

  /* 打不开 → 重试成功：错误态里的重试按钮被换掉，焦点会掉到 body；只在焦点确实没人认领时接回 main。 */
  const hasDetail = selected !== null
  useEffect(() => {
    if (hasDetail && focusIsOrphaned()) document.getElementById('admin-main')?.focus({ preventScroll: true })
  }, [hasDetail])

  /**
   * 写操作的公共收尾。失败分支（step-up 之外）都在这里：
   * - 已经离开这条详情：什么都不写；
   * - 版本冲突：重读最新版本号（保留草稿、失败也不收起），提示写在重读**之后**——等新版本号
   *   拉回来再解锁，否则用户能在旧版本号仍挂在界面上时再点一次，必然又是一次冲突。
   *   函数式更新是为了不盖掉 fetchDetail 自己的错误：重读都失败了的话，说「已刷新」是假的。
   */
  const handleWriteFailure = async (session: number, error: { code?: string; message?: string }) => {
    if (!sameSession(session)) return
    if (error.code === ERRORS.VERSION_CONFLICT) {
      const refreshedSeq = await fetchDetail({ keepDraft: true, keepOnError: true })
      if (detailSeq.current === refreshedSeq) {
        setDetailError((cur) => cur || t('admin.versionConflictRefreshed'))
      }
    } else {
      setDetailError(error.message || t('admin.errorReview'))
    }
  }

  const handleReview = async (action: ReviewAction) => {
    if (!selected || submitting) return
    const actingId = selected.id
    const v = selected.version || 1
    const session = sessionSeq.current
    const mySeq = ++submitSeq.current
    setSubmitting(true)
    setDetailError('')
    try {
      const result = await post(`/admin/contributions/${actingId}/review`, {
        decision: action,
        publicNote: reviewNotes || null,
        internalNote: internalNote || null,
        expectedVersion: v,
      })
      if (!result.ok) {
        await handleWriteFailure(session, result.error)
        return
      }
      announce(actingId)
      if (sameSession(session)) await leave(actingId, true)
    } catch (err) {
      if (sameSession(session)) setDetailError(err instanceof Error ? err.message : t('admin.errorReview'))
    } finally {
      if (submitSeq.current === mySeq) setSubmitting(false)
    }
  }

  /**
   * 可能要求二次验证的写操作（发布 / 隐藏 / 删除）的公共流程。
   * STEP_UP_REQUIRED 时把重放交给 step-up：重放是异步的，锁必须留到那一轮结束再释放（handedOff）。
   * 已经离开这条详情时绝不再弹二次验证——403 时后端什么都没做，直接放弃本次操作。
   */
  const runGuardedWrite = async (path: string, body: Record<string, unknown>, continuable: boolean) => {
    if (!selected || submitting) return
    const actingId = selected.id
    const session = sessionSeq.current
    const mySeq = ++submitSeq.current
    setSubmitting(true)
    setDetailError('')
    let handedOff = false
    const attempt = async () => {
      const result = await post(`/admin/contributions/${actingId}/${path}`, body)
      if (!result.ok) {
        if (result.error.code === ERRORS.STEP_UP_REQUIRED) {
          if (!sameSession(session)) return
          handedOff = true
          runWithStepUp(attempt, () => {
            if (submitSeq.current === mySeq) setSubmitting(false)
          })
          return
        }
        await handleWriteFailure(session, result.error)
        return
      }
      announce(actingId)
      if (sameSession(session)) await leave(actingId, continuable)
    }
    try {
      await attempt()
    } finally {
      if (!handedOff && submitSeq.current === mySeq) setSubmitting(false)
    }
  }

  /**
   * 通过并发布（后端 §6.3A）：同时有审核与发布权限的人审稿时一步完成。服务端在一个事务里写完
   * 「通过 → 发布」，要么都成、要么都不成；发布是否需要二次验证由站点配置决定，需要时在任何写入之前
   * 返回 STEP_UP_REQUIRED，交给 step-up 重放整步。成功后按流水线离开（连续审稿适用）。
   */
  const handleApproveAndPublish = () =>
    runGuardedWrite(
      'approve-and-publish',
      {
        expectedVersion: selected?.version || 1,
        publicNote: reviewNotes || null,
        internalNote: internalNote || null,
      },
      true,
    )

  /**
   * 重新打开审核（后端 §6.3B）：把「已拒绝」或「已通过（未发布）」撤回到待审核。原因作者可见。
   * 成功后原地重读——稿件还在，只是回到了待审核，审核员接着就能重新审。
   */
  const handleReopen = async (reason: string) => {
    if (!selected || submitting) return
    const actingId = selected.id
    const v = selected.version || 1
    const session = sessionSeq.current
    const mySeq = ++submitSeq.current
    setSubmitting(true)
    setDetailError('')
    try {
      const result = await post(`/admin/contributions/${actingId}/reopen`, { expectedVersion: v, reason })
      if (!result.ok) {
        await handleWriteFailure(session, result.error)
        return
      }
      announce(actingId)
      if (sameSession(session)) await fetchDetail()
    } finally {
      if (submitSeq.current === mySeq) setSubmitting(false)
    }
  }

  const handlePublish = () =>
    runGuardedWrite('publish', { expectedVersion: selected?.version || 1, publicNote: null }, true)

  const runHide = (reason: string) =>
    runGuardedWrite(
      'hide',
      { expectedVersion: selected?.version || 1, reason, publicNote: null, internalNote: null },
      false,
    )

  /* 删除只有在「已通过」稿件上才算流水线的一步（审核后决定不发布）；已隐藏 / 已拒绝稿件的删除是逐条清理。 */
  const runDelete = (reason: string) =>
    runGuardedWrite('delete', { expectedVersion: selected?.version || 1, reason }, selected?.status === 'approved')

  const handleRestore = async () => {
    if (!selected || submitting) return
    const actingId = selected.id
    const v = selected.version || 1
    const session = sessionSeq.current
    const mySeq = ++submitSeq.current
    setSubmitting(true)
    setDetailError('')
    try {
      const result = await post(`/admin/contributions/${actingId}/restore`, {
        expectedVersion: v,
        reason: t('admin.restoreReason'),
        publicNote: null,
        internalNote: null,
      })
      if (!result.ok) {
        await handleWriteFailure(session, result.error)
        return
      }
      announce(actingId)
      if (sameSession(session)) await leave(actingId, false)
    } finally {
      if (submitSeq.current === mySeq) setSubmitting(false)
    }
  }

  /* 置顶/取消置顶：可逆的展示位次调整，后端不要求 step-up、不需要原因。
     成功后原地刷新详情——管理员需要立刻看到按钮翻转为相反操作。 */
  const handlePinToggle = async () => {
    if (!selected || submitting) return
    const actingId = selected.id
    const v = selected.version || 1
    const pinning = !selected.pinnedAt
    const session = sessionSeq.current
    const mySeq = ++submitSeq.current
    setSubmitting(true)
    setDetailError('')
    try {
      const result = await post(`/admin/contributions/${actingId}/${pinning ? 'pin' : 'unpin'}`, { expectedVersion: v })
      if (!result.ok) {
        await handleWriteFailure(session, result.error)
        return
      }
      announce(actingId)
      if (sameSession(session)) await fetchDetail({ keepDraft: true })
    } finally {
      if (submitSeq.current === mySeq) setSubmitting(false)
    }
  }

  const openReasonDialog = (kind: ReasonKind) => {
    setActionReason('')
    setReasonError('')
    setDetailError('')
    setReasonDialog({ kind })
  }

  const submitReason = async () => {
    if (!reasonDialog) return
    const reason = actionReason.trim()
    if (!reason || reason.length > 200) {
      setReasonError(t(REASON_REQUIRED_KEYS[reasonDialog.kind]))
      return
    }
    const kind = reasonDialog.kind
    setReasonDialog(null)
    setReasonError('')
    if (kind === 'hide') await runHide(reason)
    else if (kind === 'reopen') await handleReopen(reason)
    else await runDelete(reason)
  }

  const toggleContinuous = (on: boolean) => {
    continuousRef.current = on
    setContinuous(on)
    writeContinuous(on)
  }

  const backLabel = t(section === 'review' ? 'adminQueue.backTo' : 'adminContributions.backTo')
  useAdminPageHeader({
    title: selected?.title ?? t('adminContributions.detailTitle'),
    back: { to: backTo, label: backLabel, focusRow: id },
    badge: selected
      ? {
          tone: CONTRIB_STATUS_TONE[selected.status] ?? 'neutral',
          label: t(ANY_STATUS_LABEL_KEYS[selected.status] ?? selected.status),
        }
      : undefined,
    section,
  })

  /* 内容版本历史（后端 §6.9）：详情的版本号变了（写操作、修改申请应用）就从第 1 页重取 */
  const versions = useContributionVersions(id, selected?.version ?? null)
  /** 主栏正在对照的历史版本号（与当前内容对照）；null = 不对照 */
  const [compareVersion, setCompareVersion] = useState<number | null>(null)

  // ── 打不开 ──
  if (!selected && loadError) {
    return (
      <div className={shell.page}>
        <EmptyState
          title={loadError}
          description={t('adminContributions.loadErrorDescription')}
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

  // ── 首次加载 ──
  if (!selected) {
    return (
      <div className={shell.page} aria-busy="true">
        <Skeleton variant="card" />
      </div>
    )
  }

  // ── 详情 ──
  const canInternalNote = hasPermission(permissions, PERMISSIONS.CONTRIBUTION_INTERNAL_NOTE_READ)
  const canReview = isReviewable(selected.status) && hasPermission(permissions, PERMISSIONS.CONTRIBUTION_REVIEW)
  const can = (p: string) => hasPermission(permissions, p)
  const showPublish = selected.status === 'approved' && can(PERMISSIONS.CONTRIBUTION_PUBLISH)
  /* 置顶只对已发布的；取消置顶不看状态（后端 unpin 不校验状态）——「置顶后又隐藏」的稿件仍带着置顶时间，
     得能在后台取消，不然恢复后会沿用旧的置顶 */
  const showPin = can(PERMISSIONS.CONTRIBUTION_PUBLISH) && (selected.pinnedAt ? true : selected.status === 'published')
  const showHide = selected.status === 'published' && can(PERMISSIONS.CONTRIBUTION_HIDE)
  const showRestore = selected.status === 'hidden' && can(PERMISSIONS.CONTRIBUTION_RESTORE)
  /* 可直接删除的状态与后端一致（routes/admin.ts delete：草稿、已撤回、已拒绝、已通过、已隐藏）；
     待审核、已发布须先撤回 / 隐藏，不给按钮 */
  const showDelete = DELETABLE_STATUSES.includes(selected.status) && can(PERMISSIONS.CONTRIBUTION_DELETE)
  /* 「连续审稿」只用于还没公开的稿件（待审核 → 审核，已通过 → 发布 / 删除）。
     已发布、已隐藏、已驳回的稿件是逐条处置，不是流水线，不给这个开关。 */
  const canContinue =
    (isReviewable(selected.status) || selected.status === 'approved') && (canReview || showPublish || showDelete)
  /* 这个状态下各操作的真实后果（取自后端实现，见 i18n adminRules.*），按状态给，不按权限藏：
     没有操作权限的人也该知道这条稿件接下来会怎样。 */
  /* 审核与发布是两个权限（reviewer 只有前者，editor / admin 两者都有）。两者都有的人审稿时可以一步「通过并发布」。 */
  const canApproveAndPublish = canReview && can(PERMISSIONS.CONTRIBUTION_PUBLISH)
  const rules = [
    ...statusRules(t, selected.status),
    ...(canApproveAndPublish ? [t('adminRules.approveAndPublish')] : []),
  ]
  /* 稿件是怎么回到待审核的（后端 §6.2：review = 最近一条审核结论，latestEvent = 最近一条事件）：
     - 被拒后作者修改并重新提交：上一轮结论是「拒绝」、最近一条事件是作者的 submit；
     - 审核员重新打开了审核：最近一条事件是 reopen（原因作者可见）。
     把上一轮的结论、理由、改了什么摆在正文上方，重审不用去翻历史。 */
  const latest = selected.latestEvent ?? null
  const resubmitted =
    isReviewable(selected.status) && selected.review?.decision === 'rejected' && latest?.action === 'submit'
  const reopened = isReviewable(selected.status) && latest?.action === 'reopen'
  /* 被拒时审的是哪一版：后端给出的「拒绝之前最后一份内容快照」号（§6.2 contentVersions）。
     不从侧栏的版本列表里找——那是分页的，翻页结果就变。
     是否「没改就重新提交」按内容判断（sameAsLastDecision）：作者原样保存、或改了又改回去，快照号会变，内容没变。
     旧后端没有这个字段时退回比快照号。 */
  const rejectedVersion: number | null = resubmitted ? (selected.contentVersions?.atLastDecision ?? null) : null
  const sameAsRejected = selected.contentVersions?.sameAsLastDecision
  const unchangedResubmission =
    rejectedVersion !== null &&
    (typeof sameAsRejected === 'boolean'
      ? sameAsRejected
      : selected.contentVersions?.current != null && rejectedVersion === selected.contentVersions.current)

  // 审核员显示名由接口给出（后端 §6.2 review.reviewer），不再依赖需要审计权限的审核历史反查
  const reviewerDisplayName = selected.review?.reviewer?.displayName ?? null
  /* 重新打开审核：已拒绝或已通过（未发布）的稿件，需审核权限（后端 §6.3B） */
  const showReopen =
    (selected.status === 'rejected' || selected.status === 'approved') && can(PERMISSIONS.CONTRIBUTION_REVIEW)
  const authorName = selected.author?.displayName || t('admin.authorAnonymous')

  const metaItems: DescriptionItem[] = [
    {
      term: t('adminContributions.author'),
      value:
        selected.author?.id && can(PERMISSIONS.USER_READ) ? (
          <Link to={`/admin/users/${encodeURIComponent(selected.author.id)}`} className={shell.textLink}>
            {authorName}
          </Link>
        ) : (
          authorName
        ),
    },
    {
      term: t('adminContributions.tags'),
      value: selected.tags?.length ? selected.tags.join(t('common.enumSeparator')) : '—',
    },
    { term: t('adminContributions.language'), value: selected.language || '—' },
    { term: t('adminContributions.version'), value: t('common.versionShort', { version: selected.version }) },
    { term: t('adminContributions.submittedAt'), value: formatTs(selected.submittedAt ?? selected.createdAt) || '—' },
    ...(selected.publishedAt
      ? [{ term: t('adminContributions.publishedAt'), value: formatTs(selected.publishedAt) }]
      : []),
    ...(selected.pinnedAt ? [{ term: t('adminContributions.pinnedAt'), value: formatTs(selected.pinnedAt) }] : []),
  ]

  return (
    <div className={shell.page}>
      <div className={shell.detailGrid}>
        <Card className={shell.detailInfo}>
          <DescriptionList items={metaItems} columns={2} />
        </Card>

        <div className={shell.detailMain}>
          {resubmitted && selected.review && (
            <Card tone="subtle" accent padding="sm">
              <SectionLabel>{t('adminContributions.resubmittedTitle')}</SectionLabel>
              <p className={shell.noteText}>
                {t(
                  reviewerDisplayName ? 'adminContributions.resubmittedByReviewer' : 'adminContributions.resubmitted',
                  {
                    reviewer: reviewerDisplayName,
                    rejectedAt: formatTs(selected.review.reviewedAt) || '—',
                    submittedAt: formatTs(latest?.createdAt ?? selected.submittedAt) || '—',
                  },
                )}
              </p>
              {selected.review.publicNote && (
                <p className={shell.noteText}>
                  {t('adminContributions.resubmittedReason', { note: selected.review.publicNote })}
                </p>
              )}
              {unchangedResubmission ? (
                <p className={shell.noteText}>{t('adminContributions.resubmittedUnchanged')}</p>
              ) : (
                rejectedVersion && (
                  <div className={shell.actions}>
                    <AdminButton
                      variant="secondary"
                      size="sm"
                      aria-pressed={compareVersion === rejectedVersion}
                      onClick={() => setCompareVersion(rejectedVersion)}
                    >
                      {t('adminContributions.compareRejected', { version: rejectedVersion })}
                    </AdminButton>
                  </div>
                )
              )}
            </Card>
          )}
          {reopened && latest && (
            <Card tone="subtle" accent padding="sm">
              <SectionLabel>{t('adminContributions.reopenedTitle')}</SectionLabel>
              <p className={shell.noteText}>
                {t('adminContributions.reopenedBody', {
                  actor: latest.actor.displayName || t('admin.authorAnonymous'),
                  time: formatTs(latest.createdAt) || '—',
                  from: t(ANY_STATUS_LABEL_KEYS[latest.fromStatus] ?? latest.fromStatus),
                })}
              </p>
              {latest.publicNote && (
                <p className={shell.noteText}>{t('adminContributions.reopenedReason', { note: latest.publicNote })}</p>
              )}
            </Card>
          )}
          {compareVersion !== null && (
            <VersionCompare
              key={compareVersion}
              contributionId={selected.id}
              version={compareVersion}
              current={{
                title: selected.title,
                summary: selected.summary,
                contentRaw: selected.contentRaw ?? '',
                tags: selected.tags ?? [],
                contentFormat: selected.contentFormat ?? null,
                language: selected.language ?? null,
              }}
              onClose={() => setCompareVersion(null)}
            />
          )}
          {selected.summary && (
            <section className={shell.field} aria-labelledby="contribution-summary">
              <h2 id="contribution-summary" className={shell.fieldLabel}>
                {t('adminContributions.summary')}
              </h2>
              <p className={shell.contentBlock}>{selected.summary}</p>
            </section>
          )}
          <section className={shell.field} aria-labelledby="contribution-source">
            <h2 id="contribution-source" className={shell.fieldLabel}>
              {t('adminContributions.source')}
            </h2>
            {/* 待审原文：Markdown 原样展示（等宽、保留换行、限高可滚）。 */}
            <pre className={shell.rawSource} tabIndex={0} aria-label={t('common.rawSourceLabel')}>
              {selected.contentRaw}
            </pre>
          </section>

          {/* 内部备注：仅在拥有 contribution:internal-note:read 权限时展示 */}
          {selected.review?.internalNote && canInternalNote && (
            <Card tone="subtle" accent padding="sm">
              <SectionLabel>
                {resubmitted || reopened ? t('adminContributions.previousInternalNote') : t('admin.internalNoteLabel')}
              </SectionLabel>
              <p className={shell.noteText}>{selected.review.internalNote}</p>
            </Card>
          )}
        </div>

        <div className={shell.detailSide}>
          {/* 操作卡：有任一可做的动作、规则说明、审核备注或错误时才出现（不能只看规则说明——
              草稿、已撤回没有审核规则，却可能有删除按钮） */}
          {(canReview ||
            showPublish ||
            showPin ||
            showHide ||
            showRestore ||
            showReopen ||
            showDelete ||
            rules.length > 0 ||
            selected.review?.publicNote ||
            detailError) && (
            <Card>
              <div className={shell.stackSm}>
                <h2 className={shell.sideHeading}>{t('adminContributions.actionsHeading')}</h2>

                {/* 重新提交 / 重新打开的稿件，上一轮的结论已经在正文上方说明，这里不重复 */}
                {selected.review?.publicNote && !resubmitted && !reopened && (
                  <p className={shell.noteText}>
                    {t('admin.reviewNotes', { notes: selected.review.publicNote })}
                    {reviewerDisplayName && t('admin.reviewer', { reviewer: reviewerDisplayName })}
                    {selected.review.reviewedAt ? ` · ${formatTs(selected.review.reviewedAt)}` : ''}
                  </p>
                )}

                {detailError && <Alert tone="error">{detailError}</Alert>}

                {canReview && (
                  <>
                    {/* 提交期间冻结：请求带走的是点按钮那一刻的备注，此时还能改的话，
                      屏幕上显示的和实际发出去的就不是同一份。 */}
                    <TextArea
                      label={t('admin.reviewNotesLabel')}
                      value={reviewNotes}
                      disabled={submitting}
                      onChange={(e) => setReviewNotes(e.target.value)}
                      placeholder={t('admin.reviewTextareaPlaceholder')}
                    />
                    {/* 内部备注输入：与后端一致，需 contribution:internal-note:read 权限 */}
                    {canInternalNote && (
                      <TextArea
                        label={t('admin.internalNoteLabel')}
                        value={internalNote}
                        disabled={submitting}
                        onChange={(e) => setInternalNote(e.target.value)}
                        placeholder={t('admin.internalNotePlaceholder')}
                      />
                    )}
                    <div className={shell.actions}>
                      {/* 同时有发布权限：主操作是「通过并发布」，「仅通过」留给要晚点发布（或交给别人发布）的情况 */}
                      {canApproveAndPublish && (
                        <AdminButton
                          variant="primary"
                          loading={submitting}
                          disabled={detailLoading}
                          onClick={handleApproveAndPublish}
                        >
                          {t('admin.approveAndPublish')}
                        </AdminButton>
                      )}
                      <AdminButton
                        variant={canApproveAndPublish ? 'secondary' : 'primary'}
                        loading={submitting}
                        disabled={detailLoading}
                        onClick={() => handleReview('approved')}
                      >
                        {canApproveAndPublish ? t('admin.approveOnly') : t('admin.approve')}
                      </AdminButton>
                      <AdminButton
                        variant="danger"
                        loading={submitting}
                        disabled={detailLoading}
                        onClick={() => handleReview('rejected')}
                      >
                        {t('admin.reject')}
                      </AdminButton>
                    </div>
                  </>
                )}

                {(showPublish || showPin || showHide || showRestore || showReopen || showDelete) && (
                  <div className={shell.actions}>
                    {showPublish && (
                      <AdminButton
                        variant="primary"
                        loading={submitting}
                        disabled={detailLoading}
                        onClick={handlePublish}
                      >
                        {t('admin.publishButton')}
                      </AdminButton>
                    )}
                    {/* 置顶与发布同级权限（contribution:publish）：位次属于编辑权 */}
                    {showPin && (
                      <AdminButton
                        variant="secondary"
                        loading={submitting}
                        disabled={detailLoading}
                        onClick={handlePinToggle}
                      >
                        {selected.pinnedAt ? t('admin.unpinButton') : t('admin.pinButton')}
                      </AdminButton>
                    )}
                    {showRestore && (
                      <AdminButton
                        variant="primary"
                        loading={submitting}
                        disabled={detailLoading}
                        onClick={handleRestore}
                      >
                        {t('admin.restoreButton')}
                      </AdminButton>
                    )}
                    {/* 重新打开审核：把这个结论撤回到待审核（后端 §6.3B），原因作者可见 */}
                    {showReopen && (
                      <AdminButton
                        variant="secondary"
                        disabled={actionsLocked}
                        onClick={() => openReasonDialog('reopen')}
                      >
                        {t('adminContributions.reopenButton')}
                      </AdminButton>
                    )}
                    {showHide && (
                      <AdminButton variant="danger" disabled={actionsLocked} onClick={() => openReasonDialog('hide')}>
                        {t('admin.hideButton')}
                      </AdminButton>
                    )}
                    {showDelete && (
                      <AdminButton variant="danger" disabled={actionsLocked} onClick={() => openReasonDialog('delete')}>
                        {t('admin.deleteButton')}
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

                {canContinue && (
                  <Checkbox
                    label={t('admin.continuousReview')}
                    hint={t('admin.continuousReviewHint')}
                    checked={continuous}
                    disabled={actionsLocked}
                    onChange={(e) => toggleContinuous(e.target.checked)}
                    fieldClassName={shell.continuous}
                  />
                )}
              </div>
            </Card>
          )}

          {/* 审核历史（api.md §6.3）。换页时保留已渲染的历史，只有首载（还没有内容）才用 spinner 占位 */}
          {(reviewEventsError || reviewEventsLoading || reviewEvents.length > 0) && (
            <Card tone="subtle" padding="sm">
              <SectionLabel>{t('admin.reviewEventsTitle')}</SectionLabel>
              {reviewEventsError && <Alert tone="error">{reviewEventsError}</Alert>}
              {reviewEventsLoading && reviewEvents.length === 0 ? (
                <Spinner size="sm" label={t('admin.reviewEventsLoading')} />
              ) : (
                reviewEvents.length > 0 && (
                  <>
                    <ul className={shell.history}>
                      {reviewEvents.map((ev) => (
                        <li key={ev.id} className={shell.historyItem}>
                          <span className={shell.historyHead}>
                            {ev.action && <strong>{t(EVENT_ACTION_KEYS[ev.action] ?? 'adminHistory.other')}</strong>}
                            <span>
                              {t('admin.statusTransition', {
                                from: t(ANY_STATUS_LABEL_KEYS[ev.fromStatus] ?? ev.fromStatus),
                                to: t(ANY_STATUS_LABEL_KEYS[ev.toStatus] ?? ev.toStatus),
                              })}
                            </span>
                          </span>
                          {/* 操作者单独一行（不和状态变化用圆点串在一起，窄屏换行时圆点会落到行首） */}
                          {ev.reviewer?.displayName && (
                            <span>
                              {/* 作者自己的提交 / 撤回：操作者是作者，不是审核员 */}
                              {ev.action && AUTHOR_ACTIONS.includes(ev.action)
                                ? t('adminHistory.authorPrefix')
                                : t('admin.reviewerPrefix')}
                              {ev.reviewer.displayName}
                            </span>
                          )}
                          {ev.publicNote && (
                            <span>
                              {t('admin.notePrefix')}
                              {ev.publicNote}
                            </span>
                          )}
                          {/* 内部备注（接口按 contribution:internal-note:read 下发）：隐藏 / 删除等处置的
                              说明只记在这里，不展示的话正文上方只看得到最近一次审核结论的备注 */}
                          {ev.internalNote && (
                            <span>
                              {t('adminHistory.internalNotePrefix')}
                              {ev.internalNote}
                            </span>
                          )}
                          {ev.createdAt ? <span className={shell.historyTime}>{formatTs(ev.createdAt)}</span> : null}
                        </li>
                      ))}
                    </ul>
                    <Pagination
                      page={reviewEventsPage}
                      totalPages={reviewEventsTotalPages}
                      total={reviewEventsTotal}
                      pageSize={REVIEW_EVENTS_PAGE_SIZE}
                      disabled={reviewEventsLoading || detailLoading}
                      onChange={(p) => void loadReviewEvents(selected.id, p)}
                    />
                  </>
                )
              )}
            </Card>
          )}

          <VersionHistoryCard versions={versions} comparing={compareVersion} onCompare={setCompareVersion} />
        </div>
      </div>

      <ReasonPromptDialog
        open={reasonDialog?.kind === 'reopen'}
        title={t('adminContributions.reopenTitle')}
        prompt={t('adminContributions.reopenPrompt')}
        placeholder={t('admin.reasonPlaceholder')}
        value={actionReason}
        onChange={setActionReason}
        onSubmit={submitReason}
        onCancel={() => {
          setReasonDialog(null)
          setReasonError('')
        }}
        submitText={t('adminContributions.reopenButton')}
        cancelText={t('admin.cancelReason')}
        maxLength={200}
        counterText={t('admin.ui.charCount', { n: actionReason.length, max: 200 })}
        error={reasonError || undefined}
      />
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
