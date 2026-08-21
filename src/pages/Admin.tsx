import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/useAuth'
import { get, post } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { hasPermission, PERMISSIONS } from '@/api/permissions'
import { usePagedList } from '@/hooks/usePagedList'
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
import { Pagination } from '@/components/ui'
import shell from './Page.module.css'
import { useDetailFocus } from '@/hooks/useDetailFocus'

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
  const {
    items: submissions,
    pageIndex,
    knownPages,
    hasMore,
    stale, staleResults,
    loading,
    error,
    setError: setListError,
    reload,
    refresh,
    goToPage,
  } = usePagedList<Submission>({
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

  /* 详情拉取的竞态守卫：快速连点两行时，先发的响应可能后到并覆盖后发的；
     投票后的重拉同理。只有最新一次请求可以写入详情状态。 */
  const detailSeq = useRef(0)

  /* 关闭详情必须让在途请求一并失效——否则「返回列表」之后，一个还没回来的
     详情响应仍会通过 seq 校验并重新 setSelected，详情页会自己弹回来。 */
  /**
   * 只收起详情视图，**不碰**写操作的锁归属。
   * 供 fetchDetail 失败时使用：那不是用户主动离开，不该顺手释放别人的锁。
   */
  const clearDetailView = () => {
    // 回到列表：把焦点还给当初点开的那一行
    focusRowOnReturn(selectedIdRef.current)
    /* 理由弹窗属于刚才那条详情，必须一起收掉。留着的话它会跟着用户去到下一条
       详情：弹窗一打开就在那儿，而提交时 runHide/runDelete 读的是**当前**的
       selected——于是理由是给 A 写的，删掉的却是 B。 */
    setReasonDialog(null)
    setActionReason('')
    setReasonError('')
    detailSeq.current++
    sessionSeq.current++
    selectedIdRef.current = null
    setSelected(null)
    /* 在途详情请求会因 seq 过期而提前返回，不再走到各自的 finally；
       这两个加载态必须在这里清掉，否则关闭详情后会永远停在骨架屏。 */
    setDetailLoading(false)
    setReviewEventsLoading(false)
  }

  /** 用户主动返回列表。 */
  const closeDetail = () => {
    /* 详情侧的提示随详情一起收掉——它属于刚才那条记录，而详情分支马上就不渲染了。 */
    setDetailError('')
    /* 作废在途写操作对 submitting 锁的归属：锁是页面级的单个布尔值，而操作是
       详情级的。不作废的话，返回列表后打开另一条详情会继承一把解不开的锁，
       而旧操作结束时又会把新操作的锁一起放掉。 */
    submitSeq.current++
    setSubmitting(false)
    clearDetailView()
  }

  /* 详情会话守卫。**同步**写入，不用 effect 同步：写操作的响应可能在同一轮
     事件循环的后续 microtask 里就到达，而 effect 要等下一次提交后才跑，
     那时 ref 还是旧 id，守卫会失效。 */
  const selectedIdRef = useRef<string | null>(null)

  /* 详情**会话**序号，与上面的 detailSeq（详情**请求**竞态序号）是两回事，
     不能复用同一个计数器：
       · detailSeq —— 每次 fetchDetail 都自增，用来丢弃过期的详情响应；
       · sessionSeq —— 只在「打开另一条 / 返回列表 / 卸载」时自增，标识用户
         正在看的是哪一次会话。
     混用会出这样的错：一次刷新（旧操作成功后重读当前这条）也会自增 detailSeq，
     于是当前正在进行的那个写操作会以为「用户已经离开」，随后的 step-up 和错误
     提示全被静默丢弃——用户点的删除既不弹验证也不报错，就这么没了。 */
  const sessionSeq = useRef(0)
  /* 列表 ↔ 详情的键盘焦点接力，见 useDetailFocus 的说明。 */
  /* detailShown 只看 selected：审核历史是另一个请求，正文在它之前就渲染好了，
     detailLoading 要等历史回来才落下——拿它当判据会把焦点交得太晚。 */
  const { backRef, focusRowOnReturn } = useDetailFocus(!!selected, sessionSeq)
  const sameSession = (session: number) => sessionSeq.current === session

  /** 屏幕上打开的是否正是这条记录（不论经历过几次会话）。 */
  const viewingSame = (id: string) => selectedIdRef.current === id

  const mountedRef = useRef(true)

  /* 详情侧的错误自成一路，不能和列表的 error 共用一个通道。
     列表那份由 usePagedList 维护，每次加载都会先 setError('')；而详情里的写操作
     在后台会触发一次列表刷新（哪怕用户已经离开那条详情），刷新一开始就把详情
     刚显示出来的失败提示无声清掉了——用户以为操作成功了。 */
  const [detailError, setDetailError] = useState('')

  /* 审核/发布/隐藏等写操作的进行中锁：这些接口带 expectedVersion，
     连点两次时第二次必然版本冲突，进而触发一次对已处理条目的详情重拉。
     用一个统一的 submitting 兜住，按钮同时进入 loading 态。 */
  const [submitting, setSubmitting] = useState(false)
  /** submitting 锁的归属序号，见 closeDetail 的注释。 */
  const submitSeq = useRef(0)

  /* 详情重拉期间也要锁住操作按钮：跨会话刷新时 selected 不清空、详情连同按钮
     继续渲染，而屏幕上挂的还是旧版本号——这时点下去必然是一次注定版本冲突的
     无效写请求。 */
  const actionsLocked = submitting || detailLoading


  /**
   * 拉取详情，返回本次建立的会话序号，供调用方判断「刷回来的这一条是否还在屏幕上」。
   *
   * 两个开关分别对应两种「重拉」，不能合成一个：
   *   · `keepDraft` —— 不清正在写的备注。重拉的是**同一条**时必须为 true。
   *   · `keepOnError` —— 拉取失败时保留屏幕上那份旧详情。只在「写操作**失败**后
   *     重读版本号」时为 true：那时用户的草稿还在、还要接着改，把视图清掉等于
   *     让他白写一遍。
   *
   * 写操作**成功**后的重拉则必须 keepOnError=false：写已经生效，而这次没读回来，
   * 屏幕上那份的状态是未知的。留着它等于把过期状态和一排可用的操作按钮一起交给
   * 用户，他会基于旧状态再点一次。收起回列表（列表随后会重新加载）才是诚实的。
   *
   * 初次打开另一条详情时两者都为 false：备注必须清，失败必须收起（否则会把
   * 上一条的正文和版本号渲染在新 id 下）。
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
    setDetailLoading(true)
    /* 先复位审核历史加载态：上一条详情的历史请求可能因 seq 过期而提前返回，
       没走到 setReviewEventsLoading(false)；若新详情又无历史权限（权限变更、
       或换了条目），这个 true 会一直挂着，历史区永远停在加载中。 */
    setReviewEvents([])
    setReviewEventsLoading(false)
    try {
      const result = await get<Submission>(`/admin/contributions/${id}`)
      if (seq !== detailSeq.current) return seq // 过期响应，丢弃
      if (!result.ok) throw new Error(t('admin.errorDetail'))
      setSelected(result.data)
      if (!keepDraft) {
        setReviewNotes('')
        setInternalNote('')
      }
      // 审核历史需 contribution:audit:read（api.md §6.7）：reviewer 无该权限时
      // 不发起必 403 的无谓请求，历史区保持为空（前端无权限时后端本会拒绝）。
      if (hasPermission(permissions, PERMISSIONS.CONTRIBUTION_AUDIT_READ)) {
        setReviewEventsLoading(true)
        const eventsResult = await get<ReviewEvent[]>(`/admin/contributions/${id}/review-events`)
        if (seq !== detailSeq.current) return seq // 过期响应，丢弃
        if (eventsResult.ok) {
          setReviewEvents(eventsResult.data)
        } else {
          setReviewEvents([])
        }
        setReviewEventsLoading(false)
      }
    } catch {
      if (seq !== detailSeq.current) return seq
      /* 初次打开时拉取失败必须把详情清干净：selectedId 已经指向新条目，而
         selected 还留着上一条的数据——不清就会把上一条的正文、版本号和操作
         按钮渲染在新 id 下，用户看到的和他点的不是同一件东西。
         刷新失败则保留：屏幕上那份是有效内容，只是没能更新，清掉反而更糟。
         两种情况都用 clearDetailView 而非 closeDetail——这不是用户主动离开，
         不该顺手作废别人的锁归属。 */
      if (keepOnError) {
        setDetailError(t('admin.errorDetail'))
      } else {
        /* 详情收起后 detailError 不会再被渲染——这条必须走列表通道，否则
           「打不开这条投稿」的原因就此丢失，界面上只是默默回到了列表。 */
        clearDetailView()
        setListError(t('admin.errorDetail'))
      }
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false)
    }
    return seq
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
        /* 已经离开这条详情：error 是页面级状态，落到列表或另一条详情上会
           指向一个当前看不见的对象。改为静默刷新列表，让真实状态自己说话。 */
        if (!sameSession(session)) {
          if (mountedRef.current) void refresh()
          return
        }
        if (result.error.code === ERRORS.VERSION_CONFLICT) {
          /* 提示写在 fetchDetail **之后**：等新版本号拉回来再解锁，否则用户能在
             旧版本号仍挂在界面上时再点一次，必然又是一次冲突。
             函数式更新是为了不盖掉 fetchDetail 自己的错误——刷新都失败了的话，
             说「已刷新」是假的，那条更要紧。 */
          const refreshedSeq = await fetchDetail(actingId, { keepDraft: true, keepOnError: true })
          /* fetchDetail 自身会自增 detailSeq，所以不能再拿进入时的 session 比对。
             用它返回的序号判断：刷回来的这一条仍是屏幕上的那一条时才写提示，
             否则用户已经返回列表或打开了别的条目，提示会落到不相干的对象上。 */
          if (detailSeq.current === refreshedSeq) {
            setDetailError((cur) => cur || t('admin.versionConflictRefreshed'))
          }
        } else {
          setDetailError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      if (sameSession(session)) {
        closeDetail()
      } else if (viewingSame(actingId)) {
        /* 同一条被重新打开了（会话已经换过）：不能像同会话那样 closeDetail——
           那会把用户刚点开的详情关掉，还会递增 submitSeq、连带释放新会话里
           另一项操作的锁。这里改为刷新，让它显示操作后的新状态。
           refresh —— 不清新会话里正在写的备注，刷新失败也不收起详情。 */
        await fetchDetail(actingId, { keepDraft: true })
      }
      if (mountedRef.current) void refresh()
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : t('admin.errorReview'))
    } finally {
      if (submitSeq.current === mySeq) setSubmitting(false)
    }
  }

  const handlePublish = async () => {
    if (!selected || submitting) return
    const session = sessionSeq.current
    const mySeq = ++submitSeq.current
    setSubmitting(true)
    setDetailError('')
    const id = selected.id
    const v = selected.version || 1
    let handedOff = false
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
          /* 用户已经离开这条详情（返回列表、甚至又对另一条发起了同类操作）：
             403 时后端什么都没做，这次操作没有生效。此时绝不能再弹二次验证——
             useStepUpAction 只有一个 pendingActionRef，会把新详情正在等的那一轮
             覆盖掉；而旧回调的 onSettled 又因序号不匹配释放不了新操作的锁，
             按钮会就此永久锁死。直接放弃本次操作。 */
          if (!sameSession(session)) return
          // 交接给 step-up：重放是异步的，锁必须留到那一轮结束再释放
          handedOff = true
          runWithStepUp(doPublish, () => {
            if (submitSeq.current === mySeq) setSubmitting(false)
          })
          return
        }
        /* 已经离开这条详情：error 是页面级状态，落到列表或另一条详情上会
           指向一个当前看不见的对象。改为静默刷新列表，让真实状态自己说话。 */
        if (!sameSession(session)) {
          if (mountedRef.current) void refresh()
          return
        }
        if (result.error.code === ERRORS.VERSION_CONFLICT) {
          /* 提示写在 fetchDetail **之后**：等新版本号拉回来再解锁，否则用户能在
             旧版本号仍挂在界面上时再点一次，必然又是一次冲突。
             函数式更新是为了不盖掉 fetchDetail 自己的错误——刷新都失败了的话，
             说「已刷新」是假的，那条更要紧。 */
          const refreshedSeq = await fetchDetail(id, { keepDraft: true, keepOnError: true })
          // 同上：用 fetchDetail 返回的序号判断这一条是否仍在屏幕上
          if (detailSeq.current === refreshedSeq) {
            setDetailError((cur) => cur || t('admin.versionConflictRefreshed'))
          }
        } else {
          setDetailError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      if (sameSession(session)) {
        closeDetail()
      } else if (viewingSame(id)) {
        /* 同一条被重新打开了（会话已经换过）：不能像同会话那样 closeDetail——
           那会把用户刚点开的详情关掉，还会递增 submitSeq、连带释放新会话里
           另一项操作的锁。这里改为刷新，让它显示操作后的新状态。
           refresh —— 不清新会话里正在写的备注，刷新失败也不收起详情。 */
        await fetchDetail(id, { keepDraft: true })
      }
      if (mountedRef.current) void refresh()
    }
    try {
      await doPublish()
    } finally {
      if (!handedOff && submitSeq.current === mySeq) setSubmitting(false)
    }
  }

  const runHide = async (reason: string) => {
    if (!selected || submitting) return
    const session = sessionSeq.current
    const mySeq = ++submitSeq.current
    setSubmitting(true)
    setDetailError('')
    const id = selected.id
    const v = selected.version || 1
    let handedOff = false
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
          /* 用户已经离开这条详情（返回列表、甚至又对另一条发起了同类操作）：
             403 时后端什么都没做，这次操作没有生效。此时绝不能再弹二次验证——
             useStepUpAction 只有一个 pendingActionRef，会把新详情正在等的那一轮
             覆盖掉；而旧回调的 onSettled 又因序号不匹配释放不了新操作的锁，
             按钮会就此永久锁死。直接放弃本次操作。 */
          if (!sameSession(session)) return
          // 交接给 step-up：重放是异步的，锁必须留到那一轮结束再释放
          handedOff = true
          runWithStepUp(doHide, () => {
            if (submitSeq.current === mySeq) setSubmitting(false)
          })
          return
        }
        /* 已经离开这条详情：error 是页面级状态，落到列表或另一条详情上会
           指向一个当前看不见的对象。改为静默刷新列表，让真实状态自己说话。 */
        if (!sameSession(session)) {
          if (mountedRef.current) void refresh()
          return
        }
        if (result.error.code === ERRORS.VERSION_CONFLICT) {
          /* 提示写在 fetchDetail **之后**：等新版本号拉回来再解锁，否则用户能在
             旧版本号仍挂在界面上时再点一次，必然又是一次冲突。
             函数式更新是为了不盖掉 fetchDetail 自己的错误——刷新都失败了的话，
             说「已刷新」是假的，那条更要紧。 */
          const refreshedSeq = await fetchDetail(id, { keepDraft: true, keepOnError: true })
          // 同上：用 fetchDetail 返回的序号判断这一条是否仍在屏幕上
          if (detailSeq.current === refreshedSeq) {
            setDetailError((cur) => cur || t('admin.versionConflictRefreshed'))
          }
        } else {
          setDetailError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      if (sameSession(session)) {
        closeDetail()
      } else if (viewingSame(id)) {
        /* 同一条被重新打开了（会话已经换过）：不能像同会话那样 closeDetail——
           那会把用户刚点开的详情关掉，还会递增 submitSeq、连带释放新会话里
           另一项操作的锁。这里改为刷新，让它显示操作后的新状态。
           refresh —— 不清新会话里正在写的备注，刷新失败也不收起详情。 */
        await fetchDetail(id, { keepDraft: true })
      }
      if (mountedRef.current) void refresh()
    }
    try {
      await doHide()
    } finally {
      if (!handedOff && submitSeq.current === mySeq) setSubmitting(false)
    }
  }

  const handleRestore = async () => {
    if (!selected || submitting) return
    const actingId = selected.id
    const v = selected.version || 1
    const session = sessionSeq.current
    const mySeq = ++submitSeq.current
    setSubmitting(true)
    setDetailError('')
    try {
      const result = await post(
        `/admin/contributions/${actingId}/restore`,
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
        /* 已经离开这条详情：error 是页面级状态，落到列表或另一条详情上会
           指向一个当前看不见的对象。改为静默刷新列表，让真实状态自己说话。 */
        if (!sameSession(session)) {
          if (mountedRef.current) void refresh()
          return
        }
        if (result.error.code === ERRORS.VERSION_CONFLICT) {
          /* 提示写在 fetchDetail **之后**：等新版本号拉回来再解锁，否则用户能在
             旧版本号仍挂在界面上时再点一次，必然又是一次冲突。
             函数式更新是为了不盖掉 fetchDetail 自己的错误——刷新都失败了的话，
             说「已刷新」是假的，那条更要紧。 */
          const refreshedSeq = await fetchDetail(actingId, { keepDraft: true, keepOnError: true })
          /* fetchDetail 自身会自增 detailSeq，所以不能再拿进入时的 session 比对。
             用它返回的序号判断：刷回来的这一条仍是屏幕上的那一条时才写提示，
             否则用户已经返回列表或打开了别的条目，提示会落到不相干的对象上。 */
          if (detailSeq.current === refreshedSeq) {
            setDetailError((cur) => cur || t('admin.versionConflictRefreshed'))
          }
        } else {
          setDetailError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      if (sameSession(session)) {
        closeDetail()
      } else if (viewingSame(actingId)) {
        /* 同一条被重新打开了（会话已经换过）：不能像同会话那样 closeDetail——
           那会把用户刚点开的详情关掉，还会递增 submitSeq、连带释放新会话里
           另一项操作的锁。这里改为刷新，让它显示操作后的新状态。
           refresh —— 不清新会话里正在写的备注，刷新失败也不收起详情。 */
        await fetchDetail(actingId, { keepDraft: true })
      }
      if (mountedRef.current) void refresh()
    } finally {
      if (submitSeq.current === mySeq) setSubmitting(false)
    }
  }

  const runDelete = async (reason: string) => {
    if (!selected || submitting) return
    const session = sessionSeq.current
    const mySeq = ++submitSeq.current
    setSubmitting(true)
    setDetailError('')
    const id = selected.id
    const v = selected.version || 1
    let handedOff = false
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
          /* 用户已经离开这条详情（返回列表、甚至又对另一条发起了同类操作）：
             403 时后端什么都没做，这次操作没有生效。此时绝不能再弹二次验证——
             useStepUpAction 只有一个 pendingActionRef，会把新详情正在等的那一轮
             覆盖掉；而旧回调的 onSettled 又因序号不匹配释放不了新操作的锁，
             按钮会就此永久锁死。直接放弃本次操作。 */
          if (!sameSession(session)) return
          // 交接给 step-up：重放是异步的，锁必须留到那一轮结束再释放
          handedOff = true
          runWithStepUp(doDelete, () => {
            if (submitSeq.current === mySeq) setSubmitting(false)
          })
          return
        }
        /* 已经离开这条详情：error 是页面级状态，落到列表或另一条详情上会
           指向一个当前看不见的对象。改为静默刷新列表，让真实状态自己说话。 */
        if (!sameSession(session)) {
          if (mountedRef.current) void refresh()
          return
        }
        if (result.error.code === ERRORS.VERSION_CONFLICT) {
          /* 提示写在 fetchDetail **之后**：等新版本号拉回来再解锁，否则用户能在
             旧版本号仍挂在界面上时再点一次，必然又是一次冲突。
             函数式更新是为了不盖掉 fetchDetail 自己的错误——刷新都失败了的话，
             说「已刷新」是假的，那条更要紧。 */
          const refreshedSeq = await fetchDetail(id, { keepDraft: true, keepOnError: true })
          // 同上：用 fetchDetail 返回的序号判断这一条是否仍在屏幕上
          if (detailSeq.current === refreshedSeq) {
            setDetailError((cur) => cur || t('admin.versionConflictRefreshed'))
          }
        } else {
          setDetailError(result.error.message || t('admin.errorReview'))
        }
        return
      }
      if (sameSession(session)) {
        closeDetail()
      } else if (viewingSame(id)) {
        /* 同一条被重新打开了（会话已经换过）：不能像同会话那样 closeDetail——
           那会把用户刚点开的详情关掉，还会递增 submitSeq、连带释放新会话里
           另一项操作的锁。这里改为刷新，让它显示操作后的新状态。
           refresh —— 不清新会话里正在写的备注，刷新失败也不收起详情。 */
        await fetchDetail(id, { keepDraft: true })
      }
      if (mountedRef.current) void refresh()
    }
    try {
      await doDelete()
    } finally {
      if (!handedOff && submitSeq.current === mySeq) setSubmitting(false)
    }
  }

  const openReasonDialog = (kind: 'hide' | 'delete') => {
    setActionReason('')
    setReasonError('')
    setDetailError('')
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

  /* 组件卸载（从顶部导航离开，而不是点页内的返回按钮）：作废所有在途会话与
     写操作，否则旧回调仍会写状态，甚至在卸载后再发一次列表请求。 */
  useEffect(() => {
      // 重新武装：StrictMode 的开发期二次挂载会先跑一遍 cleanup，ref 不会重建
    mountedRef.current = true
    const detail = detailSeq
    const session = sessionSeq
    const submit = submitSeq
    const mounted = mountedRef
    const selectedId = selectedIdRef
    return () => {
      detail.current++
      session.current++
      submit.current++
      mounted.current = false
      /* 也要清掉当前详情 id：viewingSame() 只比 id，不清的话组件已经卸载了，
         旧回调仍会认为「这条还开着」，继续写状态、甚至再发一次详情请求。 */
      selectedId.current = null
    }
  }, [])

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

    /* 游标分页拿不到总数：submissions.length 只是**当前这一页**的条数。
       只有确定「就这一页」时才敢说「共 N 篇」，否则翻到第 3 页会显示「共 5 篇」，
       而该状态下实际有 45 篇。 */
    /* 首个响应还没回来（冷启动）、或屏幕上这批已经不属于当前筛选（切换后请求失败）
       时不显示数量：前者会先宣称「共 0 篇」再跳成真实值，后者报的是上一个筛选的数。 */
    const countKnown = !(loading && submissions.length === 0) && !staleResults
    const countLabel =
      knownPages > 1 || hasMore
        ? t('admin.countPage', { count: submissions.length })
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
            {countKnown ? countLabel : null}
          </div>

          {error && <Alert tone="error">{error}</Alert>}

          {loading && submissions.length === 0 ? (
            <Skeleton rows={7} />
          ) : /* staleResults：屏幕上这批已经不属于当前筛选了（切换后新查询失败，旧结果还留着）。
             不能再把它们摆出来——它们既不是当前条件的结果，行还是可点的，点进去会
             对一个不属于本视图的条目执行操作。此时只显示上面的错误提示。 */
          staleResults ? null : submissions.length === 0 ? (
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
                    <button
                      type="button"
                      data-row-id={s.id}
                      className={shell.rowBtn}
                      onClick={() => fetchDetail(s.id)}
                    >
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
            </>
          )}

          {/* 分页留在空态判断之外：翻到后续页时若该页恰好为空
              （并发删除、状态变更、游标过期），读者仍需要能退回上一页。
              控件本身在只有一页时会自行隐藏。 */}
          <Pagination
            pageIndex={pageIndex}
            knownPages={knownPages}
            hasMore={hasMore}
            disabled={loading || stale}
            onChange={goToPage}
          />
        </div>
        {/* step-up 宿主必须在列表分支也渲染：写操作进行中返回列表会卸载详情分支，
            届时待重放的操作和验证框会一起消失，操作既无法完成、锁也无从释放。 */}
        {stepUpElement}
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
        <AdminButton ref={backRef} variant="ghost" size="sm" onClick={closeDetail}>
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

          {detailError && <Alert tone="error">{detailError}</Alert>}

          {isReviewable && (
            <div className={shell.stackSm}>
              {/* 提交期间冻结：请求带走的是点按钮那一刻的备注，此时还能改的话，
                  屏幕上显示的和实际发出去的就不是同一份。 */}
              <TextArea
                value={reviewNotes}
                disabled={submitting}
                onChange={(e) => setReviewNotes(e.target.value)}
                placeholder={t('admin.reviewTextareaPlaceholder')}
              />
              {/* 内部备注输入：与后端一致，需 contribution:internal-note:read 权限 */}
              {canInternalNote && (
                <TextArea
                  value={internalNote}
                  disabled={submitting}
                  onChange={(e) => setInternalNote(e.target.value)}
                  placeholder={t('admin.internalNotePlaceholder')}
                />
              )}
              <div className={shell.actions}>
                {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_REVIEW) && (
                  <AdminButton variant="primary" loading={submitting} disabled={detailLoading} onClick={() => handleReview('approved')}>
                    {t('admin.approve')}
                  </AdminButton>
                )}
                {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_REVIEW) && (
                  <AdminButton variant="danger" loading={submitting} disabled={detailLoading} onClick={() => handleReview('rejected')}>
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
                <AdminButton variant="primary" loading={submitting} disabled={detailLoading} onClick={handlePublish}>
                  {t('admin.publishButton')}
                </AdminButton>
              )}
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
                <AdminButton variant="danger" disabled={actionsLocked} onClick={() => openReasonDialog('delete')}>
                  {t('admin.deleteButton')}
                </AdminButton>
              )}
            </div>
          )}
          {selected.status === 'published' && (
            <div className={shell.actions}>
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_HIDE) && (
                <AdminButton variant="danger" disabled={actionsLocked} onClick={() => openReasonDialog('hide')}>
                  {t('admin.hideButton')}
                </AdminButton>
              )}
            </div>
          )}
          {selected.status === 'hidden' && (
            <div className={shell.actions}>
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_RESTORE) && (
                <AdminButton variant="primary" loading={submitting} disabled={detailLoading} onClick={handleRestore}>
                  {t('admin.restoreButton')}
                </AdminButton>
              )}
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
                <AdminButton variant="danger" disabled={actionsLocked} onClick={() => openReasonDialog('delete')}>
                  {t('admin.deleteButton')}
                </AdminButton>
              )}
            </div>
          )}
          {selected.status === 'rejected' && (
            <div className={shell.actions}>
              {hasPermission(permissions, PERMISSIONS.CONTRIBUTION_DELETE) && (
                <AdminButton variant="danger" disabled={actionsLocked} onClick={() => openReasonDialog('delete')}>
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
