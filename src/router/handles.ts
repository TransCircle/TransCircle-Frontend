/** 后台左栏的分区。详情页借用它所属列表的分区，左栏据此标出当前项。 */
export type AdminSection = 'overview' | 'review' | 'contributions' | 'editRequests' | 'comments' | 'users' | 'auditLogs'

/**
 * 路由 handle 约定：
 * - shell：由专门外壳持有唯一 <main> 的路由；
 * - notFound：通配 404；
 * - titleKey：页面标题（document.title）与后台标题栏的兜底标题；
 * - adminSection：后台左栏的当前分区。
 */
export interface RouteHandle {
  shell?: 'admin'
  notFound?: boolean
  titleKey?: string
  adminSection?: AdminSection
}

type Match = { handle: unknown }

const handleOf = (match: Match) => match.handle as RouteHandle | undefined

/** useMatches() 的元素是否为 AdminShell 路由。 */
export function isAdminShellMatch(match: Match): boolean {
  return handleOf(match)?.shell === 'admin'
}

/** useMatches() 的元素是否为通配 404 路由（/admin/users/不存在 这类前缀相似的路径也落在这里）。 */
export function isNotFoundMatch(match: Match): boolean {
  return handleOf(match)?.notFound === true
}

/** 最深一层声明了 titleKey 的路由的标题键。 */
export function matchedTitleKey(matches: readonly Match[]): string | undefined {
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]
    const key = match && handleOf(match)?.titleKey
    if (key) return key
  }
  return undefined
}

/** 最深一层声明的后台分区。 */
export function matchedAdminSection(matches: readonly Match[]): AdminSection | undefined {
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]
    const section = match && handleOf(match)?.adminSection
    if (section) return section
  }
  return undefined
}
