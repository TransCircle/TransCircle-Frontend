import { queryOne } from '../Database'
import type { Request, Response, NextFunction } from 'express'
import { sendError, Errors } from './response'

/**
 * Granular permission definitions per api.md §15.10.
 *
 * Each role maps to a set of permissions. The mapping is stored in-memory
 * for performance (role names are low-cardinality and change infrequently).
 */
const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  admin: [
    'contribution:read',
    'contribution:review',
    'contribution:publish',
    'contribution:hide',
    'contribution:restore',
    'contribution:delete',
    'contribution:audit:read',
    'contribution:internal-note:read',
    'contribution:edit-request:vote',
    'user:read',
    'user:ban',
    'role:grant',
    'role:revoke',
    'audit:read',
  ],
  editor: [
    'contribution:read',
    'contribution:review',
    'contribution:publish',
    'contribution:hide',
    'contribution:restore',
    'contribution:delete',
    'contribution:audit:read',
    'contribution:internal-note:read',
    'contribution:edit-request:vote',
    'user:read',
    'audit:read',
  ],
  reviewer: [
    'contribution:read',
    'contribution:review',
    'contribution:audit:read',
    'contribution:internal-note:read',
    'contribution:edit-request:vote',
  ],
}

/**
 * Check if a user has a specific permission by looking up their role(s)
 * and mapping to the granular permission list (api.md §15.10).
 */
export async function requirePermission(userId: string, permission: string): Promise<boolean> {
  const rows = await queryOne(
    `SELECT GROUP_CONCAT(DISTINCT r.name) as roleNames
     FROM user_roles ur
     JOIN roles r ON r.id = ur.roleId
     WHERE ur.userId = ?`,
    [userId],
  )
  if (!rows?.roleNames) return false

  const roleNames = (rows.roleNames as string).split(',')
  for (const role of roleNames) {
    const perms = ROLE_PERMISSIONS[role]
    if (perms?.includes(permission)) return true
  }
  return false
}

/**
 * Express middleware factory: requires the authenticated user to have all specified permissions.
 * Must be used after requireAuth (so req.user is set).
 *
 * Usage: router.get('/path', requirePerm('contribution:read'), handler)
 */
export function requirePerm(...permissions: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    for (const perm of permissions) {
      if (!(await requirePermission(req.user!.userId, perm))) {
        sendError(res, Errors.FORBIDDEN.code, `缺少权限: ${perm}`, req.requestId, Errors.FORBIDDEN.status)
        return
      }
    }
    next()
  }
}
