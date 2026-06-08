import { Router, type Router as RouterType } from 'express'
import { exec, queryOne } from '../Database'
import { ulid, genId } from '../utils/ulid'
import { sendSuccess, sendError, Errors, zodErrorsToDetails } from '../utils/response'
import { requireAuth } from '../middleware/auth'
import { contributionSchema } from '../utils/validation'
import { rateLimitCheck } from '../middleware/rateLimit'
import { idempotencyKey } from '../middleware/idempotency'
import { writeAuditLog } from '../utils/audit'
import { markdownToHtml, plainTextToHtml } from '../utils/sanitize'
import { hmacToken } from '../utils/session'

/** Pure SHA-256 hash (for submitterUserAgentHash per api.md §15.11) */
async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const router: RouterType = Router()

// ──────────────────────────────────────────────
// POST /contributions — api.md §3 提交投稿
// ──────────────────────────────────────────────
router.post('/', requireAuth, (req, _res, next) => { req.rateLimitAction = 'submit'; next(); }, rateLimitCheck, idempotencyKey, async (req, res) => {
  // Verify email per api.md §3.4 — 403 EMAIL_NOT_VERIFIED
  const user = await queryOne(`SELECT status FROM users WHERE id = ?`, [req.user!.userId])
  if (!user || user.status !== 'active') {
    if (user?.status === 'banned') {
      sendError(res, Errors.ACCOUNT_BANNED.code, Errors.ACCOUNT_BANNED.message, req.requestId, Errors.ACCOUNT_BANNED.status)
      return
    }
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证，不能投稿', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }

  // Per-IP rate limit: 20/10min per api.md §3.1
  const now = Date.now()
  const submitIpWindow = Math.floor(now / 600_000) * 600_000
  const submitIpKey = `submit:ip:${req.ip || 'unknown'}:${submitIpWindow}`
  const submitIpCount = await queryOne(`SELECT count FROM rate_limits WHERE bucketKey = ? AND windowStart = ?`, [submitIpKey, submitIpWindow])
  if ((submitIpCount?.count as number || 0) >= 20) {
    const retryAfter = Math.ceil((submitIpWindow + 600_000 - now) / 1000)
    res.setHeader('Retry-After', String(retryAfter))
    sendError(res, Errors.RATE_LIMITED.code, '同一 IP 投稿过于频繁，请稍后重试', req.requestId, Errors.RATE_LIMITED.status)
    return
  }

  // New-user daily submission limit (per api.md §3.1: 3/day for new users)
  // "新注册用户" = within first 7 days of registration
  const NEW_USER_PERIOD_MS = 7 * 86400_000
  const userReg = await queryOne(`SELECT createdAt FROM users WHERE id = ?`, [req.user!.userId])
  if (userReg) {
    const userAge = Date.now() - (userReg.createdAt as number)
    if (userAge < NEW_USER_PERIOD_MS) {
      const todayStart = Math.floor(Date.now() / 86400_000) * 86400_000
      const todayCount = await queryOne(
        `SELECT COUNT(*) as cnt FROM contributions WHERE authorUserId = ? AND createdAt >= ?`,
        [req.user!.userId, todayStart],
      )
      if ((todayCount?.cnt as number || 0) >= 3) {
        const retryAfter = Math.ceil((todayStart + 86400_000 - Date.now()) / 1000)
        res.setHeader('Retry-After', String(retryAfter))
        sendError(res, Errors.RATE_LIMITED.code, '新用户每天最多投稿 3 次', req.requestId, Errors.RATE_LIMITED.status)
        return
      }
    }
  }

  // Honeypot check: if website field is filled, it's a bot (api.md §3 anti-spam)
  if ((req.body as Record<string, unknown>)?.website) {
    sendError(res, Errors.VALIDATION_ERROR.code, '检测到垃圾投稿', req.requestId, 422)
    return
  }

  const parsed = contributionSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, Errors.VALIDATION_ERROR.status, zodErrorsToDetails(parsed.error.flatten()))
    return
  }

  const data = parsed.data

  const id = genId('contrib_')
  const now = Date.now()
  const submitMode = data.submitMode || 'submit'
  const status = submitMode === 'draft' ? 'draft' : 'pending'

  const contentHtml =
    data.contentFormat === 'plain_text'
      ? plainTextToHtml(data.content)
      : markdownToHtml(data.content)

  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'
  const ipHash = await hmacToken(ip)
  const uaHash = await sha256(ua)    // sha256 per api.md §15.11

  try {
    await exec(
      `INSERT INTO contributions (id, authorUserId, title, summary, contentRaw, contentFormat, contentHtml, rendererVersion, status, version, language, tags, idempotencyKey, submitterIpHash, submitterUserAgentHash, submittedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'v1', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.user!.userId,
        data.title.trim(),
        data.summary?.trim() || null,
        data.content,
        data.contentFormat || 'markdown',
        contentHtml,
        status,
        data.language || 'zh-CN',
        JSON.stringify(data.tags || []),
        (req.headers['idempotency-key'] as string) || null,
        ipHash,
        uaHash,
        status === 'pending' ? now : null,
        now,
        now,
      ],
    )
  } catch (insertErr: unknown) {
    const mysqlErr = insertErr as { code?: string }
    if (mysqlErr.code === 'ER_DUP_ENTRY') {
      sendError(res, Errors.IDEMPOTENCY_KEY_MISMATCH.code, '重复提交', req.requestId, 409)
      return
    }
    throw insertErr
  }

  // Write audit log per api.md §3
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'contribution.submit',
    resourceType: 'contribution',
    resourceId: id,
    after: { title: data.title, status },
  })

  // Increment IP rate limit counter
  await exec(
    `INSERT INTO rate_limits (id, bucketKey, windowStart, count, createdAt) VALUES (?, ?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE count = count + 1`,
    [ulid(), submitIpKey, submitIpWindow, now],
  ).catch(() => {})

  sendSuccess(res, { id, status, createdAt: now }, req.requestId, 201)
})

export default router
