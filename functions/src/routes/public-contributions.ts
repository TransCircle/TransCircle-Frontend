import { Router } from 'express'
import { query, queryOne } from '../Database'
import { sendSuccess, sendError, Errors } from '../utils/response'

const router: Router = Router()

// GET /public/contributions — api.md §5.1
router.get('/contributions', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100)
  const cursor = req.query.cursor as string | undefined
  const language = req.query.language as string | undefined
  const tag = req.query.tag as string | undefined
  const sort = (req.query.sort as string) || 'publishedAt_desc'

  let whereClause = `WHERE c.status = 'published'`
  let orderClause = 'ORDER BY c.publishedAt DESC'
  const params: unknown[] = []

  if (language) { whereClause += ' AND c.language = ?'; params.push(language) }
  if (tag) { whereClause += ' AND JSON_CONTAINS(c.tags, ?)'; params.push(JSON.stringify(tag)) }
  if (cursor) {
    whereClause += ' AND c.publishedAt < ?'
    params.push(parseInt(Buffer.from(cursor, 'base64url').toString('utf-8'), 10))
  }
  if (sort === 'publishedAt_asc') {
    orderClause = 'ORDER BY c.publishedAt ASC'
  }

  params.push(limit + 1)

  const rows = await query(
    `SELECT c.id, c.title, c.summary, c.tags, c.language, c.publishedAt,
            u.displayName, u.avatarUrl
     FROM contributions c
     LEFT JOIN users u ON u.id = c.authorUserId
     ${whereClause}
     ${orderClause}
     LIMIT ?`,
    params,
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  const data = (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary || null,
    tags: typeof r.tags === 'string' ? JSON.parse(r.tags as string) : r.tags || [],
    language: r.language,
    author: {
      displayName: r.displayName || 'Anonymous',
      avatarUrl: r.avatarUrl || null,
    },
    publishedAt: r.publishedAt,
  }))

  const nextCursor = hasMore && rows.length > 0
    ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).publishedAt)).toString('base64url')
    : null

  // Per api.md §6.4: cache headers for CDN
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=60')
  res.setHeader('Surrogate-Key', 'list_contributions')

  sendSuccess(res, data, req.requestId, 200, { nextCursor, hasMore, limit })
})

// GET /public/contributions/:id — api.md §5.2
router.get('/contributions/:id', async (req, res) => {
  const row = await queryOne(
    `SELECT c.id, c.title, c.summary, c.contentHtml, c.contentFormat, c.tags, c.language, c.publishedAt,
            u.displayName, u.avatarUrl
     FROM contributions c
     LEFT JOIN users u ON u.id = c.authorUserId
     WHERE c.id = ? AND c.status = 'published'`,
    [req.params.id],
  )

  if (!row) {
    sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在或未发布', req.requestId, Errors.CONTRIBUTION_NOT_FOUND.status)
    return
  }

  // Per api.md §6.4: cache headers for CDN
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=60')
  res.setHeader('Surrogate-Key', `contrib_${row.id}`)

  sendSuccess(res, {
    id: row.id,
    title: row.title,
    summary: row.summary || null,
    contentHtml: row.contentHtml || '',
    contentFormat: row.contentFormat,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags as string) : row.tags || [],
    language: row.language,
    author: {
      displayName: row.displayName || 'Anonymous',
      avatarUrl: row.avatarUrl || null,
    },
    publishedAt: row.publishedAt,
  }, req.requestId)
})

export default router
