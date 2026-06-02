import { Router, type Router as RouterType } from 'express'
import { query } from '../Database'
import { sendSuccess, sendError, Errors } from '../utils/response'

const router: RouterType = Router()

// ──────────────────────────────────────────────
// GET /stories/published
// Returns all approved contributions in the format the story site expects.
// Story site main.js expects snake_case fields.
// ──────────────────────────────────────────────
router.get('/published', async (req, res) => {
  try {
    const rows = await query(
      `SELECT c.id, c.title, c.summary, c.contentRaw as content, c.submittedAt as created_at,
              u.displayName as author_name, u.avatarUrl as author_avatar
       FROM contributions c
       LEFT JOIN users u ON u.id = c.authorUserId
       WHERE c.status = 'published'
       ORDER BY c.publishedAt DESC`,
    )

    sendSuccess(res, rows, req.requestId)
  } catch (err) {
    console.error('Failed to fetch published stories:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '获取已发布投稿失败', req.requestId, 500)
  }
})

export default router
