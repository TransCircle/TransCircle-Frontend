import { Router, type Router as RouterType } from 'express'
import { query } from '../Database'
import { sendSuccess, sendError, Errors } from '../utils/response'

const router: RouterType = Router()

// ──────────────────────────────────────────────
// GET /stories/published
// Serves published contributions to the external story site (story.transcircle.org).
// The story site renderer expects snake_case fields for backward compatibility.
// Also returns camelCase fields for api.md compliance. Always paginated via cursor per api.md §12.
// ──────────────────────────────────────────────
router.get('/published', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100)
    const cursor = req.query.cursor as string | undefined

    let whereClause = `WHERE c.status = 'published'`
    const params: unknown[] = []

    if (cursor) {
      whereClause += ' AND c.publishedAt < ?'
      params.push(parseInt(Buffer.from(cursor, 'base64url').toString('utf-8'), 10))
    }

    params.push(limit + 1)

    const rows = await query(
      `SELECT c.id, c.title, c.summary, c.contentHtml as contentHtml_raw, c.tags, c.language, c.publishedAt,
              c.submittedAt as created_at,
              u.displayName as author_name, u.avatarUrl as author_avatar
       FROM contributions c
       LEFT JOIN users u ON u.id = c.authorUserId
       ${whereClause}
       ORDER BY c.publishedAt DESC
       LIMIT ?`,
      params,
    )

    const hasMore = rows.length > limit
    if (hasMore) rows.pop()

    // Transform to nested author object + camelCase fields for api.md compliance
    // Use contentHtml (sanitized) instead of contentRaw for security per api.md §5.2
    const data = (rows as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      contentHtml: row.contentHtml_raw,  // api.md §5.2: use sanitized HTML
      content: row.contentHtml_raw,       // backward compat for story site
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags as string) : row.tags || [],
      language: row.language || 'zh-CN',
      author: {
        displayName: row.author_name,
        avatarUrl: row.author_avatar,
      },
      author_name: row.author_name,  // backward compat for story site
      author_avatar: row.author_avatar, // backward compat for story site
      publishedAt: row.publishedAt || null,
      createdAt: row.created_at,     // camelCase version
      created_at: row.created_at,    // backward compat for story site
    }))

    const nextCursor = hasMore && rows.length > 0
      ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).publishedAt)).toString('base64url')
      : null

    sendSuccess(res, data, req.requestId, 200, { nextCursor, hasMore, limit })
  } catch (err) {
    console.error('Failed to fetch published stories:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '获取已发布投稿失败', req.requestId, 500)
  }
})

export default router
