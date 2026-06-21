/**
 * 前端权限常量。
 *
 * 注意：前端权限仅用于 UI 级别的显示/隐藏控制（条件渲染按钮/页面），
 * 真正的权限强制由后端 admin.ts ROLE_PERMISSIONS 映射与 requirePermission() 中间件执行。
 * 前后端权限映射必须保持同步，否则前端可能错误地隐藏了实际有权限的 UI 元素。
 */

import { useMemo } from 'react'

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
  ROLE_GRANT: 'role:grant',
  ROLE_REVOKE: 'role:revoke',
  AUDIT_READ: 'audit:read',
} as const

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS]

/**
 * 角色→权限映射，必须与后端 admin.ts ROLE_PERMISSIONS 保持一致。
 * 后端变更时请同步更新此表。
 */
const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: Object.values(PERMISSIONS),
  editor: [
    PERMISSIONS.CONTRIBUTION_READ,
    PERMISSIONS.CONTRIBUTION_REVIEW,
    PERMISSIONS.CONTRIBUTION_PUBLISH,
    PERMISSIONS.CONTRIBUTION_HIDE,
    PERMISSIONS.CONTRIBUTION_RESTORE,
    PERMISSIONS.CONTRIBUTION_DELETE,
    PERMISSIONS.CONTRIBUTION_AUDIT_READ,
    PERMISSIONS.CONTRIBUTION_INTERNAL_NOTE_READ,
    PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE,
  ],
  reviewer: [
    PERMISSIONS.CONTRIBUTION_READ,
    PERMISSIONS.CONTRIBUTION_REVIEW,
    PERMISSIONS.CONTRIBUTION_AUDIT_READ,
    PERMISSIONS.CONTRIBUTION_EDIT_REQUEST_VOTE,
  ],
}

export function computePermissions(roles: string[]): Permission[] {
  const result: Permission[] = []
  for (const role of roles) {
    const perms = ROLE_PERMISSIONS[role]
    if (perms) result.push(...perms)
  }
  return [...new Set(result)]
}

export function usePermissions(roles: string[]): Permission[] {
  return useMemo(() => computePermissions(roles), [roles])
}

export function hasPermission(permissions: Permission[], permission: Permission): boolean {
  return permissions.includes(permission)
}
