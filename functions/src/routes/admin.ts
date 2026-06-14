import { Router, type Router as RouterType } from 'express'
import { query, queryOne, exec } from '../Database'
import { genId } from '../utils/ulid'
import { sendSuccess, sendError, Errors, zodErrorsToDetails } from '../utils/response'
import { requireAuth, requireReviewer } from '../middleware/auth'
import { reviewSchema } from '../utils/validation'
import { rateLimitCheck } from '../middleware/rateLimit'
import { conf } from '../Config'
import { writeAuditLog } from '../utils/audit'
import { purgeContributionCache } from '../utils/cdn'
import { requirePerm, requirePermission } from '../utils/permissions'

const router: RouterType = Router()

function getRouteId(req: import('express').Request): string {
  const value = req.params.id as string | string[] | undefined
  if (Array.isArray(value)) return value[0]
  return value ?? ''
}

// All admin routes require auth + admin
router.use(requireAuth, requireReviewer)

// ──────────────────────────────────────────────
// GET /admin/contributions — api.md §6.1
// ──────────────────────────────────────────────
router.get('/contributions', requirePerm('contribution:read'), async (req, res) => {
  const status = (req.query.status as string) || 'pending'
  const cursor = req.query.cursor as string | undefined
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100)
  const authorId = req.query.authorId as string | undefined
  const keyword = req.query.keyword as string | undefined
  const reviewerId = req.query.reviewerId as string | undefined
  const createdFrom = req.query.createdFrom as string | undefined
  const createdTo = req.query.createdTo as string | undefined
  const sort = (req.query.sort as string) || 'createdAt_desc'

  const validStatuses = ['draft', 'pending', 'in_review', 'approved', 'rejected', 'published', 'hidden', 'withdrawn', 'deleted']
  if (!validStatuses.includes(status)) {
    sendError(res, Errors.VALIDATION_ERROR.code, `无效的状态: ${status}`, req.requestId, Errors.VALIDATION_ERROR.status)
    return
  }

  let whereClause = `WHERE c.status = ?`
  let orderClause = 'ORDER BY c.createdAt DESC'
  const params: unknown[] = [status]

  if (authorId) {
    whereClause += ` AND c.authorUserId = ?`
    params.push(authorId)
  }
  if (keyword) {
    whereClause += ` AND (c.title LIKE ? OR c.summary LIKE ?)`
    const kw = `%${keyword}%`
    params.push(kw, kw)
  }
  if (reviewerId) {
    whereClause += ` AND EXISTS (SELECT 1 FROM contribution_review_events re WHERE re.contributionId = c.id AND re.reviewerUserId = ? AND re.action = 'review')`
    params.push(reviewerId)
  }
  if (createdFrom) {
    whereClause += ` AND c.createdAt >= ?`
    params.push(parseInt(createdFrom, 10))
  }
  if (createdTo) {
    whereClause += ` AND c.createdAt <= ?`
    params.push(parseInt(createdTo, 10))
  }
  if (sort === 'createdAt_asc') orderClause = 'ORDER BY c.createdAt ASC'
  else if (sort === 'updatedAt_desc') orderClause = 'ORDER BY c.updatedAt DESC'
  else if (sort === 'updatedAt_asc') orderClause = 'ORDER BY c.updatedAt ASC'

  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf-8')
      const cursorTs = parseInt(decoded, 10)
      if (isNaN(cursorTs)) {
        sendError(res, Errors.VALIDATION_ERROR.code, '无效的 cursor', req.requestId, Errors.VALIDATION_ERROR.status)
        return
      }
      whereClause += ` AND c.createdAt < ?`
      params.push(cursorTs)
    } catch {
      sendError(res, Errors.VALIDATION_ERROR.code, '无效的 cursor 格式', req.requestId, Errors.VALIDATION_ERROR.status)
      return
    }
  }

  params.push(limit + 1)

  const rows = await query(
    `SELECT c.id, c.title, c.summary, c.status, c.version, c.createdAt, c.updatedAt,
            c.submittedAt, c.publishedAt,
            u.id as authorUserId, u.displayName, u.avatarUrl
     FROM contributions c
     LEFT JOIN users u ON u.id = c.authorUserId
     ${whereClause}
     ${orderClause}
     LIMIT ?`,
    params,
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  const submissions = rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    title: row.title as string,
    summary: (row.summary as string) || null,
    status: row.status as string,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    author: row.displayName
      ? {
          id: (row.authorUserId as string) || null,
          displayName: (row.displayName || row.username) as string,
          avatarUrl: (row.avatarUrl as string) || null,
        }
      : null,
  }))

  const nextCursor = hasMore && rows.length > 0
    ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).createdAt)).toString('base64url')
    : null

  sendSuccess(res, submissions, req.requestId, 200, { nextCursor, hasMore, limit })
})

// ──────────────────────────────────────────────
// GET /admin/contributions/stats — api.md §6.8
// Must be registered BEFORE /:id to avoid Express matching 'stats' as :id
// ──────────────────────────────────────────────
router.get('/contributions/stats', requirePerm('contribution:read'), async (req, res) => {
  const rows = await query(
    `SELECT status, COUNT(*) as count FROM contributions GROUP BY status`,
  ) as Array<Record<string, unknown>>

  const totals: Record<string, number> = { draft: 0, pending: 0, in_review: 0, approved: 0, rejected: 0, published: 0, hidden: 0, withdrawn: 0, deleted: 0 }
  for (const r of rows) { totals[r.status as string] = r.count as number }

  const now = Date.now()
  const from = req.query.from ? parseInt(req.query.from as string, 10) : undefined
  const to = req.query.to ? parseInt(req.query.to as string, 10) : undefined
  const todayStart = now - (now % 86400000)
  const weekAgo = now - 7 * 86400000
  const monthAgo = from || (now - 30 * 86400000)
  const toTime = to || now

  // Use subquery to get first review time per contribution, avoiding CROSS JOIN
  const submissions = await query(
    `SELECT SUM(CASE WHEN submittedAt >= ? THEN 1 ELSE 0 END) as today,
            SUM(CASE WHEN submittedAt >= ? THEN 1 ELSE 0 END) as last7Days,
            SUM(CASE WHEN submittedAt >= ? AND submittedAt <= ? THEN 1 ELSE 0 END) as last30Days,
            AVG(minReviewTime - submittedAt) / 1000 as avgLatency
     FROM (
       SELECT c.id, c.submittedAt,
              (SELECT MIN(createdAt) FROM contribution_review_events
               WHERE contributionId = c.id AND action = 'review') as minReviewTime
       FROM contributions c
       WHERE c.submittedAt IS NOT NULL AND c.submittedAt <= ?
     ) sub`,
    [todayStart, weekAgo, monthAgo, toTime, toTime],
  )

  const s = submissions[0] as Record<string, unknown> || {}

  sendSuccess(res, {
    totals,
    submissions: { today: s.today || 0, last7Days: s.last7Days || 0, last30Days: s.last30Days || 0 },
    averageReviewLatencySeconds: Math.round((s.avgLatency as number) || 0),
  }, req.requestId)
})

// ──────────────────────────────────────────────
// GET /admin/contributions/:id — api.md §6.2
// ──────────────────────────────────────────────
router.get('/contributions/:id', requirePerm('contribution:read'), async (req, res) => {
  const id = getRouteId(req)

  const row = await queryOne(
    `SELECT c.*, u.id as authorUserId, u.username, u.displayName, u.avatarUrl, u.emailVerified
     FROM contributions c
     LEFT JOIN users u ON u.id = c.authorUserId
     WHERE c.id = ?`,
    [id],
  )

  if (!row) {
    sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在', req.requestId, Errors.CONTRIBUTION_NOT_FOUND.status)
    return
  }

  // Query latest review event for this contribution (api.md §6.2)
  // Use toStatus rather than action: action is always 'review' per insert, toStatus carries the decision
  const latestReview = await queryOne(
    `SELECT reviewerUserId, createdAt as reviewedAt, toStatus as decision, publicNote, internalNote
     FROM contribution_review_events
     WHERE contributionId = ? AND action = 'review'
     ORDER BY createdAt DESC LIMIT 1`,
    [id],
  )

  // internalNote requires contribution:internal-note:read per api.md §6.2
  const canReadInternalNote = await requirePermission(req.user!.userId, 'contribution:internal-note:read')

  let review: { reviewerUserId: string | null; reviewedAt: number | null; decision: string | null; publicNote: string | null; internalNote: string | null }
  if (latestReview) {
    const decision = (latestReview.decision as string) === 'approved' ? 'approved'
      : (latestReview.decision as string) === 'rejected' ? 'rejected'
      : null
    review = {
      reviewerUserId: latestReview.reviewerUserId,
      reviewedAt: latestReview.reviewedAt,
      decision,
      publicNote: latestReview.publicNote || null,
      internalNote: canReadInternalNote ? (latestReview.internalNote || null) : null,
    }
  } else {
    review = { reviewerUserId: null, reviewedAt: null, decision: null, publicNote: null, internalNote: null }
  }

  // Fetch hide/delete reason for hidden/deleted contributions
  let hideReason: string | null = null
  if (row.status === 'hidden' || row.status === 'deleted') {
    const ev = await queryOne(
      `SELECT publicNote FROM contribution_review_events
       WHERE contributionId = ? AND action IN ('hide', 'delete')
       ORDER BY createdAt DESC LIMIT 1`,
      [id],
    )
    if (ev) hideReason = ev.publicNote as string | null
  }

  sendSuccess(res, {
    id: row.id,
    title: row.title,
    summary: row.summary || null,
    contentRaw: row.contentRaw,
    contentHtml: row.contentHtml || null,
    contentFormat: row.contentFormat,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags as string) : row.tags,
    language: row.language,
    status: row.status,
    version: row.version,
    author: row.username
      ? {
          id: row.authorUserId,
          username: row.username,
          displayName: row.displayName || row.username,
          avatarUrl: row.avatarUrl,
          emailVerified: !!row.emailVerified,
        }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt || null,
    publishedAt: row.publishedAt || null,
    review,
    hideReason,
  }, req.requestId)
})

// ──────────────────────────────────────────────
// POST /admin/contributions/:id/review — api.md §6.3
// ──────────────────────────────────────────────
router.post('/contributions/:id/review', requirePerm('contribution:review'), (req, _res, next) => { req.rateLimitAction = 'admin'; next(); }, rateLimitCheck, async (req, res) => {
  const id = getRouteId(req)
  const parsed = reviewSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, Errors.VALIDATION_ERROR.status, zodErrorsToDetails(parsed.error.flatten()))
    return
  }

  const { decision, toStatus, expectedVersion, internalNote, publicNote } = parsed.data

  // api.md §15.10: writing internalNote requires contribution:internal-note:read
  if (internalNote && !(await requirePermission(req.user!.userId, 'contribution:internal-note:read'))) {
    sendError(res, Errors.FORBIDDEN.code, '缺少权限: contribution:internal-note:read', req.requestId, Errors.FORBIDDEN.status)
    return
  }

  const contribution = await queryOne(
    `SELECT id, status, version FROM contributions WHERE id = ?`,
    [id],
  )

  if (!contribution) {
    sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在', req.requestId, Errors.CONTRIBUTION_NOT_FOUND.status)
    return
  }

  if (contribution.status !== 'pending' && contribution.status !== 'in_review') {
    sendError(res, Errors.VERSION_CONFLICT.code, `投稿状态为 ${contribution.status}，不可审核`, req.requestId, Errors.VERSION_CONFLICT.status)
    return
  }

  if (contribution.version !== expectedVersion) {
    sendError(res, Errors.VERSION_CONFLICT.code, `版本冲突：当前版本为 ${contribution.version}，期望 ${expectedVersion}`, req.requestId, Errors.VERSION_CONFLICT.status)
    return
  }

  // Determine target status per api.md §6.3:
  // - decision=approved → approved, decision=rejected → rejected
  // - toStatus=in_review → in_review (request revisions)
  let toStatusFinal: string
  if (toStatus === 'in_review') {
    toStatusFinal = 'in_review'
  } else if (decision === 'approved') {
    toStatusFinal = 'approved'
  } else {
    toStatusFinal = 'rejected'
  }

  const now = Date.now()
  const newVersion = contribution.version + 1

  const result = await exec(
    `UPDATE contributions SET status = ?, version = ?, updatedAt = ? WHERE id = ? AND version = ? AND (status = 'pending' OR status = 'in_review')`,
    [toStatusFinal, newVersion, now, id, expectedVersion],
  )

  if (result.affectedRows === 0) {
    sendError(res, Errors.VERSION_CONFLICT.code, '审核失败，请刷新后重试', req.requestId, Errors.VERSION_CONFLICT.status)
    return
  }

  // Record review event
  await exec(
    `INSERT INTO contribution_review_events (id, contributionId, reviewerUserId, action, fromStatus, toStatus, publicNote, internalNote, createdAt, requestId)
     VALUES (?, ?, ?, 'review', ?, ?, ?, ?, ?, ?)`,
    [genId('rev_'), id, req.user!.userId, contribution.status, toStatusFinal, publicNote || null, internalNote || null, now, req.requestId],
  )

  // Write audit log per api.md §6.3
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'contribution.review',
    resourceType: 'contribution',
    resourceId: String(id),
    before: { status: String(contribution.status), version: Number(expectedVersion) },
    after: { status: String(toStatusFinal), version: Number(newVersion) },
  })

  // If approved, trigger story site rebuild
  if (toStatusFinal === 'approved') {
    triggerStoryRebuild(req).catch((err) => console.error('Story rebuild trigger failed:', err))
  }

sendSuccess(res, {
    id,
    status: toStatusFinal,
    version: newVersion,
    review: {
      reviewerUserId: req.user!.userId,
      reviewedAt: now,
      decision: toStatusFinal === 'in_review' ? null : (decision || null),
      publicNote: publicNote || null,
      internalNote: internalNote || null,
    },
  }, req.requestId)
})

// ── Story rebuild trigger ─────────────
interface StoryConfig {
  STORY_REPO?: string
  STORY_REPO_TOKEN?: string
}

async function triggerStoryRebuild(req: import('express').Request): Promise<void> {
  const storyConf = conf.STORY as StoryConfig | undefined
  const token = storyConf?.STORY_REPO_TOKEN
  const repo = storyConf?.STORY_REPO

  if (!token || !repo) return

  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'TransCircle',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'story-rebuild',
      client_payload: {
        api_base: ((conf.STORY as Record<string, string>)?.STORY_API_BASE) || '',
        triggered_by: req.user?.userId || 'unknown',
      },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub dispatch failed (${res.status}): ${text}`)
  }
}

// ──────────────────────────────────────────────
// POST /admin/contributions/:id/publish — api.md §6.5
// ──────────────────────────────────────────────
router.post('/contributions/:id/publish', requirePerm('contribution:publish'), async (req, res) => {
  const id = getRouteId(req)
  const expectedVersion = req.body?.expectedVersion as number | undefined
  const publicNote = req.body?.publicNote as string | undefined

  if (!expectedVersion) {
    sendError(res, Errors.VALIDATION_ERROR.code, 'expectedVersion 必填', req.requestId, 422)
    return
  }

  const contrib = await queryOne(`SELECT id, status, version FROM contributions WHERE id = ?`, [id])
  if (!contrib) { sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在', req.requestId, 404); return }
  if (contrib.status !== 'approved') { sendError(res, 'INVALID_STATE_TRANSITION', '当前状态不可发布', req.requestId, 409); return }
  if (contrib.version !== expectedVersion) { sendError(res, Errors.VERSION_CONFLICT.code, '版本冲突', req.requestId, Errors.VERSION_CONFLICT.status); return }

  const now = Date.now()
  const newVersion = contrib.version + 1

  await exec(`UPDATE contributions SET status = 'published', version = ?, publishedAt = ?, updatedAt = ? WHERE id = ? AND version = ?`, [newVersion, now, now, id, expectedVersion])

  await exec(
    `INSERT INTO contribution_review_events (id, contributionId, reviewerUserId, action, fromStatus, toStatus, publicNote, createdAt, requestId)
     VALUES (?, ?, ?, 'publish', 'approved', 'published', ?, ?, ?)`,
    [genId('rev_'), id, req.user!.userId, publicNote || null, now, req.requestId],
  )
  await writeAuditLog(req, { actorUserId: req.user!.userId, action: 'contribution.publish', resourceType: 'contribution', resourceId: id, after: { status: 'published' } })

  sendSuccess(res, { id, status: 'published', version: newVersion, publishedAt: now }, req.requestId)
})

// POST /admin/contributions/:id/hide — api.md §6.4
router.post('/contributions/:id/hide', requirePerm('contribution:hide'), async (req, res) => {
  const id = getRouteId(req)
  const expectedVersion = req.body?.expectedVersion as number | undefined
  const reason = req.body?.reason as string | undefined
  const publicNote = req.body?.publicNote as string | undefined
  const internalNote = req.body?.internalNote as string | undefined
  if (!expectedVersion || !reason) { sendError(res, Errors.VALIDATION_ERROR.code, '缺少参数', req.requestId, 422); return }

  // api.md §15.10: writing internalNote requires contribution:internal-note:read
  if (internalNote && !(await requirePermission(req.user!.userId, 'contribution:internal-note:read'))) {
    sendError(res, Errors.FORBIDDEN.code, '缺少权限: contribution:internal-note:read', req.requestId, Errors.FORBIDDEN.status)
    return
  }

  const contrib = await queryOne(`SELECT id, status, version FROM contributions WHERE id = ?`, [id])
  if (!contrib) { sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在', req.requestId, 404); return }
  if (contrib.status !== 'published') { sendError(res, 'INVALID_STATE_TRANSITION', '当前状态不可隐藏', req.requestId, 409); return }
  if (contrib.version !== expectedVersion) { sendError(res, Errors.VERSION_CONFLICT.code, '版本冲突', req.requestId, Errors.VERSION_CONFLICT.status); return }

  const now = Date.now(); const newVersion = contrib.version + 1
  await exec(
    `UPDATE contributions SET status = 'hidden', version = ?, updatedAt = ? WHERE id = ? AND version = ?`,
    [newVersion, now, id, expectedVersion],
  )
  await exec(
    `INSERT INTO contribution_review_events (id, contributionId, reviewerUserId, action, fromStatus, toStatus, publicNote, internalNote, createdAt, requestId)
     VALUES (?, ?, ?, 'hide', 'published', 'hidden', ?, ?, ?, ?)`,
    [genId('rev_'), id, req.user!.userId, reason || null, internalNote || null, now, req.requestId],
  )
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'contribution.hide',
    resourceType: 'contribution',
    resourceId: id,
    after: { reason, publicNote, internalNote },
  })

  // Per api.md §6.4: purge CDN cache for hidden contribution
  purgeContributionCache(id).catch((err) => console.error('[CDN] purge error:', err))

  sendSuccess(res, {
    id, status: 'hidden', version: newVersion,
    review: {
      reviewerUserId: req.user!.userId,
      reviewedAt: now,
      decision: null,
      publicNote: publicNote || null,
      internalNote: internalNote || null,
    },
  }, req.requestId)
})

// POST /admin/contributions/:id/restore — api.md §6.4
router.post('/contributions/:id/restore', requirePerm('contribution:restore'), async (req, res) => {
  const id = getRouteId(req)
  const expectedVersion = req.body?.expectedVersion as number | undefined
  if (!expectedVersion) { sendError(res, Errors.VALIDATION_ERROR.code, 'expectedVersion 必填', req.requestId, 422); return }

  const contrib = await queryOne(`SELECT id, status, version FROM contributions WHERE id = ?`, [id])
  if (!contrib) { sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在', req.requestId, 404); return }
  if (contrib.status !== 'hidden') { sendError(res, 'INVALID_STATE_TRANSITION', '当前状态不可恢复', req.requestId, 409); return }
  if (contrib.version !== expectedVersion) { sendError(res, Errors.VERSION_CONFLICT.code, '版本冲突', req.requestId, Errors.VERSION_CONFLICT.status); return }

  const now = Date.now(); const newVersion = contrib.version + 1
  await exec(
    `UPDATE contributions SET status = 'published', version = ?, updatedAt = ? WHERE id = ? AND version = ?`,
    [newVersion, now, id, expectedVersion],
  )
  await exec(
    `INSERT INTO contribution_review_events (id, contributionId, reviewerUserId, action, fromStatus, toStatus, createdAt, requestId)
     VALUES (?, ?, ?, 'restore', 'hidden', 'published', ?, ?)`,
    [genId('rev_'), id, req.user!.userId, now, req.requestId],
  )
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'contribution.restore',
    resourceType: 'contribution',
    resourceId: id,
    after: { status: 'published' },
  })

  sendSuccess(res, { id, status: 'published', version: newVersion }, req.requestId)
})

// POST /admin/contributions/:id/delete — api.md §6.6
router.post('/contributions/:id/delete', requirePerm('contribution:delete'), async (req, res) => {
  const id = getRouteId(req)
  const expectedVersion = req.body?.expectedVersion as number | undefined
  const reason = req.body?.reason as string | undefined
  if (!expectedVersion || !reason) { sendError(res, Errors.VALIDATION_ERROR.code, '缺少参数', req.requestId, 422); return }

  const validFromStatuses = ['draft', 'rejected', 'withdrawn', 'hidden', 'approved']
  const contrib = await queryOne(`SELECT id, status, version FROM contributions WHERE id = ?`, [id])
  if (!contrib) { sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在', req.requestId, 404); return }
  if (!validFromStatuses.includes(contrib.status)) { sendError(res, 'INVALID_STATE_TRANSITION', '当前状态不可删除', req.requestId, 409); return }
  if (contrib.version !== expectedVersion) { sendError(res, Errors.VERSION_CONFLICT.code, '版本冲突', req.requestId, Errors.VERSION_CONFLICT.status); return }

  const now = Date.now(); const newVersion = contrib.version + 1
  await exec(
    `UPDATE contributions SET status = 'deleted', version = ?, deletedAt = ?, updatedAt = ? WHERE id = ? AND version = ?`,
    [newVersion, now, now, id, expectedVersion],
  )
  // Record review event per api.md §6.6
  await exec(
    `INSERT INTO contribution_review_events (id, contributionId, reviewerUserId, action, fromStatus, toStatus, publicNote, createdAt, requestId)
     VALUES (?, ?, ?, 'delete', ?, 'deleted', ?, ?, ?)`,
    [genId('rev_'), id, req.user!.userId, contrib.status, reason || null, now, req.requestId],
  )
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'contribution.delete',
    resourceType: 'contribution',
    resourceId: id,
    after: { reason },
  })

  // Per api.md §6.6: purge CDN cache for deleted contribution
  purgeContributionCache(id).catch((err) => console.error('[CDN] purge error:', err))

  sendSuccess(res, { id, status: 'deleted', version: newVersion, deletedAt: now }, req.requestId)
})

// GET /admin/contributions/:id/review-events — api.md §6.7
router.get('/contributions/:id/review-events', requirePerm('contribution:audit:read'), async (req, res) => {
  const id = getRouteId(req)
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100)
  const cursor = req.query.cursor as string | undefined

  let whereClause = 'WHERE contributionId = ?'
  const params: unknown[] = [id]
  if (cursor) { whereClause += ' AND createdAt < ?'; params.push(parseInt(Buffer.from(cursor, 'base64url').toString('utf-8'), 10)) }
  params.push(limit + 1)

  const rows = await query(
    `SELECT e.id, e.contributionId, e.reviewerUserId, e.fromStatus, e.toStatus,
            e.publicNote, e.internalNote, e.createdAt, e.requestId,
            u.displayName as reviewerDisplayName
     FROM contribution_review_events e
     LEFT JOIN users u ON u.id = e.reviewerUserId
     ${whereClause} ORDER BY e.createdAt DESC LIMIT ?`,
    params,
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  // internalNote requires contribution:internal-note:read per api.md §6.7
  const canReadIntNote = await requirePermission(req.user!.userId, 'contribution:internal-note:read')

  const data = (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id, contributionId: r.contributionId,
    reviewer: { id: r.reviewerUserId, displayName: r.reviewerDisplayName || null },
    fromStatus: r.fromStatus, toStatus: r.toStatus,
    publicNote: r.publicNote || null,
    internalNote: canReadIntNote ? (r.internalNote || null) : null,
    createdAt: r.createdAt, requestId: r.requestId,
  }))

  const nextCursor = hasMore ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).createdAt)).toString('base64url') : null
  sendSuccess(res, data, req.requestId, 200, { nextCursor, hasMore, limit })
})

export default router
