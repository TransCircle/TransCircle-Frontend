import { Router, type Router as RouterType } from 'express';
import { query, queryOne, exec } from '../Database';
import { ulid } from '../utils/ulid';
import { sendSuccess, sendError, Errors } from '../utils/response';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { reviewSchema } from '../utils/validation';
import { rateLimitCheck } from '../middleware/rateLimit';
import { conf } from '../Config';

const router: RouterType = Router();

// All admin routes require auth + admin
router.use(requireAuth, requireAdmin);

// ──────────────────────────────────────────────
// GET /admin/contributions
// List contributions with cursor-based pagination
// ──────────────────────────────────────────────
router.get('/contributions', async (req, res) => {
  const status = (req.query.status as string) || 'pending';
  const cursor = req.query.cursor as string | undefined;
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);

  // Validate status
  const validStatuses = ['pending', 'in_review', 'approved', 'rejected', 'published', 'hidden', 'withdrawn', 'draft'];
  if (!validStatuses.includes(status)) {
    sendError(res, Errors.VALIDATION_ERROR.code, `无效的状态: ${status}`, req.requestId, 400);
    return;
  }

  let whereClause = `WHERE c.status = ?`;
  const params: unknown[] = [status];

  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
      const cursorTs = parseInt(decoded, 10);
      if (isNaN(cursorTs)) {
        sendError(res, Errors.VALIDATION_ERROR.code, '无效的 cursor', req.requestId, 400);
        return;
      }
      whereClause += ` AND c.createdAt < ?`;
      params.push(cursorTs);
    } catch {
      sendError(res, Errors.VALIDATION_ERROR.code, '无效的 cursor 格式', req.requestId, 400);
      return;
    }
  }

  params.push(limit + 1); // Fetch one extra to determine hasMore

  const rows = await query<any[]>(
    `SELECT c.id, c.title, c.status, c.version, c.createdAt, c.updatedAt,
            c.submittedAt, c.authorType, c.authorName, c.contact, c.category,
            u.username, u.displayName, u.avatarUrl
     FROM contributions c
     LEFT JOIN users u ON u.id = c.authorUserId
     ${whereClause}
     ORDER BY c.createdAt DESC
     LIMIT ?`,
    params,
  );

  const hasMore = rows.length > limit;
  if (hasMore) rows.pop(); // Remove the extra row

  // Get author metadata from contributions (we store it in a simple way)
  // For simplicity, extract what we can from the data
  const submissions = rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    title: row.title as string,
    category: row.category as string | null,
    authorType: row.authorType as string | null,
    authorName: row.authorName as string | null,
    contact: row.contact as string | null,
    status: row.status as string,
    version: row.version as number,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    submittedAt: row.submittedAt as number | null,
    submitterGh: null as string | null,
    submitterX: null as string | null,
    author: row.username ? {
      id: row.authorUserId as string | null,
      displayName: (row.displayName || row.username) as string,
      avatarUrl: row.avatarUrl as string | null,
    } : null,
  }));

  const nextCursor = hasMore && rows.length > 0
    ? Buffer.from(String(rows[rows.length - 1].createdAt)).toString('base64url')
    : null;

  sendSuccess(res, {
    data: submissions,
    pagination: {
      nextCursor,
      hasMore,
      limit,
    },
  }, req.requestId);
});

// ──────────────────────────────────────────────
// GET /admin/contributions/:id
// Get contribution detail
// ──────────────────────────────────────────────
router.get('/contributions/:id', async (req, res) => {
  const { id } = req.params;

  const row = await queryOne<any[]>(
    `SELECT c.*, u.username, u.displayName, u.avatarUrl
     FROM contributions c
     LEFT JOIN users u ON u.id = c.authorUserId
     WHERE c.id = ?`,
    [id],
  );

  if (!row) {
    sendError(res, Errors.NOT_FOUND.code, '投稿不存在', req.requestId, 404);
    return;
  }

  sendSuccess(res, {
    id: row.id,
    title: row.title,
    contentRaw: row.contentRaw,
    contentFormat: row.contentFormat,
    status: row.status,
    version: row.version,
    language: row.language,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
    authorType: row.authorType,
    authorName: row.authorName,
    contact: row.contact,
    category: row.category,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
    author: row.username ? {
      id: row.authorUserId,
      displayName: row.displayName || row.username,
      avatarUrl: row.avatarUrl,
    } : null,
  }, req.requestId);
});

// ──────────────────────────────────────────────
// POST /admin/contributions/:id/review
// Review (approve/reject) a contribution with optimistic lock
// ──────────────────────────────────────────────
router.post('/contributions/:id/review', (req, _res, next) => { req.rateLimitAction = 'admin'; next(); }, rateLimitCheck, async (req, res) => {
  const { id } = req.params;
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, 400, parsed.error.flatten());
    return;
  }

  const { decision, expectedVersion, internalNote, publicNote } = parsed.data;

  // Check contribution exists and status is reviewable
  const contribution = await queryOne<any[]>(
    `SELECT id, status, version FROM contributions WHERE id = ?`,
    [id],
  );

  if (!contribution) {
    sendError(res, Errors.NOT_FOUND.code, '投稿不存在', req.requestId, 404);
    return;
  }

  if (contribution.status !== 'pending' && contribution.status !== 'in_review') {
    sendError(res, Errors.CONFLICT.code,
      `投稿状态为 ${contribution.status}，不可审核`, req.requestId, 409);
    return;
  }

  // Optimistic lock: check version
  if (contribution.version !== expectedVersion) {
    sendError(res, Errors.CONFLICT.code,
      `版本冲突：当前版本为 ${contribution.version}，期望 ${expectedVersion}`,
      req.requestId, 409);
    return;
  }

  const toStatus = decision === 'approved' ? 'approved' : 'rejected';
  const now = Date.now();
  const newVersion = contribution.version + 1;

  // Atomic update with version check
  const result = await exec(
    `UPDATE contributions
     SET status = ?, version = ?, updatedAt = ?
     WHERE id = ? AND version = ? AND (status = 'pending' OR status = 'in_review')`,
    [toStatus, newVersion, now, id, expectedVersion],
  );

  if (result.affectedRows === 0) {
    sendError(res, Errors.CONFLICT.code, '审核失败，请刷新后重试', req.requestId, 409);
    return;
  }

  // Record review event
  await exec(
    `INSERT INTO contribution_review_events (id, contributionId, reviewerUserId, action, fromStatus, toStatus, publicNote, internalNote, createdAt, requestId)
     VALUES (?, ?, ?, 'review', ?, ?, ?, ?, ?, ?)`,
    [
      ulid(),
      id,
      req.user!.userId,
      contribution.status,
      toStatus,
      publicNote || null,
      internalNote || null,
      now,
      req.requestId,
    ],
  );

  // If approved, trigger story site rebuild via GitHub repository_dispatch
  if (toStatus === 'approved') {
    triggerStoryRebuild(req).catch((err) =>
      console.error('Story rebuild trigger failed (non-blocking):', err)
    );
  }

  sendSuccess(res, {
    id,
    status: toStatus,
    version: newVersion,
  }, req.requestId);
});

// ── Story rebuild trigger ──────────────────────

interface StoryConfig {
  STORY_REPO?: string;
  STORY_REPO_TOKEN?: string;
}

async function triggerStoryRebuild(req: import('express').Request): Promise<void> {
  const storyConf = conf.STORY as StoryConfig | undefined;
  const token = storyConf?.STORY_REPO_TOKEN;
  const repo = storyConf?.STORY_REPO;

  if (!token || !repo) {
    // Not configured — skip silently
    return;
  }

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
        api_base: (conf.STORY as Record<string, string> | undefined)?.STORY_API_BASE || '',
        triggered_by: req.user?.userId || 'unknown',
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub dispatch failed (${res.status}): ${text}`);
  }
}

export default router;
