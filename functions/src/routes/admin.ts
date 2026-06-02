import { Router, type Router as RouterType } from 'express'
import { query, queryOne, exec } from '../Database'
import { ulid } from '../utils/ulid'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { reviewSchema } from '../utils/validation'
import { rateLimitCheck } from '../middleware/rateLimit'
import { conf } from '../Config'

const router: RouterType = Router()

// All admin routes require auth + admin
router.use(requireAuth, requireAdmin)

// ──────────────────────────────────────────────
// GET /admin/contributions — api.md §6.1
// ──────────────────────────────────────────────
router.get('/contributions', async (req, res) => {
  const status = (req.query.status as string) || 'pending'
  const cursor = req.query.cursor as string | undefined
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100)

  const validStatuses = ['draft', 'pending', 'in_review', 'approved', 'rejected', 'published', 'hidden', 'withdrawn', 'deleted']
  if (!validStatuses.includes(status)) {
    sendError(res, Errors.VALIDATION_ERROR.code, `无效的状态: ${status}`, req.requestId, Errors.VALIDATION_ERROR.status)
    return
  }

  let whereClause = `WHERE c.status = ?`
  const params: unknown[] = [status]

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
     ORDER BY c.createdAt DESC
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

  res.status(200).json({
    data: submissions,
    pagination: { nextCursor, hasMore, limit },
    requestId: req.requestId,
  })
})

// ──────────────────────────────────────────────
// GET /admin/contributions/:id — api.md §6.2
// ──────────────────────────────────────────────
router.get('/contributions/:id', async (req, res) => {
  const { id } = req.params

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
    review: {
      reviewerUserId: null,
      reviewedAt: null,
      decision: null,
      publicNote: null,
      internalNote: null,
    },
  }, req.requestId)
})

// ──────────────────────────────────────────────
// POST /admin/contributions/:id/review — api.md §6.3
// ──────────────────────────────────────────────
router.post('/contributions/:id/review', (req, _res, next) => { req.rateLimitAction = 'admin'; next(); }, rateLimitCheck, async (req, res) => {
  const { id } = req.params
  const parsed = reviewSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, Errors.VALIDATION_ERROR.status, parsed.error.flatten())
    return
  }

  const { decision, expectedVersion, internalNote, publicNote } = parsed.data

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

  const toStatus = decision === 'approved' ? 'approved' : 'rejected'
  const now = Date.now()
  const newVersion = contribution.version + 1

  const result = await exec(
    `UPDATE contributions SET status = ?, version = ?, updatedAt = ? WHERE id = ? AND version = ? AND (status = 'pending' OR status = 'in_review')`,
    [toStatus, newVersion, now, id, expectedVersion],
  )

  if (result.affectedRows === 0) {
    sendError(res, Errors.VERSION_CONFLICT.code, '审核失败，请刷新后重试', req.requestId, Errors.VERSION_CONFLICT.status)
    return
  }

  // Record review event
  await exec(
    `INSERT INTO contribution_review_events (id, contributionId, reviewerUserId, action, fromStatus, toStatus, publicNote, internalNote, createdAt, requestId)
     VALUES (?, ?, ?, 'review', ?, ?, ?, ?, ?, ?)`,
    [ulid(), id, req.user!.userId, contribution.status, toStatus, publicNote || null, internalNote || null, now, req.requestId],
  )

  // Write audit log per api.md §6.3
  await exec(
    `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, \`before\`, after, createdAt, requestId)
     VALUES (?, ?, 'contribution.review', 'contribution', ?, ?, ?, ?, ?)`,
    [ulid(), req.user!.userId, id, JSON.stringify({ status: contribution.status, version: expectedVersion }), JSON.stringify({ status: toStatus, version: newVersion }), now, req.requestId],
  )

  // If approved, trigger story site rebuild
  if (toStatus === 'approved') {
    triggerStoryRebuild(req).catch((err) => console.error('Story rebuild trigger failed:', err))
  }

  sendSuccess(res, { id, status: toStatus, version: newVersion }, req.requestId)
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

export default router
