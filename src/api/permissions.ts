/**
 * 前端权限常量。
 *
 * 注意：前端权限仅用于 UI 级别的显示/隐藏控制（条件渲染按钮/页面），
 * 真正的权限强制由后端 admin.ts ROLE_PERMISSIONS 映射与 requirePermission() 中间件执行。
 * 前后端权限映射必须保持同步，否则前端可能错误地隐藏了实际有权限的 UI 元素。
 */

import { useMemo } from 'react'

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

export function usePermissions(roles: string[]): string[] {
  return useMemo(() => computePermissions(roles), [roles])
}

/** 是否拥有某权限；'*' 通配视为拥有全部。 */
export function hasPermission(permissions: string[], permission: string): boolean {
  return permissions.includes(WILDCARD) || permissions.includes(permission)
}

/**
 * 登录/注册后的落地页：按权限选「确实有权访问」的首个管理页，否则投稿页。
 * 用于权限驱动跳转，避免把 editor / IAM 细粒度授权用户错误送到 /submit 或被守卫拒绝。
 */
export function landingPath(permissions: string[]): string {
  if (hasPermission(permissions, PERMISSIONS.CONTRIBUTION_READ)) return '/admin'
  if (hasPermission(permissions, PERMISSIONS.USER_READ)) return '/admin/users'
  if (hasPermission(permissions, PERMISSIONS.AUDIT_READ)) return '/admin/audit-logs'
  return '/submit'
}
