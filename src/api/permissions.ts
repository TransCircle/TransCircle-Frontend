import { useMemo } from 'react'

export const PERMISSIONS = {
  CONTRIBUTION_REVIEW: 'contribution:review',
  CONTRIBUTION_PUBLISH: 'contribution:publish',
  CONTRIBUTION_HIDE: 'contribution:hide',
  CONTRIBUTION_RESTORE: 'contribution:restore',
  CONTRIBUTION_DELETE: 'contribution:delete',
  USER_READ: 'user:read',
  AUDIT_READ: 'audit:read',
} as const

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS]

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: Object.values(PERMISSIONS),
  reviewer: [
    PERMISSIONS.CONTRIBUTION_REVIEW,
    PERMISSIONS.CONTRIBUTION_PUBLISH,
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
