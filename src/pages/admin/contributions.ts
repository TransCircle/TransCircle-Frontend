/**
 * 审核队列、投稿管理与投稿详情共用的类型、状态词表与查询参数。
 *
 * 两个列表页和详情页的「下一条」必须用**同一套**规则把 URL 翻译成接口参数，
 * 否则连续审稿时详情页算出的「下一条」和用户刚才看到的列表对不上。
 */

export type ContributionStatus = 'pending' | 'in_review' | 'approved' | 'rejected' | 'published' | 'hidden'

export interface Submission {
  id: string
  title: string
  summary: string | null
  contentRaw?: string
  contentHtml?: string
  contentFormat?: string
  tags?: string[]
  language?: string
  status: ContributionStatus
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
  pinnedAt?: number | null
  /** 最近一条审核结论（通过 / 拒绝）：审核意见、审核人都指它（后端 §6.2） */
  review?: {
    reviewerUserId: string | null
    reviewer?: { id: string; displayName: string | null } | null
    reviewedAt: number | null
    decision: string | null
    publicNote: string | null
    internalNote: string | null
  }
  /** 最近一条审核事件（任意类型）：说明稿件是怎么来到当前状态的（作者重新提交、被重新打开……） */
  /** 内容快照号（后端 §6.2）：当前内容、最近一次审核结论时审的内容各是哪一版；不能从分页的版本列表推 */
  contentVersions?: {
    current: number | null
    atLastDecision: number | null
    /** 当前内容与上次审核结论时的内容是否一字不差（后端按内容比较，原样保存也算没改） */
    sameAsLastDecision?: boolean | null
  }
  latestEvent?: ReviewEventSummary | null
}

/** 审核事件的类型（后端 contribution_review_events.action） */
export type ReviewEventAction =
  | 'review'
  | 'publish'
  | 'hide'
  | 'restore'
  | 'delete'
  | 'reopen'
  | 'edit_request_resolve'
  | 'submit'
  | 'withdraw'

/** 作者自己的动作：操作者是作者本人，不是审核员 */
export const AUTHOR_ACTIONS: readonly string[] = ['submit', 'withdraw']

export interface ReviewEventSummary {
  action: ReviewEventAction | string
  actor: { id: string; displayName: string | null }
  fromStatus: string
  toStatus: string
  publicNote: string | null
  internalNote: string | null
  createdAt: number
}

export const STATUS_LABEL_KEYS: Record<ContributionStatus, string> = {
  pending: 'admin.statusPending',
  approved: 'admin.statusApproved',
  rejected: 'admin.statusRejected',
  in_review: 'admin.statusInReview',
  published: 'admin.statusPublished',
  hidden: 'admin.statusHidden',
}

/* 「全部」筛选和审核历史会出现状态机里的任意状态（含 draft/withdrawn/deleted），
   补全全部状态的 i18n 键，避免把后端英文枚举原样直出。 */
export const ANY_STATUS_LABEL_KEYS: Record<string, string> = {
  ...STATUS_LABEL_KEYS,
  draft: 'admin.statusDraft',
  withdrawn: 'admin.statusWithdrawn',
  deleted: 'admin.statusDeleted',
}

/** 列表每页条数：两个列表页与「下一条」查询共用，页内序号才对得上。 */
export const CONTRIBUTION_PAGE_SIZE = 20

export type ContributionListSection = 'review' | 'contributions'

export const LIST_PATHS: Record<ContributionListSection, string> = {
  review: '/admin/review',
  contributions: '/admin/contributions',
}

/* 审核队列只看待审核。「审核中」是接口契约里的状态，但当前后端没有任何流程会把投稿置为它
  （审核接口直接把 pending 改成 approved / rejected）；残留数据在投稿管理的「审核中」里仍能找到。 */
export type ReviewStatus = 'pending'

/* 顺序即选项卡顺序：已发布在先（默认视图），已通过（等待发布）紧随其后，全部放最后。 */
export const MANAGE_STATUSES = ['published', 'approved', 'hidden', 'rejected', 'pending', 'in_review', 'all'] as const
export type ManageStatus = (typeof MANAGE_STATUSES)[number]

/* 审核队列按（最近一次）提交时间排：被拒后重新提交的稿件按重新提交的时间排队，先进先出 */
export const REVIEW_SORTS = ['submittedAt_asc', 'submittedAt_desc'] as const
export type ReviewSort = (typeof REVIEW_SORTS)[number]

export const MANAGE_SORTS = ['createdAt_desc', 'createdAt_asc', 'updatedAt_desc'] as const
export type ManageSort = (typeof MANAGE_SORTS)[number]

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

export interface ContributionListQuery {
  status: string
  sort: string
  keyword: string
  authorId: string
}

/** 审核队列：只有待审核；默认按提交时间先进先出（submittedAt_asc，后端 §6.1）。 */
export function readReviewQuery(
  sp: URLSearchParams,
): ContributionListQuery & { status: ReviewStatus; sort: ReviewSort } {
  return {
    status: 'pending',
    sort: pick(sp.get('sort'), REVIEW_SORTS, 'submittedAt_asc'),
    keyword: '',
    authorId: '',
  }
}

/** 投稿管理：默认看已发布——上线后最常做的是置顶、隐藏这些已发布内容。 */
export function readManageQuery(
  sp: URLSearchParams,
): ContributionListQuery & { status: ManageStatus; sort: ManageSort } {
  return {
    status: pick(sp.get('status'), MANAGE_STATUSES, 'published'),
    sort: pick(sp.get('sort'), MANAGE_SORTS, 'createdAt_desc'),
    keyword: (sp.get('q') ?? '').trim(),
    authorId: (sp.get('author') ?? '').trim(),
  }
}

export function readQuery(section: ContributionListSection, sp: URLSearchParams): ContributionListQuery {
  return section === 'review' ? readReviewQuery(sp) : readManageQuery(sp)
}

/** 列表接口的查询参数（apidocs §6.1）。status=all 即不传 status。 */
export function toApiParams(query: ContributionListQuery, page: number): URLSearchParams {
  const params = new URLSearchParams({ limit: String(CONTRIBUTION_PAGE_SIZE), page: String(page), sort: query.sort })
  if (query.status && query.status !== 'all') params.set('status', query.status)
  if (query.keyword) params.set('keyword', query.keyword)
  if (query.authorId) params.set('authorId', query.authorId)
  return params
}

/** 详情页的 from 落点属于哪个列表分区；不是这两个列表（或解析失败）时返回 null。 */
export function parseListHref(
  href: string | null | undefined,
): { section: ContributionListSection; params: URLSearchParams } | null {
  if (!href) return null
  try {
    const url = new URL(href, window.location.origin)
    if (url.origin !== window.location.origin) return null
    const path = url.pathname.replace(/\/+$/, '').toLowerCase()
    const section = (Object.keys(LIST_PATHS) as ContributionListSection[]).find((s) => LIST_PATHS[s] === path)
    return section ? { section, params: url.searchParams } : null
  } catch {
    return null
  }
}

/** 审核队列的处理对象：待审核与审核中。 */
export function isReviewable(status: string): boolean {
  return status === 'pending' || status === 'in_review'
}
