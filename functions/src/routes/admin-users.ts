import { Router } from 'express'
import { query, queryOne, exec, getConnection } from '../Database'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { requireAuth, requireReviewer } from '../middleware/auth'
import { revokeUserSessions } from '../utils/session'
import { writeAuditLog } from '../utils/audit'
import { genId } from '../utils/ulid'
import { requirePerm } from '../utils/permissions'

const router: Router = Router()
router.use(requireAuth, requireReviewer)

function getParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]
  return value ?? ''
}

// GET /admin/users — api.md §7.1
router.get('/users', requirePerm('user:read'), async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100)
  const cursor = req.query.cursor as string | undefined
  const keyword = req.query.keyword as string | undefined
  const status = req.query.status as string | undefined
  const role = req.query.role as string | undefined

  let whereClause = 'WHERE 1=1'
  const params: unknown[] = []

  if (keyword) {
    whereClause += ` AND (u.username LIKE ? OR u.email LIKE ? OR u.displayName LIKE ?)`
    const kw = `%${keyword}%`
    params.push(kw, kw, kw)
  }
  if (status) {
    whereClause += ` AND u.status = ?`
    params.push(status)
  }
  if (role) {
    whereClause += ` AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = u.id AND r.name = ?)`
    params.push(role)
  }
  if (cursor) {
    whereClause += ` AND u.createdAt < ?`
    params.push(parseInt(Buffer.from(cursor, 'base64url').toString('utf-8'), 10))
  }

  params.push(limit + 1)

  const rows = await query(
    `SELECT u.id, u.username, u.displayName, u.email, u.emailVerified, u.status, u.createdAt, u.lastLoginAt
     FROM users u ${whereClause} ORDER BY u.createdAt DESC LIMIT ?`,
    params,
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  const data = await Promise.all((rows as Array<Record<string, unknown>>).map(async (r) => {
    let roles: string[] = []
    try {
      const roleRows = await query(
        `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = ?`,
        [r.id],
      )
      roles = (roleRows as Array<{ name: string }>).map(rr => rr.name)
    } catch { /* no roles */ }
    return {
      id: r.id, username: r.username, displayName: r.displayName,
      email: r.email, emailVerified: !!r.emailVerified,
      status: r.status, roles,
      createdAt: r.createdAt, lastLoginAt: r.lastLoginAt || null,
    }
  }))

  const nextCursor = hasMore && rows.length > 0
    ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).createdAt)).toString('base64url')
    : null

  sendSuccess(res, data, req.requestId, 200, { nextCursor, hasMore, limit })
})

// GET /admin/users/:id — api.md §7.2
router.get('/users/:id', requirePerm('user:read'), async (req, res) => {
  const row = await queryOne(
    `SELECT * FROM users WHERE id = ?`,
    [req.params.id],
  )

  if (!row) {
    sendError(res, Errors.USER_NOT_FOUND.code, '用户不存在', req.requestId, Errors.USER_NOT_FOUND.status)
    return
  }

  const oauthAccounts = await query(
    `SELECT provider, providerUsername, createdAt as boundAt FROM oauth_accounts WHERE userId = ?`,
    [req.params.id],
  ) as unknown as Array<Record<string, unknown>>

  const passkeyCount = await queryOne(
    `SELECT COUNT(*) as cnt FROM passkeys WHERE userId = ? AND status = 'active'`,
    [req.params.id],
  )

  const totpEnabled = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'active' LIMIT 1`,
    [req.params.id],
  )

  // Fetch actual roles with grant metadata per api.md §7.2
  const userRoles = await query(
    `SELECT r.name, ur.grantedBy, ur.createdAt, ur.expiresAt
     FROM user_roles ur JOIN roles r ON r.id = ur.roleId
     WHERE ur.userId = ?`,
    [req.params.id],
  ) as unknown as Array<Record<string, unknown>>

  const roles = userRoles.map((ur) => ({
    id: `role_${ur.name as string}`,
    name: ur.name,
    grantedBy: ur.grantedBy || '',
    createdAt: ur.createdAt || 0,
    expiresAt: ur.expiresAt || null,
  }))

  sendSuccess(res, {
    id: row.id, username: row.username, displayName: row.displayName,
    email: row.email, emailVerified: !!row.emailVerified,
    avatarUrl: row.avatarUrl || null, status: row.status,
    roles,
    oauthAccounts: oauthAccounts.map((a: Record<string, unknown>) => ({
      provider: a.provider, providerUsername: a.providerUsername, boundAt: a.boundAt,
    })),
    security: {
      hasPassword: !!(row as Record<string, unknown>).passwordHash,
      totpEnabled: !!totpEnabled,
      passkeyCount: (passkeyCount?.cnt as number) || 0,
    },
    createdAt: row.createdAt, lastLoginAt: row.lastLoginAt || null,
  }, req.requestId)
})

// POST /admin/users/:id/ban — api.md §7.5
router.post('/users/:id/ban', requirePerm('user:ban'), async (req, res) => {
  const userId = getParamString(req.params.id)
  const reason = (req.body?.reason as string) || ''
  if (!reason) {
    sendError(res, Errors.VALIDATION_ERROR.code, '封禁原因必填', req.requestId, 422)
    return
  }

  const user = await queryOne(`SELECT id, status FROM users WHERE id = ?`, [userId])
  if (!user) {
    sendError(res, Errors.USER_NOT_FOUND.code, '用户不存在', req.requestId, Errors.USER_NOT_FOUND.status)
    return
  }

  await exec(`UPDATE users SET status = 'banned', tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ?`, [Date.now(), userId])
  await revokeUserSessions(userId, 'account_banned')

  // Freeze all active passkeys per api.md §7.5
  await exec(`UPDATE passkeys SET status = 'frozen', frozenReason = 'account_banned' WHERE userId = ? AND status = 'active'`, [userId])
  // Disable MFA TOTP per api.md §7.5
  await exec(`UPDATE mfa_totp_credentials SET status = 'disabled' WHERE userId = ? AND status = 'active'`, [userId])

  // Count revoked sessions
  const bannedSessions = await queryOne(
    `SELECT COUNT(*) as cnt FROM sessions WHERE userId = ? AND revokedReason = 'account_banned'`,
    [userId],
  )

  // Audit log
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'user.ban',
    resourceType: 'user',
    resourceId: userId,
    after: { reason },
  })

  sendSuccess(res, { userId: userId, status: 'banned', revokedSessions: (bannedSessions?.cnt as number) || 0 }, req.requestId)
})

// POST /admin/users/:id/unban — api.md §7.5
router.post('/users/:id/unban', requirePerm('user:ban'), async (req, res) => {
  const userId = getParamString(req.params.id)
  const reason = (req.body?.reason as string) || ''
  if (!reason) {
    sendError(res, Errors.VALIDATION_ERROR.code, '解封原因必填', req.requestId, 422)
    return
  }

  const user = await queryOne(`SELECT id, status FROM users WHERE id = ?`, [userId])
  if (!user) {
    sendError(res, Errors.USER_NOT_FOUND.code, '用户不存在', req.requestId, Errors.USER_NOT_FOUND.status)
    return
  }

  await exec(`UPDATE users SET status = 'active', tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ?`, [Date.now(), userId])

  // Audit log
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'user.unban',
    resourceType: 'user',
    resourceId: userId,
    after: { reason },
  })

  sendSuccess(res, { userId: userId, status: 'active', revokedSessions: 0 }, req.requestId)
})

// POST /admin/users/:id/roles — api.md §7.3 授予角色
router.post('/users/:id/roles', requirePerm('role:grant'), async (req, res) => {
  const userId = getParamString(req.params.id)
  const { roleId, expiresAt } = req.body as { roleId?: string; expiresAt?: number | null }
  if (!roleId) {
    sendError(res, Errors.VALIDATION_ERROR.code, 'roleId 必填', req.requestId, 422)
    return
  }

  const targetUser = await queryOne(`SELECT id FROM users WHERE id = ?`, [userId])
  if (!targetUser) {
    sendError(res, Errors.USER_NOT_FOUND.code, '用户不存在', req.requestId, Errors.USER_NOT_FOUND.status)
    return
  }

  // 禁止给自己加角色（防误操作）
  if (userId === req.user!.userId) {
    sendError(res, 'CANNOT_GRANT_SELF', '不能给自己授予角色，请找其他管理员操作', req.requestId, 403)
    return
  }

  const roleRow = await queryOne(`SELECT id, name FROM roles WHERE id = ?`, [roleId])
  if (!roleRow) {
    sendError(res, 'ROLE_NOT_FOUND', '角色不存在', req.requestId, 404)
    return
  }

  // Check if already granted
  const existingGrant = await queryOne(
    `SELECT id FROM user_roles WHERE userId = ? AND roleId = ?`,
    [userId, roleId],
  )
  if (existingGrant) {
    sendError(res, 'ROLE_ALREADY_GRANTED', '用户已拥有该角色', req.requestId, 409)
    return
  }

  const now = Date.now()
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    await conn.execute(
      `INSERT INTO user_roles (id, userId, roleId, grantedBy, createdAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [genId('ur_'), userId, roleId, req.user!.userId, now, expiresAt || null],
    )

    // Invalidate all sessions — role change requires re-login
    await conn.execute(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [userId])
    await conn.execute(`UPDATE sessions SET revokedAt = ?, revokedReason = 'role_changed' WHERE userId = ? AND revokedAt IS NULL`, [now, userId])
    await conn.execute(
      `UPDATE refresh_token_events SET status = 'revoked'
       WHERE sessionId IN (SELECT id FROM sessions WHERE userId = ? AND revokedAt = ?)
         AND status IN ('active', 'rotated')`,
      [userId, now],
    )

    await conn.commit()

    const revoked = await queryOne(
      `SELECT COUNT(*) as cnt FROM sessions WHERE userId = ? AND revokedReason = 'role_changed'`,
      [userId],
    )

    // Audit log
    await writeAuditLog(req, {
      actorUserId: req.user!.userId,
      action: 'role.grant',
      resourceType: 'user',
      resourceId: userId,
      after: { roleId, roleName: roleRow.name, expiresAt: expiresAt || null },
    })

    sendSuccess(res, {
      userId,
      roleId,
      grantedBy: req.user!.userId,
      createdAt: now,
      expiresAt: expiresAt || null,
      revokedSessions: (revoked?.cnt as number) || 0,
    }, req.requestId, 201)
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('Role grant error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '角色授予失败', req.requestId, 500)
  } finally {
    conn.release()
  }
})

// DELETE /admin/users/:id/roles/:roleId — api.md §7.4 撤销角色
router.delete('/users/:id/roles/:roleId', requirePerm('role:revoke'), async (req, res) => {
  const userId = getParamString(req.params.id)
  const roleId = getParamString(req.params.roleId)

  const existingGrant = await queryOne(
    `SELECT ur.id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = ? AND ur.roleId = ?`,
    [userId, roleId],
  )
  if (!existingGrant) {
    sendError(res, 'ROLE_NOT_FOUND', '该用户没有此角色', req.requestId, 404)
    return
  }

  const now = Date.now()
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    await conn.execute(`DELETE FROM user_roles WHERE userId = ? AND roleId = ?`, [userId, roleId])

    // Invalidate sessions
    await conn.execute(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [userId])
    await conn.execute(`UPDATE sessions SET revokedAt = ?, revokedReason = 'role_changed' WHERE userId = ? AND revokedAt IS NULL`, [now, userId])
    await conn.execute(
      `UPDATE refresh_token_events SET status = 'revoked'
       WHERE sessionId IN (SELECT id FROM sessions WHERE userId = ? AND revokedAt = ?)
         AND status IN ('active', 'rotated')`,
      [userId, now],
    )

    await conn.commit()

    const revoked = await queryOne(
      `SELECT COUNT(*) as cnt FROM sessions WHERE userId = ? AND revokedReason = 'role_changed'`,
      [userId],
    )

    // Audit log
    await writeAuditLog(req, {
      actorUserId: req.user!.userId,
      action: 'role.revoke',
      resourceType: 'user',
      resourceId: userId,
      after: { roleId, roleName: existingGrant.name },
    })

    sendSuccess(res, {
      userId,
      roleId,
      revokedSessions: (revoked?.cnt as number) || 0,
    }, req.requestId)
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('Role revoke error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '角色撤销失败', req.requestId, 500)
  } finally {
    conn.release()
  }
})

export default router
