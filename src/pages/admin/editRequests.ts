/** 修改申请的类型与字段读取（列表、详情共用）。 */

export interface EditRequestItem {
  id: string
  status: string
  version: number
  reason: string
  requester: {
    id: string
    displayName: string
  }
  // Nested structure (api.md §10.5)
  // 详情接口还会带回原投稿的当前内容（用于「当前 → 改为」对照）、状态与版本
  contribution?: {
    id: string
    title: string
    summary?: string | null
    contentRaw?: string | null
    contentFormat?: string | null
    tags?: string[] | null
    status?: string
    version?: number
    /** 原投稿已删除：申请无法再处理 */
    deleted?: boolean
    /** 申请提交后原投稿的内容是否又被改过（以内容快照判断；旧申请为 null） */
    contentChangedSinceRequest?: boolean | null
  }
  /** 列表接口给的扁平标题 */
  contributionTitle?: string
  /** 提交申请时原投稿的 version */
  baseVersion?: number | null
  /** 申请时的内容（版本号不超过 baseVersion 的最近一份快照，后端 §10.5）；旧申请为 null */
  baseSnapshot?: {
    version: number
    title: string
    summary: string | null
    contentRaw: string
    contentFormat: string
    tags: string[]
  } | null
  proposed?: {
    title?: string | null
    summary?: string | null
    content?: string | null
    /** 只随正文生效（后端不保存没有正文的格式） */
    contentFormat?: string | null
    tags?: string[] | null
  } | null
  votes?: {
    approve: number
    reject: number
    total: number
    required: number
    history?: Array<{
      /** 投票人显示名 */
      displayName?: string | null
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

/**
 * Safely read a proposed-change field, preferring the typed `proposed` sub-object
 * and falling back to the legacy flat field.
 */
/** @deprecated 旧扁平字段映射（迁移兼容），使用属性存在性检查替代 any 断言 */
type OldFlatFieldMap = Record<string, string | string[] | null | undefined>

export function getProposedField(
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

export function getProposedFieldArray(
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
