import { Router, type Router as RouterType } from 'express'
import { exec } from '../Database'
import { ulid } from '../utils/ulid'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { requireAuth } from '../middleware/auth'
import { contributionSchema } from '../utils/validation'
import { rateLimitCheck } from '../middleware/rateLimit'

const router: RouterType = Router()

// ──────────────────────────────────────────────
// POST /contributions — api.md §3 提交投稿
// ──────────────────────────────────────────────
router.post('/', (req, _res, next) => { req.rateLimitAction = 'submit'; next(); }, rateLimitCheck, requireAuth, async (req, res) => {
  const parsed = contributionSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, Errors.VALIDATION_ERROR.status, parsed.error.flatten())
    return
  }

  const data = parsed.data

  // Honeypot check — if filled, silently reject (bot)
  if (data.website && data.website.length > 0) {
    const fakeId = `TC-${ulid().slice(0, 12)}`
    sendSuccess(res, { id: fakeId, status: 'pending' }, req.requestId)
    return
  }

  const id = ulid()
  const now = Date.now()
  const submitMode = data.submitMode || 'submit'
  const status = submitMode === 'draft' ? 'draft' : 'pending'

  await exec(
    `INSERT INTO contributions (id, authorUserId, title, summary, contentRaw, contentFormat, contentHtml, rendererVersion, status, version, language, tags, idempotencyKey, submittedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'v1', ?, 1, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      req.user!.userId,
      data.title.trim(),
      data.summary?.trim() || null,
      data.content,
      data.contentFormat || 'markdown',
      data.content, // FIXME: vi.2 — 应渲染 Markdown 后用 DOMPurify 清洗
      status,
      data.language || 'zh-CN',
      JSON.stringify(data.tags || []),
      null, // idempotencyKey 暂不实现
      status === 'pending' ? now : null,
      now,
      now,
    ],
  )

  // Write audit log per api.md §3
  await exec(
    `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, after, createdAt, requestId)
     VALUES (?, ?, 'contribution.create', 'contribution', ?, ?, ?, ?)`,
    [ulid(), req.user!.userId, id, JSON.stringify({ title: data.title, status }), now, req.requestId],
  )

  sendSuccess(res, { id, status, createdAt: now }, req.requestId, 201)
})

export default router
