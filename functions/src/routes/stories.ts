import { Router, type Router as RouterType } from 'express';
import { query } from '../Database';
import { sendSuccess, sendError, Errors } from '../utils/response';

const router: RouterType = Router();

// ──────────────────────────────────────────────
// GET /stories/published
// Returns all approved contributions in the format the story site expects.
// Story site main.js expects snake_case fields.
// ──────────────────────────────────────────────
router.get('/published', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, title, contentRaw as content, category,
              authorType as author_type, authorName as author_name,
              submittedAt as created_at
       FROM contributions
       WHERE status = 'approved'
       ORDER BY submittedAt DESC`,
    );

    sendSuccess(res, rows, req.requestId);
  } catch (err) {
    console.error('Failed to fetch published stories:', err);
    sendError(res, Errors.INTERNAL_ERROR.code, '获取已发布投稿失败', req.requestId, 500);
  }
});

export default router;
