import { useCallback, useEffect, useRef, useState } from 'react'
import { get } from '@/api/client'

/** 内容快照的元数据（后端 §6.9 列表）。 */
export interface VersionMeta {
  id: string
  version: number
  /** created / author_edit / edit_request_applied */
  changeReason: string | null
  changedBy: { id: string; displayName: string | null } | null
  createdAt: number
}

/** 单个版本的完整快照。 */
export interface VersionSnapshot extends VersionMeta {
  title: string
  summary: string | null
  contentRaw: string
  contentFormat: string
  tags: string[]
  language: string
}

export const VERSION_PAGE_SIZE = 10

export interface VersionListState {
  items: VersionMeta[]
  page: number
  totalPages: number
  total: number
  loading: boolean
  error: string
}

/**
 * 投稿的内容版本列表（按版本倒序）。每次内容变更（创建、作者修改、修改申请应用）都有一条快照，
 * 所以第 1 页第一条就是当前内容。reloadKey 变化时（详情重读后版本号变了）从第 1 页重取。
 */
export function useContributionVersions(contributionId: string, reloadKey: unknown) {
  const [state, setState] = useState<VersionListState>({
    items: [],
    page: 1,
    totalPages: 1,
    total: 0,
    loading: true,
    error: '',
  })
  const seqRef = useRef(0)

  const load = useCallback(
    async (page: number) => {
      const seq = ++seqRef.current
      setState((s) => ({ ...s, loading: true, error: '' }))
      const params = new URLSearchParams({ limit: String(VERSION_PAGE_SIZE), page: String(page) })
      const result = await get<VersionMeta[]>(
        `/admin/contributions/${encodeURIComponent(contributionId)}/versions?${params}`,
      )
      if (seq !== seqRef.current) return
      if (result.ok) {
        setState({
          items: result.data,
          page: result.pagination?.page ?? page,
          totalPages: result.pagination?.totalPages ?? 1,
          total: result.pagination?.total ?? result.data.length,
          loading: false,
          error: '',
        })
      } else {
        // 失败不清空已有列表，只给出错误与重试
        setState((s) => ({ ...s, loading: false, error: result.error.message || 'error' }))
      }
    },
    [contributionId],
  )

  useEffect(() => {
    // 拉取数据是 effect 对外部数据源的订阅；load 首行的 setState 属该模式的同步 setState
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(1)
    const seq = seqRef
    return () => {
      seq.current++
    }
  }, [load, reloadKey])

  return { ...state, load }
}

/** 取一个版本的完整快照。 */
export async function fetchVersion(contributionId: string, version: number) {
  return get<VersionSnapshot>(`/admin/contributions/${encodeURIComponent(contributionId)}/versions/${version}`)
}

/** 两组标签是否相同：逐项比较。不能拼成显示用的「、」再比——标签本身可以含这个字符，["a、b"] 和 ["a", "b"] 会被当成一样 */
export function sameTags(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((tag, i) => tag === y[i])
}

/** 正文格式的显示名（markdown / plain_text），未知值原样显示 */
export function contentFormatLabel(t: (key: string, opts?: Record<string, unknown>) => string, format: string) {
  return t(`adminVersions.formats.${format}`, { defaultValue: format })
}
