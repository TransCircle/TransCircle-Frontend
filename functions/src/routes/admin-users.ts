import { Router } from 'express'
import { query, queryOne, exec } from '../Database'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { revokeUserSessions } from '../utils/session'

const router: Router = Router()
router.use(requireAuth, requireAdmin)

// GET /admin/users — api.md §7.1
router.get('/users', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100)
  const cursor = req.query.cursor as string | undefined
  const keyword = req.query.keyword as string | undefined
  const status = req.query.status as string | undefined

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
  if (cursor) {
    whereClause += ` AND u.createdAt < ?`
    params.push(parseInt(Buffer.from(cursor, 'base64url').toString('utf-8'), 10))
  }

  params.push(limit + 1)

  const rows = await query(
    `SELECT u.id, u.username, u.displayName, u.email, u.emailVerified, u.status, u.createdAt, u.lastLoginAt,
            EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = u.id AND r.name = 'admin') AS isAdmin
     FROM users u ${whereClause} ORDER BY u.createdAt DESC LIMIT ?`,
    params,
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  const data = (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id, username: r.username, displayName: r.displayName,
    email: r.email, emailVerified: !!r.emailVerified,
    status: r.status, roles: r.isAdmin ? ['reviewer'] : [],
    createdAt: r.createdAt, lastLoginAt: r.lastLoginAt || null,
  }))

  const nextCursor = hasMore && rows.length > 0
    ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).createdAt)).toString('base64url')
    : null

  res.status(200).json({ data, pagination: { nextCursor, hasMore, limit }, requestId: req.requestId })
})

// GET /admin/users/:id — api.md §7.2
router.get('/users/:id', async (req, res) => {
  const row = await queryOne(
    `SELECT u.*,
            EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = u.id AND r.name = 'admin') AS isAdmin
     FROM users u WHERE u.id = ?`,
    [req.params.id],
  )

  if (!row) {
    sendError(res, Errors.USER_NOT_FOUND.code, '用户不存在', req.requestId, Errors.USER_NOT_FOUND.status)
    return
  }

  const oauthAccounts = await query(
    `SELECT provider, providerUsername, boundAt FROM oauth_accounts WHERE userId = ?`,
    [req.params.id],
  ) as unknown as Array<Record<string, unknown>>

  const passkeyCount = await queryOne(
    `SELECT COUNT(*) as cnt FROM passkeys WHERE userId = ? AND status = 'active'`,
    [req.params.id],
  )

  const totpEnabled = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'enabled' LIMIT 1`,
    [req.params.id],
  )

  sendSuccess(res, {
    id: row.id, username: row.username, displayName: row.displayName,
    email: row.email, emailVerified: !!row.emailVerified,
    avatarUrl: row.avatarUrl || null, status: row.status,
    roles: row.isAdmin ? [{ id: 'role_reviewer', name: 'reviewer', grantedBy: '', createdAt: 0, expiresAt: null }] : [],
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
router.post('/users/:id/ban', async (req, res) => {
  const reason = (req.body?.reason as string) || ''
  if (!reason) {
    sendError(res, Errors.VALIDATION_ERROR.code, '封禁原因必填', req.requestId, 422)
    return
  }

  const user = await queryOne(`SELECT id, status FROM users WHERE id = ?`, [req.params.id])
  if (!user) {
    sendError(res, Errors.USER_NOT_FOUND.code, '用户不存在', req.requestId, Errors.USER_NOT_FOUND.status)
    return
  }

  await exec(`UPDATE users SET status = 'banned', tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ?`, [Date.now(), req.params.id])
  await revokeUserSessions(req.params.id, 'account_banned')

  sendSuccess(res, { userId: req.params.id, status: 'banned', revokedSessions: 0 }, req.requestId)
})

// POST /admin/users/:id/unban — api.md §7.5
router.post('/users/:id/unban', async (req, res) => {
  const user = await queryOne(`SELECT id, status FROM users WHERE id = ?`, [req.params.id])
  if (!user) {
    sendError(res, Errors.USER_NOT_FOUND.code, '用户不存在', req.requestId, Errors.USER_NOT_FOUND.status)
    return
  }

  await exec(`UPDATE users SET status = 'active', tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ?`, [Date.now(), req.params.id])

  sendSuccess(res, { userId: req.params.id, status: 'active', revokedSessions: 0 }, req.requestId)
})

export default router
