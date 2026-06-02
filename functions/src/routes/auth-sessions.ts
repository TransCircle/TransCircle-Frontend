import { Router } from 'express'
import { query, queryOne, exec } from '../Database'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { requireAuth } from '../middleware/auth'
import { revokeUserSessions, revokeSession } from '../utils/session'

const router: Router = Router()

// GET /auth/session — api.md §1.11.1
router.get('/session', requireAuth, async (req, res) => {
  const user = await queryOne(
    `SELECT u.id, u.username, u.displayName, u.avatarUrl, u.emailVerified, u.status,
            EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = u.id AND r.name = 'admin') AS isAdmin
     FROM users u WHERE u.id = ?`,
    [req.user!.userId],
  )

  if (!user) {
    sendError(res, Errors.UNAUTHORIZED.code, Errors.UNAUTHORIZED.message, req.requestId, Errors.UNAUTHORIZED.status)
    return
  }

  const session = await queryOne(
    `SELECT id, createdAt, expiresAt FROM sessions WHERE id = ?`,
    [req.user!.sessionId],
  )

  sendSuccess(res, {
    user: {
      id: user.id, username: user.username, displayName: user.displayName,
      avatarUrl: user.avatarUrl, emailVerified: !!user.emailVerified,
      roles: user.isAdmin ? ['reviewer'] : [],
    },
    session: session ? {
      id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt,
    } : null,
  }, req.requestId)
})

// POST /auth/logout-all — api.md §1.11.4
router.post('/logout-all', requireAuth, async (req, res) => {
  await revokeUserSessions(req.user!.userId, 'logout_all')
  await exec(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [req.user!.userId])

  // Count revoked sessions
  const count = await queryOne(
    `SELECT COUNT(*) as cnt FROM sessions WHERE userId = ? AND revokedReason = 'logout_all'`,
    [req.user!.userId],
  )

  sendSuccess(res, { revokedSessions: (count?.cnt as number) || 1 }, req.requestId)
})

// GET /me/sessions — api.md §1.11.5
router.get('/me/sessions', requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100)
  const cursor = req.query.cursor as string | undefined

  let whereClause = `WHERE s.userId = ? AND s.revokedAt IS NULL`
  const params: unknown[] = [req.user!.userId]

  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf-8')
      whereClause += ` AND s.createdAt < ?`
      params.push(parseInt(decoded, 10))
    } catch {
      sendError(res, Errors.VALIDATION_ERROR.code, '无效的 cursor', req.requestId, Errors.VALIDATION_ERROR.status)
      return
    }
  }

  params.push(limit + 1)

  const rows = await query(
    `SELECT s.id, s.createdAt, s.lastUsedAt, s.expiresAt, s.ipPrefix, s.userAgentHash, s.loginMethod
     FROM sessions s
     ${whereClause}
     ORDER BY s.createdAt DESC
     LIMIT ?`,
    params,
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  const data = (rows as Array<Record<string, unknown>>).map((s) => ({
    id: s.id,
    current: s.id === req.user!.sessionId,
    device: {
      browser: null, os: null, type: 'unknown',
    },
    ipPrefix: s.ipPrefix || null,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    expiresAt: s.expiresAt,
  }))

  const nextCursor = hasMore
    ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).createdAt)).toString('base64url')
    : null

  res.status(200).json({
    data,
    pagination: { nextCursor, hasMore, limit },
    requestId: req.requestId,
  })
})

// DELETE /me/sessions/{id} — api.md §1.11.6
router.delete('/me/sessions/:id', requireAuth, async (req, res) => {
  const { id } = req.params
  const session = await queryOne(
    `SELECT id FROM sessions WHERE id = ? AND userId = ? AND revokedAt IS NULL`,
    [id, req.user!.userId],
  )

  if (!session) {
    sendError(res, 'SESSION_NOT_FOUND', 'session 不存在', req.requestId, 404)
    return
  }

  await revokeSession(id as string, 'user_revoked')
  res.status(204).end()
})

export default router
