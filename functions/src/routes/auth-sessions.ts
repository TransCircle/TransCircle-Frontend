import { Router } from 'express'
import { query, queryOne, exec } from '../Database'
import { sendSuccess, sendError, Errors, sendNoContent } from '../utils/response'
import { requireAuth } from '../middleware/auth'
import { revokeUserSessions, revokeSession } from '../utils/session'
import { writeAuditLog } from '../utils/audit'

const router: Router = Router()

// GET /auth/session — api.md §1.11.1
router.get('/auth/session', requireAuth, async (req, res) => {
  const user = await queryOne(
    `SELECT id, username, displayName, avatarUrl, emailVerified, status
     FROM users WHERE id = ?`,
    [req.user!.userId],
  )

  if (!user) {
    sendError(res, Errors.UNAUTHORIZED.code, Errors.UNAUTHORIZED.message, req.requestId, Errors.UNAUTHORIZED.status)
    return
  }

  // Fetch actual roles from DB (api.md §15.10)
  let roles: string[] = []
  try {
    const roleRows = await query(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.roleId WHERE ur.userId = ?`,
      [req.user!.userId],
    )
    roles = (roleRows as Array<{ name: string }>).map(r => r.name)
  } catch { /* no roles */ }

  const session = await queryOne(
    `SELECT id, createdAt, expiresAt FROM sessions WHERE id = ?`,
    [req.user!.sessionId],
  )

  sendSuccess(res, {
    user: {
      id: user.id, username: user.username, displayName: user.displayName,
      avatarUrl: user.avatarUrl, emailVerified: !!user.emailVerified,
      roles,
    },
    session: session ? {
      id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt,
    } : null,
  }, req.requestId)
})

// POST /auth/logout-all — api.md §1.11.4
router.post('/auth/logout-all', requireAuth, async (req, res) => {
  await revokeUserSessions(req.user!.userId, 'logout_all')
  await exec(`UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?`, [req.user!.userId])

  // Audit log
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'session.revoke_all',
    resourceType: 'session',
    resourceId: req.user!.userId,
    after: { revokedReason: 'logout_all' },
  })

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
    `SELECT s.id, s.createdAt, s.lastUsedAt, s.expiresAt, s.ipPrefix, s.userAgentHash, s.loginMethod, s.deviceSummary
     FROM sessions s
     ${whereClause}
     ORDER BY s.createdAt DESC
     LIMIT ?`,
    params,
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  const data = (rows as Array<Record<string, unknown>>).map((s) => {
    const deviceSummary = (() => {
      try {
        const raw = s.deviceSummary
        return typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown> || {})
      } catch { return {} }
    })() as Record<string, unknown>
    return {
      id: s.id,
      current: s.id === req.user!.sessionId,
      device: {
        browser: (deviceSummary.browser as string) || null,
        os: (deviceSummary.os as string) || null,
        type: (deviceSummary.type as string) || 'desktop',
      },
      ipPrefix: s.ipPrefix || null,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
    }
  })

  const nextCursor = hasMore
    ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).createdAt)).toString('base64url')
    : null

  sendSuccess(res, data, req.requestId, 200, { nextCursor, hasMore, limit })
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

  // Audit log per api.md §1.11.6
  writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'session.revoke',
    resourceType: 'session',
    resourceId: id,
    after: { revokedReason: 'user_revoked', sessionId: id },
  }).catch((e: unknown) => console.error('audit error:', e))

  sendNoContent(res, req.requestId)
})

export default router
