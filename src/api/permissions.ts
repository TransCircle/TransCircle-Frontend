/**
 * 前端权限常量。
 *
 * 注意：前端权限仅用于 UI 级别的显示/隐藏控制（条件渲染按钮/页面），
 * 真正的权限强制由后端 admin.ts ROLE_PERMISSIONS 映射与 requirePermission() 中间件执行。
 * 前后端权限映射必须保持同步，否则前端可能错误地隐藏了实际有权限的 UI 元素。
 */

/**
 * 细粒度权限常量（与后端 src/utils/permissions.ts / iam-admin-api.md §4.1 对齐）。
 *
 * 改造后权限的权威来源是后端 /v1/me 返回的 `permissions`（来自 IAM 登录快照）。
 * 前端优先消费该列表；computePermissions 仅作旧 payload 的回退。
 */
export const PERMISSIONS = {
  CONTRIBUTION_READ: 'contribution:read',
  CONTRIBUTION_REVIEW: 'contribution:review',
  CONTRIBUTION_PUBLISH: 'contribution:publish',
  CONTRIBUTION_HIDE: 'contribution:hide',
  CONTRIBUTION_RESTORE: 'contribution:restore',
  COMMENT_MODERATE: 'comment:moderate',
  CONTRIBUTION_DELETE: 'contribution:delete',
  CONTRIBUTION_AUDIT_READ: 'contribution:audit:read',
  CONTRIBUTION_INTERNAL_NOTE_READ: 'contribution:internal-note:read',
  CONTRIBUTION_EDIT_REQUEST_VOTE: 'contribution:edit-request:vote',
  USER_READ: 'user:read',
  USER_BAN: 'user:ban',
  // 授权统一迁移到 IAM（§4.4）：本平台不再用这两个业务权限改权，常量保留仅为兼容引用
  ROLE_GRANT: 'role:grant',
  ROLE_REVOKE: 'role:revoke',
  AUDIT_READ: 'audit:read',
} as const

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

/**
 * 权限 key → i18n 文案 key 映射，用于「我的权限」等展示场景。
 * 权限 key 含冒号（i18next 的命名空间分隔符），不能直接作为翻译键路径，故集中维护安全键名。
 * 未在表内的权限（IAM 可能新增）由调用方回退展示原始 key，保证前向兼容。
 */
export const PERMISSION_LABEL_KEYS: Record<string, string> = {
  [PERMISSIONS.CONTRIBUTION_READ]: 'settings.perm.contributionRead',
  [PERMISSIONS.CONTRIBUTION_REVIEW]: 'settings.perm.contributionReview',
  [PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE]: 'settings.perm.contributionEditRequestVote',
  [PERMISSIONS.CONTRIBUTION_PUBLISH]: 'settings.perm.contributionPublish',
  [PERMISSIONS.CONTRIBUTION_HIDE]: 'settings.perm.contributionHide',
  [PERMISSIONS.CONTRIBUTION_RESTORE]: 'settings.perm.contributionRestore',
  [PERMISSIONS.COMMENT_MODERATE]: 'settings.perm.commentModerate',
  [PERMISSIONS.CONTRIBUTION_AUDIT_READ]: 'settings.perm.contributionAuditRead',
  [PERMISSIONS.CONTRIBUTION_INTERNAL_NOTE_READ]: 'settings.perm.contributionInternalNoteRead',
  [PERMISSIONS.CONTRIBUTION_DELETE]: 'settings.perm.contributionDelete',
  [PERMISSIONS.USER_READ]: 'settings.perm.userRead',
  [PERMISSIONS.USER_BAN]: 'settings.perm.userBan',
  [PERMISSIONS.AUDIT_READ]: 'settings.perm.auditRead',
  [PERMISSIONS.ROLE_GRANT]: 'settings.perm.roleGrant',
  [PERMISSIONS.ROLE_REVOKE]: 'settings.perm.roleRevoke',
}

/** 角色名 → i18n 文案 key 映射；未知角色回退展示原始名。 */
export const ROLE_LABEL_KEYS: Record<string, string> = {
  admin: 'settings.roleAdmin',
  editor: 'settings.roleEditor',
  reviewer: 'settings.roleReviewer',
}

/** 通配权限：admin 快照可能为 '*'（迁移播种 / 角色派生回退）。 */
const WILDCARD = '*'

// 与后端 ROLE_PERMISSIONS / iam-admin-api.md §4.1 保持一致；editor ⊇ reviewer。仅用于回退派生。
const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [WILDCARD],
  editor: [
    PERMISSIONS.CONTRIBUTION_READ,
    PERMISSIONS.CONTRIBUTION_REVIEW,
    PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE,
    PERMISSIONS.CONTRIBUTION_PUBLISH,
    PERMISSIONS.CONTRIBUTION_HIDE,
    PERMISSIONS.CONTRIBUTION_RESTORE,
    PERMISSIONS.COMMENT_MODERATE,
    PERMISSIONS.CONTRIBUTION_AUDIT_READ,
    PERMISSIONS.CONTRIBUTION_INTERNAL_NOTE_READ,
    PERMISSIONS.USER_READ,
  ],
  reviewer: [
    PERMISSIONS.CONTRIBUTION_READ,
    PERMISSIONS.CONTRIBUTION_REVIEW,
    PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE,
  ],
}

/** 由角色派生权限（仅回退用；正常路径应直接使用后端返回的 permissions）。 */
export function computePermissions(roles: string[]): string[] {
  const result: string[] = []
  for (const role of roles) {
    const perms = ROLE_PERMISSIONS[role]
    if (perms) result.push(...perms)
  }
  return [...new Set(result)]
}

/** 是否拥有某权限；'*' 通配视为拥有全部。 */
export function hasPermission(permissions: string[], permission: string): boolean {
  return permissions.includes(WILDCARD) || permissions.includes(permission)
}

/** 是否持有通配权限 '*'。 */
export function hasWildcard(permissions: string[]): boolean {
  return permissions.includes(WILDCARD)
}

/** 执行时需要二次验证的情况：always = 每次都要；config = 取决于站点配置（发布）；partial = 部分操作要（评论只有隐藏要）。 */
export type StepUpRule = 'always' | 'config' | 'partial'

export interface AdminPermissionInfo {
  key: string
  /** 权限名称（i18n key，沿用设置页的 settings.perm.*） */
  labelKey: string
  /** 这个权限在本站能做什么（i18n key），取自后端各接口的 requirePermission */
  scopeKey: string
  stepUp?: StepUpRule
  /** 要在后台用上它，还得同时拥有的权限（比如审核、发布都要先能打开投稿详情） */
  requires?: string
  /** 已迁移到统一身份（IAM）管理、本站不再使用 */
  legacy?: boolean
}

/**
 * 后台权限目录：与后端 routes/admin.ts、routes/comments.ts 的 requirePermission 一一对应。
 * 概览页的权限表、后台入口判断都用这一份；后端加了权限，这里要同步。
 */
export const ADMIN_PERMISSION_CATALOG: readonly AdminPermissionInfo[] = [
  {
    key: PERMISSIONS.CONTRIBUTION_READ,
    labelKey: 'settings.perm.contributionRead',
    scopeKey: 'adminPermissions.scope.contributionRead',
  },
  {
    key: PERMISSIONS.CONTRIBUTION_REVIEW,
    labelKey: 'settings.perm.contributionReview',
    scopeKey: 'adminPermissions.scope.contributionReview',
    requires: PERMISSIONS.CONTRIBUTION_READ,
  },
  {
    key: PERMISSIONS.CONTRIBUTION_PUBLISH,
    labelKey: 'settings.perm.contributionPublish',
    scopeKey: 'adminPermissions.scope.contributionPublish',
    stepUp: 'config',
    requires: PERMISSIONS.CONTRIBUTION_READ,
  },
  {
    key: PERMISSIONS.CONTRIBUTION_HIDE,
    labelKey: 'settings.perm.contributionHide',
    scopeKey: 'adminPermissions.scope.contributionHide',
    stepUp: 'always',
    requires: PERMISSIONS.CONTRIBUTION_READ,
  },
  {
    key: PERMISSIONS.CONTRIBUTION_RESTORE,
    labelKey: 'settings.perm.contributionRestore',
    scopeKey: 'adminPermissions.scope.contributionRestore',
    requires: PERMISSIONS.CONTRIBUTION_READ,
  },
  {
    key: PERMISSIONS.CONTRIBUTION_DELETE,
    labelKey: 'settings.perm.contributionDelete',
    scopeKey: 'adminPermissions.scope.contributionDelete',
    stepUp: 'always',
    requires: PERMISSIONS.CONTRIBUTION_READ,
  },
  {
    key: PERMISSIONS.CONTRIBUTION_INTERNAL_NOTE_READ,
    labelKey: 'settings.perm.contributionInternalNoteRead',
    scopeKey: 'adminPermissions.scope.contributionInternalNoteRead',
    requires: PERMISSIONS.CONTRIBUTION_READ,
  },
  {
    key: PERMISSIONS.CONTRIBUTION_AUDIT_READ,
    labelKey: 'settings.perm.contributionAuditRead',
    scopeKey: 'adminPermissions.scope.contributionAuditRead',
    requires: PERMISSIONS.CONTRIBUTION_READ,
  },
  {
    key: PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE,
    labelKey: 'settings.perm.contributionEditRequestVote',
    scopeKey: 'adminPermissions.scope.contributionEditRequestVote',
  },
  {
    key: PERMISSIONS.COMMENT_MODERATE,
    labelKey: 'settings.perm.commentModerate',
    scopeKey: 'adminPermissions.scope.commentModerate',
    stepUp: 'partial',
  },
  { key: PERMISSIONS.USER_READ, labelKey: 'settings.perm.userRead', scopeKey: 'adminPermissions.scope.userRead' },
  {
    key: PERMISSIONS.USER_BAN,
    labelKey: 'settings.perm.userBan',
    scopeKey: 'adminPermissions.scope.userBan',
    stepUp: 'always',
    requires: PERMISSIONS.USER_READ,
  },
  { key: PERMISSIONS.AUDIT_READ, labelKey: 'settings.perm.auditRead', scopeKey: 'adminPermissions.scope.auditRead' },
  {
    key: PERMISSIONS.ROLE_GRANT,
    labelKey: 'settings.perm.roleGrant',
    scopeKey: 'adminPermissions.scope.legacyRole',
    legacy: true,
  },
  {
    key: PERMISSIONS.ROLE_REVOKE,
    labelKey: 'settings.perm.roleRevoke',
    scopeKey: 'adminPermissions.scope.legacyRole',
    legacy: true,
  },
]

/**
 * 能进入审核后台的权限：持有**任一**后台权限即可进入（概览页向所有能进后台的人开放，
 * 至少能看到自己的角色与权限表）；进去之后每个分区、每张卡片、每个按钮再按各自的权限显示。
 * 全站的后台入口（Navbar、登录落点）与后台自己的分流共用这一份。
 */
export const ADMIN_ENTRY_PERMISSIONS: readonly string[] = ADMIN_PERMISSION_CATALOG.map((p) => p.key)

/** 是否持有任一后台权限。 */
export function canEnterAdmin(permissions: string[]): boolean {
  return ADMIN_ENTRY_PERMISSIONS.some((p) => hasPermission(permissions, p))
}

/**
 * 登录/注册后的落地页：有任一后台权限就去 /admin（后台外壳按权限落到首个可访问的分区），否则投稿页。
 */
export function landingPath(permissions: string[]): string {
  return canEnterAdmin(permissions) ? '/admin' : '/submit'
}
