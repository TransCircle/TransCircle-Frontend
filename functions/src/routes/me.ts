import { Router, type Router as RouterType } from 'express'
import { sendSuccess, sendError, Errors } from '../utils/response'
import { query, queryOne, exec } from '../Database'
import { requireAuth } from '../middleware/auth'
import { rateLimitCheck } from '../middleware/rateLimit'
import { findUserById } from '../utils/users'
import { ulid, genId } from '../utils/ulid'
import { conf } from '../Config'
import { hmacToken } from '../utils/session'
import { writeAuditLog, canonicalJson, sha256base64url } from '../utils/audit'
import { findUnusedRecoveryCode } from '../utils/password'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const router: RouterType = Router()

// ──────────────────────────────────────────────
// GET /me — api.md §2.1 获取当前用户资料
// ──────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const user = await findUserById(req.user!.userId)
  if (!user) {
    sendError(res, Errors.USER_NOT_FOUND.code, '用户不存在', req.requestId, Errors.USER_NOT_FOUND.status)
    return
  }

  // Get OAuth providers bound to this account
  const oauthAccounts = await queryOne(
    `SELECT GROUP_CONCAT(provider) as providers FROM oauth_accounts WHERE userId = ?`,
    [req.user!.userId],
  )

  // Check if user has a password set
  const userRow = await queryOne(`SELECT passwordHash FROM users WHERE id = ?`, [req.user!.userId])
  const hasPassword = !!(userRow as Record<string, unknown> | null)?.passwordHash

  // Count active passkeys
  const passkeyRow = await queryOne(
    `SELECT COUNT(*) as count FROM passkeys WHERE userId = ? AND status = 'active'`,
    [req.user!.userId],
  )
  const passkeyCount = (passkeyRow?.count as number) || 0

  // Check TOTP status
  const totpRow = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'active' LIMIT 1`,
    [req.user!.userId],
  )

  const oauthProviders = oauthAccounts?.providers
    ? (oauthAccounts.providers as string).split(',')
    : []

  // Send response per api.md §2.1 format
  sendSuccess(
    res,
    {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
      status: user.status,
      roles: user.roles,
      security: {
        hasPassword,
        totpEnabled: !!totpRow,
        passkeyCount,
        oauthProviders,
      },
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    },
    req.requestId,
  )
})

// ──────────────────────────────────────────────
// PATCH /me — api.md §2.2 更新当前用户资料
// ──────────────────────────────────────────────
router.patch('/', requireAuth, (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const { displayName, avatarUrl } = req.body as {
    displayName?: string
    avatarUrl?: string | null
  }

  const updates: string[] = []
  const params: unknown[] = []

  if (displayName !== undefined) {
    const dn = displayName.trim()
    if ([...dn].length < 1 || [...dn].length > 50) {
      sendError(res, Errors.VALIDATION_ERROR.code, '显示名称需 1-50 个字符', req.requestId, 422)
      return
    }
    updates.push('displayName = ?')
    params.push(dn)
  }

  if (avatarUrl !== undefined) {
    // Must be a platform image URL or OAuth avatar URL; null = remove avatar
    if (avatarUrl !== null) {
      const apiBase = (conf.APP as Record<string, string | undefined> | undefined)?.API_URL || 'https://api.transcircle.org'
      const allowedPrefixes = [`${apiBase}/v1/images/`, 'https://avatars.githubusercontent.com/', 'https://pbs.twimg.com/']
      const allowed = allowedPrefixes.some((p) => avatarUrl.startsWith(p))
      if (!allowed) {
        sendError(res, Errors.VALIDATION_ERROR.code, 'avatarUrl 不在 allowlist 内', req.requestId, 422)
        return
      }
    }
    updates.push('avatarUrl = ?')
    params.push(avatarUrl)
  }

  if (updates.length === 0) {
    sendError(res, Errors.VALIDATION_ERROR.code, '没有要更新的字段', req.requestId, 422)
    return
  }

  const now = Date.now()
  updates.push('updatedAt = ?')
  params.push(now)
  params.push(req.user!.userId)

  await exec(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params)

  const updatedUser = await findUserById(req.user!.userId)
  if (!updatedUser) {
    sendError(res, Errors.USER_NOT_FOUND.code, '用户不存在', req.requestId, 404)
    return
  }

  // Re-fetch security info
  const oauthRow = await queryOne(
    `SELECT GROUP_CONCAT(provider) as providers FROM oauth_accounts WHERE userId = ?`,
    [req.user!.userId],
  )
  const userRow = await queryOne(`SELECT passwordHash FROM users WHERE id = ?`, [req.user!.userId])
  const hasPassword = !!(userRow as Record<string, unknown> | null)?.passwordHash
  const passkeyRow = await queryOne(
    `SELECT COUNT(*) as count FROM passkeys WHERE userId = ? AND status = 'active'`,
    [req.user!.userId],
  )
  const totpRow = await queryOne(
    `SELECT id FROM mfa_totp_credentials WHERE userId = ? AND status = 'active' LIMIT 1`,
    [req.user!.userId],
  )

  sendSuccess(res, {
    id: updatedUser.id,
    username: updatedUser.username,
    email: updatedUser.email,
    displayName: updatedUser.displayName,
    avatarUrl: updatedUser.avatarUrl,
    emailVerified: updatedUser.emailVerified,
    status: updatedUser.status,
    roles: updatedUser.roles,
    security: {
      hasPassword,
      totpEnabled: !!totpRow,
      passkeyCount: (passkeyRow?.count as number) || 0,
      oauthProviders: oauthRow?.providers ? (oauthRow.providers as string).split(',') : [],
    },
    createdAt: updatedUser.createdAt,
    lastLoginAt: updatedUser.lastLoginAt,
    updatedAt: now,
  }, req.requestId)
})

// ══════════════════════════════════════════════
// My Contributions — api.md §4
// ══════════════════════════════════════════════

// 4.1 GET /me/contributions — 获取我的投稿列表
router.get('/contributions', requireAuth, async (req, res) => {
  const status = req.query.status as string | undefined
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100)
  const cursor = req.query.cursor as string | undefined
  const sort = (req.query.sort as string) || 'createdAt_desc'

  let whereClause = 'WHERE c.authorUserId = ?'
  const params: unknown[] = [req.user!.userId]

  if (status) {
    whereClause += ' AND c.status = ?'
    params.push(status)
  }
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf-8')
      whereClause += ' AND c.createdAt < ?'
      params.push(parseInt(decoded, 10))
    } catch {
      sendError(res, Errors.VALIDATION_ERROR.code, '无效的 cursor', req.requestId, 422)
      return
    }
  }

  const orderBy = sort === 'createdAt_asc' ? 'ORDER BY c.createdAt ASC'
    : sort === 'updatedAt_desc' ? 'ORDER BY c.updatedAt DESC'
    : sort === 'updatedAt_asc' ? 'ORDER BY c.updatedAt ASC'
    : 'ORDER BY c.createdAt DESC'

  params.push(limit + 1)

  const rows = await query(
    `SELECT c.id, c.title, c.status, c.createdAt, c.updatedAt
     FROM contributions c ${whereClause} ${orderBy} LIMIT ?`,
    params,
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  // Fetch latest review event for each contribution
  const data = await Promise.all((rows as Array<Record<string, unknown>>).map(async (r) => {
    const review = await queryOne(
      `SELECT publicNote, createdAt as reviewedAt FROM contribution_review_events
       WHERE contributionId = ? AND action = 'review' ORDER BY createdAt DESC LIMIT 1`,
      [r.id],
    )
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      review: {
        publicNote: review?.publicNote || null,
        reviewedAt: review?.reviewedAt || null,
      },
    }
  }))

  const nextCursor = hasMore && rows.length > 0
    ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).createdAt)).toString('base64url')
    : null

  sendSuccess(res, data, req.requestId, 200, { nextCursor, hasMore, limit })
})

// 4.2 GET /me/contributions/:id — 获取我的投稿详情
router.get('/contributions/:id', requireAuth, async (req, res) => {
  const { id } = req.params

  const row = await queryOne(
    `SELECT c.* FROM contributions c WHERE c.id = ? AND c.authorUserId = ?`,
    [id, req.user!.userId],
  )

  if (!row) {
    sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在', req.requestId, 404)
    return
  }

  // Get latest review — use toStatus not action per api.md §4.2
  const latestReview = await queryOne(
    `SELECT reviewerUserId, createdAt as reviewedAt, toStatus as decision, publicNote
     FROM contribution_review_events WHERE contributionId = ? AND action = 'review'
     ORDER BY createdAt DESC LIMIT 1`,
    [id],
  )

  const reviewerName = latestReview
    ? await queryOne(`SELECT displayName FROM users WHERE id = ?`, [latestReview.reviewerUserId])
    : null

  sendSuccess(res, {
    id: row.id,
    title: row.title,
    summary: row.summary || null,
    contentRaw: row.contentRaw,
    contentFormat: row.contentFormat,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags as string) : row.tags || [],
    language: row.language,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt || null,
    publishedAt: row.publishedAt || null,
    review: latestReview ? {
      reviewerDisplayName: reviewerName?.displayName || null,
      reviewedAt: latestReview.reviewedAt,
      decision: latestReview.decision,
      publicNote: latestReview.publicNote || null,
    } : {
      reviewerDisplayName: null,
      reviewedAt: null,
      decision: null,
      publicNote: null,
    },
  }, req.requestId)
})

// 4.3 PATCH /me/contributions/:id — 修改草稿
router.patch('/contributions/:id', requireAuth, async (req, res) => {
  const { id } = req.params
  const { title, content, contentFormat, summary, tags, language, expectedVersion } = req.body as {
    title?: string; content?: string; contentFormat?: string; summary?: string | null
    tags?: string[]; language?: string; expectedVersion: number
  }

  if (!expectedVersion) {
    sendError(res, Errors.VALIDATION_ERROR.code, 'expectedVersion 必填', req.requestId, 422)
    return
  }

  const contrib = await queryOne(
    `SELECT id, status, version FROM contributions WHERE id = ? AND authorUserId = ?`,
    [id, req.user!.userId],
  )
  if (!contrib) {
    sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在', req.requestId, 404)
    return
  }

  const allowedStatuses = ['draft', 'rejected', 'withdrawn']
  if (!allowedStatuses.includes(contrib.status as string)) {
    sendError(res, 'INVALID_STATE_TRANSITION', '当前状态不允许修改', req.requestId, 409)
    return
  }
  if (contrib.version !== expectedVersion) {
    sendError(res, Errors.VERSION_CONFLICT.code, '版本冲突', req.requestId, Errors.VERSION_CONFLICT.status)
    return
  }

  const updates: string[] = []
  const params: unknown[] = []

  if (title !== undefined) { updates.push('title = ?'); params.push(title.trim()) }
  if (content !== undefined) {
    // Per api.md §4.3: providing content requires contentFormat
    if (!contentFormat) {
      sendError(res, Errors.VALIDATION_ERROR.code, '提供正文时必须指定 contentFormat', req.requestId, 422)
      return
    }
    updates.push('contentRaw = ?'); params.push(content)
  }
  if (contentFormat !== undefined) { updates.push('contentFormat = ?'); params.push(contentFormat) }
  if (summary !== undefined) { updates.push('summary = ?'); params.push(summary || null) }
  if (tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(tags)) }
  if (language !== undefined) { updates.push('language = ?'); params.push(language) }

  if (updates.length === 0) {
    sendError(res, Errors.VALIDATION_ERROR.code, '没有要更新的字段', req.requestId, 422)
    return
  }

  updates.push('version = version + 1')
  updates.push('updatedAt = ?')
  const now = Date.now()
  params.push(now)

  const result = await exec(
    `UPDATE contributions SET ${updates.join(', ')} WHERE id = ? AND version = ? AND authorUserId = ?`,
    [...params, id, expectedVersion, req.user!.userId],
  )

  if (result.affectedRows === 0) {
    sendError(res, Errors.VERSION_CONFLICT.code, '更新失败，请刷新后重试', req.requestId, 409)
    return
  }

  const updated = await queryOne(
    `SELECT * FROM contributions WHERE id = ?`, [id],
  )
  if (!updated) {
    sendError(res, Errors.INTERNAL_ERROR.code, '查询失败', req.requestId, 500)
    return
  }

  sendSuccess(res, {
    id: updated.id, title: updated.title, summary: updated.summary || null,
    contentRaw: updated.contentRaw, contentFormat: updated.contentFormat,
    tags: typeof updated.tags === 'string' ? JSON.parse(updated.tags as string) : updated.tags || [],
    language: updated.language, status: updated.status, version: updated.version,
    createdAt: updated.createdAt, updatedAt: updated.updatedAt,
    submittedAt: updated.submittedAt || null, publishedAt: updated.publishedAt || null,
    review: { reviewerDisplayName: null, reviewedAt: null, decision: null, publicNote: null },
  }, req.requestId)
})

// 4.4 POST /me/contributions/:id/submit — 提交草稿
router.post('/contributions/:id/submit', requireAuth, async (req, res) => {
  const { id } = req.params
  const { expectedVersion } = req.body as { expectedVersion?: number }
  if (!expectedVersion) {
    sendError(res, Errors.VALIDATION_ERROR.code, 'expectedVersion 必填', req.requestId, 422)
    return
  }

  const contrib = await queryOne(
    `SELECT id, status, version FROM contributions WHERE id = ? AND authorUserId = ?`,
    [id, req.user!.userId],
  )
  if (!contrib) { sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在', req.requestId, 404); return }

  const allowedStatuses = ['draft', 'rejected', 'withdrawn']
  if (!allowedStatuses.includes(contrib.status as string)) {
    sendError(res, 'INVALID_STATE_TRANSITION', '当前状态不可提交', req.requestId, 409); return
  }
  if (contrib.version !== expectedVersion) {
    sendError(res, Errors.VERSION_CONFLICT.code, '版本冲突', req.requestId, Errors.VERSION_CONFLICT.status); return
  }

  // Require email verification per spec
  const user = await queryOne(`SELECT status FROM users WHERE id = ?`, [req.user!.userId])
  if (user?.status !== 'active') {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证，不能投稿', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }

  const now = Date.now()
  const result = await exec(
    `UPDATE contributions SET status = 'pending', version = version + 1, submittedAt = ?, updatedAt = ?
     WHERE id = ? AND version = ? AND authorUserId = ?`,
    [now, now, id, expectedVersion, req.user!.userId],
  )
  if (result.affectedRows === 0) {
    sendError(res, Errors.VERSION_CONFLICT.code, '提交失败', req.requestId, 409); return
  }

  sendSuccess(res, { id, status: 'pending', version: (contrib.version as number) + 1, submittedAt: now }, req.requestId)
})

// 4.5 POST /me/contributions/:id/withdraw — 撤回投稿
router.post('/contributions/:id/withdraw', requireAuth, async (req, res) => {
  const { id } = req.params
  const { expectedVersion } = req.body as { expectedVersion?: number }
  if (!expectedVersion) {
    sendError(res, Errors.VALIDATION_ERROR.code, 'expectedVersion 必填', req.requestId, 422); return
  }

  const contrib = await queryOne(
    `SELECT id, status, version FROM contributions WHERE id = ? AND authorUserId = ?`,
    [id, req.user!.userId],
  )
  if (!contrib) { sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在', req.requestId, 404); return }

  const allowedStatuses = ['pending', 'in_review']
  if (!allowedStatuses.includes(contrib.status as string)) {
    sendError(res, 'INVALID_STATE_TRANSITION', '当前状态不可撤回', req.requestId, 409); return
  }
  if (contrib.version !== expectedVersion) {
    sendError(res, Errors.VERSION_CONFLICT.code, '版本冲突', req.requestId, Errors.VERSION_CONFLICT.status); return
  }

  const now = Date.now()
  const result = await exec(
    `UPDATE contributions SET status = 'withdrawn', version = version + 1, updatedAt = ?
     WHERE id = ? AND version = ? AND authorUserId = ?`,
    [now, id, expectedVersion, req.user!.userId],
  )
  if (result.affectedRows === 0) {
    sendError(res, Errors.VERSION_CONFLICT.code, '撤回失败', req.requestId, 409); return
  }

  sendSuccess(res, { id, status: 'withdrawn', version: (contrib.version as number) + 1, updatedAt: now }, req.requestId)
})

// ══════════════════════════════════════════════
// GDPR 接口 — api.md §2
// ══════════════════════════════════════════════

// ──────────────────────────────────────────────
// 2.3 POST /me/export — 导出我的数据 (GDPR)
// ──────────────────────────────────────────────
router.post('/export', requireAuth, (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const now = Date.now()

  // 校验邮箱已验证 + status=active
  const user = await queryOne(
    `SELECT status, emailVerified FROM users WHERE id = ?`,
    [req.user!.userId],
  )
  if (!user || user.status !== 'active') {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }
  if (!user.emailVerified) {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }

  // 7 天内最多 2 次
  const sevenDaysAgo = now - 7 * 86400_000
  const recentExports = await queryOne(
    `SELECT COUNT(*) as cnt, MIN(createdAt) as firstExport FROM audit_logs WHERE actorUserId = ? AND action = 'me.export' AND createdAt >= ?`,
    [req.user!.userId, sevenDaysAgo],
  )
  if ((recentExports?.cnt as number || 0) >= 2) {
    const firstExport = recentExports?.firstExport as number | undefined
    const retryAfter = firstExport
      ? Math.ceil(Math.max(0, firstExport + 7 * 86400_000 - now) / 1000)
      : 7 * 86400
    res.setHeader('Retry-After', String(retryAfter))
    sendError(res, Errors.RATE_LIMITED.code, '7 天内最多导出 2 次', req.requestId, 429)
    return
  }

  const exportId = genId('exp_')

  // 写入 audit_logs（含导出数据范围，用于异步 worker 追踪）
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'me.export',
    resourceType: 'user',
    resourceId: req.user!.userId,
    after: {
      exportId,
      status: 'queued',
      scope: ['profile', 'contributions', 'edit_requests', 'images', 'oauth_accounts', 'sessions'],
    },
  })

  // ── 内联导出: 对小型用户（投稿 < 100）直接在请求线程中收集并生成 JSON 导出 ──
  try {
    const contribCount = await queryOne(
      `SELECT COUNT(*) as cnt FROM contributions WHERE authorUserId = ?`,
      [req.user!.userId],
    )
    const totalContribs = (contribCount?.cnt as number) || 0

    if (totalContribs < 100) {
      // Collect profile
      const profile = await queryOne(
        `SELECT id, username, email, emailVerified, displayName, avatarUrl, status, createdAt, lastLoginAt FROM users WHERE id = ?`,
        [req.user!.userId],
      )

      // Collect contributions (no internalNote/internal content)
      const contributions = await query(
        `SELECT id, title, summary, contentFormat, language, status, version, createdAt, updatedAt, submittedAt, publishedAt
         FROM contributions WHERE authorUserId = ? ORDER BY createdAt DESC`,
        [req.user!.userId],
      )

      // Collect edit requests
      const editRequests = await query(
        `SELECT id, contributionId, reason, proposedTitle, proposedSummary, proposedContentFormat, status, createdAt
         FROM contribution_edit_requests WHERE requesterId = ? ORDER BY createdAt DESC`,
        [req.user!.userId],
      )

      // Collect image metadata
      const images = await query(
        `SELECT id, mimeType, size, width, height, sha256, createdAt FROM images WHERE uploaderId = ? ORDER BY createdAt DESC`,
        [req.user!.userId],
      )

      // Collect OAuth bindings
      const oauthAccounts = await query(
        `SELECT provider, providerUsername, providerDisplayName, createdAt as boundAt
         FROM oauth_accounts WHERE userId = ?`,
        [req.user!.userId],
      )

      // Collect session summary
      const sessions = await query(
        `SELECT id, loginMethod, ipPrefix, createdAt, lastUsedAt FROM sessions WHERE userId = ? AND revokedAt IS NULL ORDER BY createdAt DESC`,
        [req.user!.userId],
      )

      const exportData = {
        exportedAt: now,
        exportId,
        profile: profile
          ? { id: profile.id, username: profile.username, email: profile.email, emailVerified: !!profile.emailVerified, displayName: profile.displayName, avatarUrl: profile.avatarUrl, status: profile.status, createdAt: profile.createdAt, lastLoginAt: profile.lastLoginAt }
          : null,
        contributions: (contributions as Array<Record<string, unknown>>).map((c) => ({
          id: c.id, title: c.title, summary: c.summary || null, contentFormat: c.contentFormat,
          language: c.language, status: c.status, version: c.version,
          createdAt: c.createdAt, updatedAt: c.updatedAt, submittedAt: c.submittedAt || null, publishedAt: c.publishedAt || null,
        })),
        editRequests: (editRequests as Array<Record<string, unknown>>).map((e) => ({
          id: e.id, contributionId: e.contributionId, reason: e.reason,
          proposedTitle: e.proposedTitle || null, proposedSummary: e.proposedSummary || null,
          status: e.status, createdAt: e.createdAt,
        })),
        images: (images as Array<Record<string, unknown>>).map((i) => ({
          id: i.id, mimeType: i.mimeType, size: i.size, width: i.width, height: i.height,
          sha256: i.sha256, createdAt: i.createdAt,
        })),
        oauthAccounts: (oauthAccounts as Array<Record<string, unknown>>).map((o) => ({
          provider: o.provider, providerUsername: o.providerUsername, providerDisplayName: o.providerDisplayName, boundAt: o.boundAt,
        })),
        sessions: (sessions as Array<Record<string, unknown>>).map((s) => ({
          id: s.id, loginMethod: s.loginMethod, ipPrefix: s.ipPrefix || null,
          createdAt: s.createdAt, lastUsedAt: s.lastUsedAt || null,
        })),
      }

      // Write export file
      const exportDir = join(process.cwd(), 'storage', 'exports')
      if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true })
      const exportPath = join(exportDir, `${exportId}.json`)
      writeFileSync(exportPath, JSON.stringify(exportData, null, 2), 'utf-8')

      // Create export_jobs record
      await exec(
        `INSERT INTO export_jobs (id, userId, status, exportPath, createdAt, completedAt)
         VALUES (?, ?, 'completed', ?, ?, ?)`,
        [exportId, req.user!.userId, exportPath, now, now],
      ).catch(() => {
        // table might not exist yet — non-fatal
      })

      // Per api.md §2.3: status must always be 'queued' — export is async even when fast
      sendSuccess(res, {
        exportId,
        status: 'queued',
        createdAt: now,
      }, req.requestId, 202)
      return
    }
  } catch {
    // inline export failed — fall through to queued response
  }

  sendSuccess(res, {
    exportId,
    status: 'queued',
    createdAt: now,
  }, req.requestId, 202)
})

// ──────────────────────────────────────────────
// 2.4 POST /me/delete — 注销账户 (GDPR)
// ──────────────────────────────────────────────
router.post('/delete', requireAuth, (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const { confirmation, password } = req.body as { confirmation?: string; password?: string }

  if (confirmation !== 'DELETE-MY-ACCOUNT') {
    sendError(res, Errors.VALIDATION_ERROR.code, '必须输入 DELETE-MY-ACCOUNT 确认', req.requestId, 422)
    return
  }

  // 校验 step-up (5 分钟内)
  const session = await queryOne(
    `SELECT lastStepUpAt FROM sessions WHERE id = ? AND userId = ?`,
    [req.user!.sessionId, req.user!.userId],
  )
  if (!session?.lastStepUpAt || Date.now() - session.lastStepUpAt > 300_000) {
    sendError(res, 'STEP_UP_REQUIRED', '需要二次认证', req.requestId, 403)
    return
  }

  // 校验 status = active
  const user = await queryOne(
    `SELECT id, status, passwordHash, email FROM users WHERE id = ?`,
    [req.user!.userId],
  )
  if (!user || user.status !== 'active') {
    if (user?.status === 'pending_verification') {
      sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    } else {
      sendError(res, Errors.FORBIDDEN.code, '当前状态不允许注销', req.requestId, Errors.FORBIDDEN.status)
    }
    return
  }

  // 如已设置密码，校验密码
  if (user.passwordHash) {
    if (!password) {
      sendError(res, Errors.INVALID_CREDENTIALS.code, '密码不能为空', req.requestId, Errors.INVALID_CREDENTIALS.status)
      return
    }
    const { verifyPassword } = await import('../utils/password')
    const valid = await verifyPassword(user.passwordHash as string, password)
    if (!valid) {
      sendError(res, Errors.INVALID_CREDENTIALS.code, '密码错误', req.requestId, Errors.INVALID_CREDENTIALS.status)
      return
    }
  }

  const now = Date.now()
  const deletionScheduledFor = now + 30 * 86400_000

  // 生成 cancelToken（在事务外声明，用于事务内存储和事务外发邮件）
  let cancelToken: string
  const { getConnection } = await import('../Database')
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    // 标记用户状态
    await conn.execute(
      `UPDATE users SET status = 'pending_deletion', tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ? AND status = 'active'`,
      [now, req.user!.userId],
    )

    // 吊销全部 sessions
    await conn.execute(
      `UPDATE sessions SET revokedAt = ?, revokedReason = 'account_pending_deletion' WHERE userId = ? AND revokedAt IS NULL`,
      [now, req.user!.userId],
    )
    await conn.execute(
      `UPDATE refresh_token_events SET status = 'revoked'
       WHERE sessionId IN (SELECT id FROM sessions WHERE userId = ?)
         AND status IN ('active', 'rotated')`,
      [req.user!.userId],
    )

    // 冻结 passkeys
    await conn.execute(
      `UPDATE passkeys SET status = 'frozen', frozenReason = 'account_pending_deletion' WHERE userId = ? AND status = 'active'`,
      [req.user!.userId],
    )

    // 冻结 mfa_totp_credentials
    await conn.execute(
      `UPDATE mfa_totp_credentials SET status = 'frozen' WHERE userId = ? AND status = 'active'`,
      [req.user!.userId],
    )

    // 生成 cancelToken
    cancelToken = genId('dc_') + ulid().slice(0, 16)
    const cancelHash = await hmacToken(cancelToken)
    await conn.execute(
      `INSERT INTO auth_tokens (id, userId, type, tokenHash, metadata, expiresAt, createdAt)
       VALUES (?, ?, 'account_delete_cancel', ?, ?, ?, ?)`,
      [ulid(), req.user!.userId, cancelHash,
       JSON.stringify({ deletionScheduledFor }), deletionScheduledFor, now],
    )

    // 审计日志（带哈希链 per api.md §15.13）
    const auditId = genId('aud_')
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const ua = req.headers['user-agent'] || 'unknown'
    const deleteAfterData = { deletionScheduledFor }
    const deleteCanonicalAfter = canonicalJson(deleteAfterData)
    // Compute prevHash inside transaction — FOR UPDATE prevents concurrent hash chain forks (api.md §15.13)
    const [lastAuditRow] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT entryHash FROM audit_logs ORDER BY createdAt DESC LIMIT 1 FOR UPDATE`,
    )
    const deletePrevHash = (lastAuditRow[0]?.entryHash as string) ?? null
    const deleteRecordData = {
      id: auditId, actorUserId: req.user!.userId, action: 'me.delete',
      resourceType: 'user', resourceId: req.user!.userId,
      before: null, after: deleteAfterData, metadata: {},
      createdAt: now, requestId: req.requestId,
      ipHash: await hmacToken(ip), uaHash: await hmacToken(ua),
    }
    const deleteCanonicalRecord = canonicalJson(deleteRecordData)
    const deleteChainInput = deletePrevHash ? `${deletePrevHash}|${deleteCanonicalRecord}` : deleteCanonicalRecord
    const deleteEntryHash = await sha256base64url(deleteChainInput)
    await conn.execute(
      `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, \`before\`, after, metadata, createdAt, requestId, ipHash, userAgentHash, prevHash, entryHash)
       VALUES (?, ?, 'me.delete', 'user', ?, NULL, ?, '{}', ?, ?, ?, ?, ?, ?)`,
      [auditId, req.user!.userId, req.user!.userId,
       deleteCanonicalAfter, now, req.requestId,
       await hmacToken(ip), await hmacToken(ua),
       deletePrevHash, deleteEntryHash],
    )

    await conn.commit()
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('delete account error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '注销失败', req.requestId, 500)
    return
  } finally {
    conn.release()
  }

  // 异步发送撤销邮件
  const email = user.email as string
  if (email && cancelToken) {
    const { sendEmail, buildCancelDeletionEmail } = await import('../utils/mail')
    sendEmail(buildCancelDeletionEmail(email, cancelToken)).catch((e: unknown) =>
      console.error('cancel deletion email error:', (e as Error).message || e),
    )
  }

  sendSuccess(res, {
    deletionScheduledFor,
    cancelEmailSent: !!email,
  }, req.requestId, 202)
})

// ──────────────────────────────────────────────
// 2.5 POST /me/delete/cancel — 撤销账户注销
// ──────────────────────────────────────────────
router.post('/delete/cancel', (req, _res, next) => { req.rateLimitAction = 'auth'; next(); }, rateLimitCheck, async (req, res) => {
  const { cancelToken, identifier, password, mfaCode, passkeyAssertion } = req.body as {
    cancelToken?: string; identifier?: string; password?: string
    mfaCode?: string; passkeyAssertion?: unknown
  }

  if (!cancelToken || !identifier) {
    sendError(res, Errors.BAD_REQUEST.code, '缺少必要参数', req.requestId, 400)
    return
  }

  const now = Date.now()
  const tokenHash = await hmacToken(cancelToken)

  // 单事务执行
  const { getConnection } = await import('../Database')
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    // 查找 cancelToken
    const [lockRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT id, userId, metadata FROM auth_tokens
       WHERE tokenHash = ? AND type = 'account_delete_cancel' AND usedAt IS NULL AND expiresAt > ?
       FOR UPDATE`,
      [tokenHash, now],
    )
    if ((lockRows as unknown[]).length === 0) {
      await conn.rollback()
      sendError(res, 'TOKEN_INVALID_OR_EXPIRED', '取消令牌无效或已过期', req.requestId, 410)
      return
    }

    const tokenRecord = lockRows[0] as { id: string; userId: string; metadata: string }
    const tokenUserId = tokenRecord.userId

    // 校验 identifier 与 token 关联用户一致
    const findUser = await queryOne(
      `SELECT id, status, passwordHash, email FROM users WHERE id = ?`,
      [tokenUserId],
    )
    if (!findUser) {
      await conn.rollback()
      sendError(res, Errors.INVALID_CREDENTIALS.code, '用户不存在', req.requestId, Errors.INVALID_CREDENTIALS.status)
      return
    }

    // 校验 identifier
    if (findUser.email !== identifier && findUser.username !== identifier) {
      await conn.rollback()
      sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
      return
    }

    // 校验密码
    if (findUser.passwordHash) {
      if (!password) {
        await conn.rollback()
        sendError(res, Errors.INVALID_CREDENTIALS.code, '密码不能为空', req.requestId, Errors.INVALID_CREDENTIALS.status)
        return
      }
      const { verifyPassword } = await import('../utils/password')
      const valid = await verifyPassword(findUser.passwordHash as string, password)
      if (!valid) {
        await conn.rollback()
        sendError(res, Errors.INVALID_CREDENTIALS.code, Errors.INVALID_CREDENTIALS.message, req.requestId, Errors.INVALID_CREDENTIALS.status)
        return
      }
    } else if (!passkeyAssertion) {
      // OAuth-only 账户必须提供 Passkey assertion
      await conn.rollback()
      sendError(res, Errors.INVALID_CREDENTIALS.code, '需要 Passkey 验证', req.requestId, Errors.INVALID_CREDENTIALS.status)
      return
    }

    // 校验 MFA (if enabled)
    if (mfaCode) {
      const totpCred = await queryOne(
        `SELECT id, secretEncrypted, lastUsedTimeStep FROM mfa_totp_credentials WHERE userId = ? AND status = 'frozen' LIMIT 1`,
        [tokenUserId],
      )
      if (totpCred) {
        const { decryptSecret } = await import('../utils/crypto')
        const { verifyTotpCode } = await import('../utils/totp')
        const encryptedSecret = totpCred.secretEncrypted as string
        const secret = await decryptSecret(encryptedSecret)
        const lastUsedTimeStep = totpCred.lastUsedTimeStep as number | null

        const candidateTimeStep = await verifyTotpCode(secret, mfaCode, lastUsedTimeStep)
        if (candidateTimeStep === null) {
          // Try as recovery code (argon2id scan per api.md §15.7)
          const rcIdFromPool = await findUnusedRecoveryCode(tokenUserId, mfaCode)
          if (!rcIdFromPool) {
            await conn.rollback()
            sendError(res, 'INVALID_TOTP_CODE', '验证码或恢复码错误', req.requestId, 422)
            return
          }
          // FOR UPDATE check within transaction to prevent race
          const [rcCheckRows] = await conn.execute<import('mysql2').RowDataPacket[]>(
            `SELECT id FROM mfa_recovery_codes WHERE id = ? AND usedAt IS NULL FOR UPDATE`,
            [rcIdFromPool],
          )
          if (!rcCheckRows[0]) {
            await conn.rollback()
            sendError(res, 'INVALID_TOTP_CODE', '恢复码已被使用', req.requestId, 422)
            return
          }
          await conn.execute(`UPDATE mfa_recovery_codes SET usedAt = ? WHERE id = ?`, [now, rcCheckRows[0].id])
        } else {
          await conn.execute(`UPDATE mfa_totp_credentials SET lastUsedTimeStep = ? WHERE id = ?`, [candidateTimeStep, totpCred.id])
        }
      }
    }

    // 标记 cancelToken 已使用
    await conn.execute(`UPDATE auth_tokens SET usedAt = ? WHERE id = ?`, [now, tokenRecord.id])

    // 恢复用户状态
    await conn.execute(
      `UPDATE users SET status = 'active', tokenVersion = tokenVersion + 1, updatedAt = ? WHERE id = ? AND status = 'pending_deletion'`,
      [now, tokenUserId],
    )

    // 解冻 passkeys
    await conn.execute(
      `UPDATE passkeys SET status = 'active', frozenReason = NULL WHERE userId = ? AND frozenReason = 'account_pending_deletion'`,
      [tokenUserId],
    )

    // 解冻 TOTP
    await conn.execute(
      `UPDATE mfa_totp_credentials SET status = 'active' WHERE userId = ? AND status = 'frozen'`,
      [tokenUserId],
    )

    // 审计日志（带哈希链 per api.md §15.13）
    const cancelAuditId = genId('aud_')
    const cancelIp = req.ip || req.socket.remoteAddress || 'unknown'
    const cancelUa = req.headers['user-agent'] || 'unknown'
    const cancelAfterData = { status: 'active' }
    const cancelCanonicalAfter = canonicalJson(cancelAfterData)
    const [lastCancelAudit] = await conn.execute<import('mysql2').RowDataPacket[]>(
      `SELECT entryHash FROM audit_logs ORDER BY createdAt DESC LIMIT 1 FOR UPDATE`,
    )
    const cancelPrevHash = (lastCancelAudit[0]?.entryHash as string) ?? null
    const cancelRecordData = {
      id: cancelAuditId, actorUserId: tokenUserId, action: 'me.delete.cancel',
      resourceType: 'user', resourceId: tokenUserId,
      before: null, after: cancelAfterData, metadata: {},
      createdAt: now, requestId: req.requestId,
      ipHash: await hmacToken(cancelIp), uaHash: await hmacToken(cancelUa),
    }
    const cancelCanonicalRecord = canonicalJson(cancelRecordData)
    const cancelChainInput = cancelPrevHash ? `${cancelPrevHash}|${cancelCanonicalRecord}` : cancelCanonicalRecord
    const cancelEntryHash = await sha256base64url(cancelChainInput)
    await conn.execute(
      `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, \`before\`, after, metadata, createdAt, requestId, ipHash, userAgentHash, prevHash, entryHash)
       VALUES (?, ?, 'me.delete.cancel', 'user', ?, NULL, ?, '{}', ?, ?, ?, ?, ?, ?)`,
      [cancelAuditId, tokenUserId, tokenUserId,
       cancelCanonicalAfter, now, req.requestId,
       await hmacToken(cancelIp), await hmacToken(cancelUa),
       cancelPrevHash, cancelEntryHash],
    )

    // 统计 reactivated passkeys
    const passkeyCount = await queryOne(
      `SELECT COUNT(*) as cnt FROM passkeys WHERE userId = ? AND status = 'active'`,
      [tokenUserId],
    )

    await conn.commit()

    sendSuccess(res, {
      userId: tokenUserId,
      status: 'active',
      passkeysReactivated: (passkeyCount?.cnt as number) || 0,
    }, req.requestId)
  } catch (err) {
    await conn.rollback().catch(() => {})
    console.error('cancel delete error:', err)
    sendError(res, Errors.INTERNAL_ERROR.code, '撤销注销失败', req.requestId, 500)
  } finally {
    conn.release()
  }
})

export default router
