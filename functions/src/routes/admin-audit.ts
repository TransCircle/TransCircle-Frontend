import { Router } from 'express'
import { query } from '../Database'
import { sendSuccess } from '../utils/response'
import { requireAuth, requireReviewer } from '../middleware/auth'
import { requirePerm } from '../utils/permissions'

const router: Router = Router()
router.use(requireAuth, requireReviewer)

// GET /admin/audit-logs — api.md §8
router.get('/audit-logs', requirePerm('audit:read'), async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100)
  const cursor = req.query.cursor as string | undefined
  const actorId = req.query.actorId as string | undefined
  const action = req.query.action as string | undefined
  const resourceType = req.query.resourceType as string | undefined
  const resourceId = req.query.resourceId as string | undefined

  let whereClause = 'WHERE 1=1'
  const params: unknown[] = []

  if (actorId) { whereClause += ' AND actorUserId = ?'; params.push(actorId) }
  if (action) { whereClause += ' AND action = ?'; params.push(action) }
  if (resourceType) { whereClause += ' AND resourceType = ?'; params.push(resourceType) }
  if (resourceId) { whereClause += ' AND resourceId = ?'; params.push(resourceId) }
  if (req.query.from) { whereClause += ' AND createdAt >= ?'; params.push(parseInt(req.query.from as string, 10)) }
  if (req.query.to) { whereClause += ' AND createdAt <= ?'; params.push(parseInt(req.query.to as string, 10)) }
  if (cursor) {
    whereClause += ' AND createdAt < ?'
    params.push(parseInt(Buffer.from(cursor, 'base64url').toString('utf-8'), 10))
  }

  params.push(limit + 1)

  const rows = await query(
    `SELECT id, actorUserId, action, resourceType, resourceId, \`before\`, after, createdAt, requestId, prevHash, entryHash
     FROM audit_logs ${whereClause} ORDER BY createdAt DESC LIMIT ?`,
    params,
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  const data = (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id, actorUserId: r.actorUserId, action: r.action,
    resourceType: r.resourceType, resourceId: r.resourceId,
    before: r.before || null, after: r.after || null,
    createdAt: r.createdAt, requestId: r.requestId,
    prevHash: r.prevHash || null,
    entryHash: r.entryHash || null,
  }))

  const nextCursor = hasMore && rows.length > 0
    ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).createdAt)).toString('base64url')
    : null

  sendSuccess(res, data, req.requestId, 200, { nextCursor, hasMore, limit })
})

export default router
