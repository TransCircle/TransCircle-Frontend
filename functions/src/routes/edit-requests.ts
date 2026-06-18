import { Router, type Request } from 'express'
import type mysql from 'mysql2'
import { exec, queryOne, query } from '../Database'
import { genId } from '../utils/ulid'
import { sendSuccess, sendError, Errors, zodErrorsToDetails } from '../utils/response'
import { requireAuth, requireReviewer } from '../middleware/auth'
import { writeAuditLog } from '../utils/audit'
import { markdownToHtml, plainTextToHtml } from '../utils/sanitize'
import { requirePerm } from '../utils/permissions'
import { z } from 'zod'

/** Votes required for edit request resolution per api.md §10.6 */
const REQUIRED_VOTES = 2

/** Helper to extract string param in Express 5 */
function paramStr(req: Request, name: string): string {
  const v = req.params[name]
  return Array.isArray(v) ? v[0] ?? '' : v ?? ''
}

const router: Router = Router()

// ─── Validation schemas ────────────────────────────────────────────

const createEditRequestSchema = z.object({
  reason: z.string().min(1, '修改原因不能为空').refine((v) => [...v].length <= 500, '修改原因最多 500 个字符'),
  proposedTitle: z.string().refine((v) => [...v].length <= 120, '标题最多 120 个字符').optional(),
  proposedContent: z.string().refine((v) => [...v].length <= 50000, '正文最多 50000 字符').optional(),
  proposedContentFormat: z.enum(['markdown', 'plain_text']).optional(),
  proposedSummary: z.string().refine((v) => [...v].length <= 300, '摘要最多 300 个字符').optional(),
  proposedTags: z.array(z.string()).max(8, '最多 8 个标签').optional(),
}).refine(
  (data) => data.proposedTitle !== undefined || data.proposedContent !== undefined
    || data.proposedSummary !== undefined || data.proposedTags !== undefined,
  { message: '至少需要提供一项修改内容', path: ['_form'] },
).refine(
  (data) => !data.proposedContent || data.proposedContentFormat !== undefined,
  { message: '提供 proposedContent 时 proposedContentFormat 必填', path: ['proposedContentFormat'] },
)

const withdrawEditRequestSchema = z.object({
  expectedVersion: z.number().int().positive('version 必须为正整数'),
})

const voteSchema = z.object({
  vote: z.enum(['approve', 'reject']),
  note: z.string().refine((v) => [...v].length <= 500, '备注最多 500 个字符').nullable().optional(),
  expectedVersion: z.number().int().positive('version 必须为正整数'),
})

// ─── 10.1 POST /v1/contributions/{id}/edit-requests — 提交修改申请 ──

router.post('/contributions/:id/edit-requests', requireAuth, async (req, res) => {
  // Check email verified per api.md §10.1
  const user = await queryOne(`SELECT status FROM users WHERE id = ?`, [req.user!.userId])
  if (!user || user.status !== 'active') {
    sendError(res, Errors.EMAIL_NOT_VERIFIED.code, '邮箱未验证', req.requestId, Errors.EMAIL_NOT_VERIFIED.status)
    return
  }

  const contributionId = paramStr(req, 'id')

  // Check contribution exists and is published per api.md §10.1
  const contrib = await queryOne(
    `SELECT id, status FROM contributions WHERE id = ?`,
    [contributionId],
  )
  if (!contrib) {
    sendError(res, Errors.CONTRIBUTION_NOT_FOUND.code, '投稿不存在', req.requestId, Errors.CONTRIBUTION_NOT_FOUND.status)
    return
  }
  if (contrib.status !== 'published') {
    sendError(res, 'CONTRIBUTION_NOT_EDITABLE', '只能对已发布的投稿发起修改申请', req.requestId, 409)
    return
  }

  const parsed = createEditRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, Errors.VALIDATION_ERROR.status, zodErrorsToDetails(parsed.error.flatten()))
    return
  }

  const { reason, proposedTitle, proposedContent, proposedContentFormat, proposedSummary, proposedTags } = parsed.data
  const now = Date.now()
  const editReqId = genId('edr_')

  // Check for pending edit request from same user on same contribution
  const existingPending = await queryOne(
    `SELECT id FROM contribution_edit_requests WHERE contributionId = ? AND requesterId = ? AND status = 'pending'`,
    [contributionId, req.user!.userId],
  )
  if (existingPending) {
    sendError(res, Errors.CONFLICT.code, '您已有一项待处理的修改申请', req.requestId, Errors.CONFLICT.status)
    return
  }

  await exec(
    `INSERT INTO contribution_edit_requests (id, contributionId, requesterId, reason,
     proposedTitle, proposedContent, proposedContentFormat, proposedSummary, proposedTags,
     status, version, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
    [editReqId, contributionId, req.user!.userId, reason,
     proposedTitle || null, proposedContent || null, proposedContentFormat || null,
     proposedSummary || null, proposedTags ? JSON.stringify(proposedTags) : null,
     now, now],
  )

  // Audit log
  await writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'contribution.edit_request.create',
    resourceType: 'contribution',
    resourceId: contributionId,
    after: { editRequestId: editReqId, reason },
  })

  sendSuccess(res, {
    id: editReqId,
    contributionId,
    status: 'pending',
    createdAt: now,
  }, req.requestId, 201)
})

// ─── 10.2 POST /v1/me/edit-requests/{id}/withdraw — 撤回修改申请 ──

router.post('/me/edit-requests/:id/withdraw', requireAuth, async (req, res) => {
  const id = paramStr(req, 'id')
  const parsed = withdrawEditRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, Errors.VALIDATION_ERROR.status, zodErrorsToDetails(parsed.error.flatten()))
    return
  }

  const { expectedVersion } = parsed.data
  const now = Date.now()

  const editReq = await queryOne(
    `SELECT id, status, version FROM contribution_edit_requests WHERE id = ? AND requesterId = ?`,
    [id, req.user!.userId],
  )
  if (!editReq) {
    sendError(res, Errors.EDIT_REQUEST_NOT_FOUND.code, '修改申请不存在', req.requestId, Errors.EDIT_REQUEST_NOT_FOUND.status)
    return
  }
  if (editReq.status !== 'pending') {
    sendError(res, Errors.INVALID_STATE_TRANSITION.code, '当前状态不可撤回', req.requestId, Errors.INVALID_STATE_TRANSITION.status)
    return
  }
  if (editReq.version !== expectedVersion) {
    sendError(res, Errors.VERSION_CONFLICT.code, '版本冲突', req.requestId, Errors.VERSION_CONFLICT.status)
    return
  }

  const result = await exec(
    `UPDATE contribution_edit_requests SET status = 'withdrawn', version = version + 1, updatedAt = ?
     WHERE id = ? AND version = ? AND requesterId = ?`,
    [now, id, expectedVersion, req.user!.userId],
  )
  if (result.affectedRows === 0) {
    sendError(res, Errors.VERSION_CONFLICT.code, '撤回失败', req.requestId, Errors.VERSION_CONFLICT.status)
    return
  }

  // Audit log per api.md §15.13
  writeAuditLog(req, {
    actorUserId: req.user!.userId,
    action: 'contribution.edit_request.withdraw',
    resourceType: 'edit_request',
    resourceId: id,
    after: { status: 'withdrawn' },
  }).catch((e: unknown) => console.error('audit error:', e))

  sendSuccess(res, {
    id,
    status: 'withdrawn',
    version: (editReq.version as number) + 1,
    updatedAt: now,
  }, req.requestId)
})

// ─── 10.3 GET /v1/me/edit-requests — 查看我的修改申请列表 ──

router.get('/me/edit-requests', requireAuth, async (req, res) => {
  const status = req.query.status as string | undefined
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100)
  const cursor = req.query.cursor as string | undefined

  let whereClause = 'WHERE er.requesterId = ?'
  const params: unknown[] = [req.user!.userId]

  if (status) {
    whereClause += ' AND er.status = ?'
    params.push(status)
  }
  if (cursor) {
    whereClause += ' AND er.createdAt < ?'
    params.push(parseInt(Buffer.from(cursor, 'base64url').toString('utf-8'), 10))
  }

  params.push(limit + 1)

  const rows = await query(
    `SELECT er.id, er.contributionId, c.title as contributionTitle, er.reason, er.status, er.createdAt, er.updatedAt,
            (SELECT COUNT(*) FROM edit_request_votes WHERE editRequestId = er.id AND vote = 'approve') as approveVotes,
            (SELECT COUNT(*) FROM edit_request_votes WHERE editRequestId = er.id AND vote = 'reject') as rejectVotes
     FROM contribution_edit_requests er
     JOIN contributions c ON c.id = er.contributionId
     ${whereClause}
     ORDER BY er.createdAt DESC
     LIMIT ?`,
    params,
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  const data = (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id,
    contributionId: r.contributionId,
    contributionTitle: r.contributionTitle,
    reason: r.reason,
    status: r.status,
    votes: {
      approve: (r.approveVotes as number) || 0,
      reject: (r.rejectVotes as number) || 0,
      total: ((r.approveVotes as number) || 0) + ((r.rejectVotes as number) || 0),
      required: REQUIRED_VOTES,
    },
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))

  const nextCursor = hasMore && rows.length > 0
    ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).createdAt)).toString('base64url')
    : null

  sendSuccess(res, data, req.requestId, 200, { nextCursor, hasMore, limit })
})

// ─── 10.4 GET /v1/admin/edit-requests — 审核员查看修改申请列表 ──

router.get('/admin/edit-requests', requireAuth, requireReviewer, requirePerm('contribution:edit-request:vote'), async (req, res) => {
  const status = req.query.status as string | undefined
  const contributionId = req.query.contributionId as string | undefined
  const requesterId = req.query.requesterId as string | undefined
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100)
  const cursor = req.query.cursor as string | undefined

  let whereClause = 'WHERE 1=1'
  const params: unknown[] = []

  if (status) { whereClause += ' AND er.status = ?'; params.push(status) }
  if (contributionId) { whereClause += ' AND er.contributionId = ?'; params.push(contributionId) }
  if (requesterId) { whereClause += ' AND er.requesterId = ?'; params.push(requesterId) }
  if (cursor) {
    whereClause += ' AND er.createdAt < ?'
    params.push(parseInt(Buffer.from(cursor, 'base64url').toString('utf-8'), 10))
  }

  params.push(limit + 1)

  const rows = await query(
    `SELECT er.id, er.contributionId, c.title as contributionTitle, er.requesterId, u.displayName as requesterDisplayName,
            er.reason, er.status, er.createdAt,
            (SELECT COUNT(*) FROM edit_request_votes WHERE editRequestId = er.id AND vote = 'approve') as approveVotes,
            (SELECT COUNT(*) FROM edit_request_votes WHERE editRequestId = er.id AND vote = 'reject') as rejectVotes
     FROM contribution_edit_requests er
     JOIN contributions c ON c.id = er.contributionId
     JOIN users u ON u.id = er.requesterId
     ${whereClause}
     ORDER BY er.createdAt DESC
     LIMIT ?`,
    params,
  )

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  const data = (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id,
    contributionId: r.contributionId,
    contributionTitle: r.contributionTitle,
    requester: {
      id: r.requesterId,
      displayName: r.requesterDisplayName,
    },
    reason: r.reason,
    status: r.status,
    votes: {
      approve: (r.approveVotes as number) || 0,
      reject: (r.rejectVotes as number) || 0,
      total: ((r.approveVotes as number) || 0) + ((r.rejectVotes as number) || 0),
      required: REQUIRED_VOTES,
    },
    createdAt: r.createdAt,
  }))

  const nextCursor = hasMore && rows.length > 0
    ? Buffer.from(String((rows[rows.length - 1] as Record<string, unknown>).createdAt)).toString('base64url')
    : null

  sendSuccess(res, data, req.requestId, 200, { nextCursor, hasMore, limit })
})

// ─── 10.5 GET /v1/admin/edit-requests/{id} — 审核员查看详情 ──

router.get('/admin/edit-requests/:id', requireAuth, requireReviewer, requirePerm('contribution:edit-request:vote'), async (req, res) => {
  const id = paramStr(req, 'id')

  const row = await queryOne(
    `SELECT er.*, c.title as origTitle, c.summary as origSummary, c.contentRaw as origContent,
            c.contentFormat as origContentFormat, c.tags as origTags,
            u.displayName as requesterDisplayName
     FROM contribution_edit_requests er
     JOIN contributions c ON c.id = er.contributionId
     JOIN users u ON u.id = er.requesterId
     WHERE er.id = ?`,
    [id],
  )

  if (!row) {
    sendError(res, Errors.EDIT_REQUEST_NOT_FOUND.code, '修改申请不存在', req.requestId, Errors.EDIT_REQUEST_NOT_FOUND.status)
    return
  }

  // Get votes and history
  const votes = await query(
    `SELECT reviewerUserId, vote, note, createdAt FROM edit_request_votes WHERE editRequestId = ? ORDER BY createdAt ASC`,
    [id],
  ) as Array<Record<string, unknown>>

  const approveVotes = votes.filter((v) => v.vote === 'approve').length
  const rejectVotes = votes.filter((v) => v.vote === 'reject').length

  // Check if current admin has voted
  const myVote = votes.find((v) => v.reviewerUserId === req.user!.userId)

  sendSuccess(res, {
    id: row.id,
    contribution: {
      id: row.contributionId,
      title: row.origTitle,
      summary: row.origSummary || null,
      contentRaw: row.origContent,
      contentFormat: row.origContentFormat,
      tags: typeof row.origTags === 'string' ? JSON.parse(row.origTags as string) : row.origTags || [],
    },
    requester: {
      id: row.requesterId,
      displayName: row.requesterDisplayName,
    },
    reason: row.reason,
    proposed: {
      title: row.proposedTitle || null,
      summary: row.proposedSummary || null,
      content: row.proposedContent || null,
      contentFormat: row.proposedContentFormat || null,
      tags: row.proposedTags ? (typeof row.proposedTags === 'string' ? JSON.parse(row.proposedTags as string) : row.proposedTags) : null,
    },
    status: row.status,
    votes: {
      approve: approveVotes,
      reject: rejectVotes,
      total: approveVotes + rejectVotes,
      required: REQUIRED_VOTES,
      history: votes.map((v) => ({
        reviewerId: v.reviewerUserId,
        vote: v.vote,
        note: v.note || null,
        createdAt: v.createdAt,
      })),
    },
    myVote: myVote?.vote || null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }, req.requestId)
})

// ─── 10.6 POST /v1/admin/edit-requests/{id}/vote — 审核员投票 ──

router.post('/admin/edit-requests/:id/vote', requireAuth, requireReviewer, requirePerm('contribution:edit-request:vote'), async (req, res) => {
  const id = paramStr(req, 'id')
  const parsed = voteSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, Errors.VALIDATION_ERROR.code, '请求数据校验失败', req.requestId, Errors.VALIDATION_ERROR.status, zodErrorsToDetails(parsed.error.flatten()))
    return
  }

  const { vote, note, expectedVersion } = parsed.data
  const now = Date.now()

  // Use transaction + SELECT FOR UPDATE for concurrency safety per api.md §10.6
  const { getConnection } = await import('../Database')
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    const [editReqRows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT id, contributionId, requesterId, status, version FROM contribution_edit_requests WHERE id = ? FOR UPDATE`,
      [id],
    )

    const editReq = (editReqRows as unknown as Array<{ id: string; contributionId: string; requesterId: string; status: string; version: number }>)[0] ?? null

    if (!editReq) {
      await conn.rollback()
      sendError(res, Errors.EDIT_REQUEST_NOT_FOUND.code, '修改申请不存在', req.requestId, Errors.EDIT_REQUEST_NOT_FOUND.status)
      conn.release()
      return
    }
    if (editReq.status !== 'pending' && editReq.status !== 'in_review') {
      await conn.rollback()
      sendError(res, Errors.INVALID_STATE_TRANSITION.code, '申请已结束', req.requestId, Errors.INVALID_STATE_TRANSITION.status)
      conn.release()
      return
    }
    if (editReq.requesterId === req.user!.userId) {
      await conn.rollback()
      sendError(res, 'SELF_VOTE_FORBIDDEN', '不可对自己的申请投票', req.requestId, 409)
      conn.release()
      return
    }
    if (editReq.version !== expectedVersion) {
      await conn.rollback()
      sendError(res, Errors.VERSION_CONFLICT.code, '版本冲突', req.requestId, Errors.VERSION_CONFLICT.status)
      conn.release()
      return
    }

    // Check for duplicate vote
    const [existingVoteRows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM edit_request_votes WHERE editRequestId = ? AND reviewerUserId = ? FOR UPDATE`,
      [id, req.user!.userId],
    )
    const existingVote = (existingVoteRows as Array<{ id: string }>)[0] ?? null
    if (existingVote) {
      await conn.rollback()
      sendError(res, 'ALREADY_VOTED', '已投过票', req.requestId, 409)
      conn.release()
      return
    }

    // Cast vote
    await conn.execute<mysql.ResultSetHeader>(
      `INSERT INTO edit_request_votes (id, editRequestId, reviewerUserId, vote, note, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [genId('erv_'), id, req.user!.userId, vote, note || null, now],
    )

    // Optimistic version bump — only succeeds if version hasn't changed since our FOR UPDATE
    const [versionResult] = await conn.execute<mysql.ResultSetHeader>(
      `UPDATE contribution_edit_requests SET version = version + 1, updatedAt = ? WHERE id = ? AND version = ?`,
      [now, id, editReq.version],
    )
    if (versionResult.affectedRows === 0) {
      await conn.rollback()
      sendError(res, Errors.VERSION_CONFLICT.code, '版本冲突，请刷新后重试', req.requestId, Errors.VERSION_CONFLICT.status)
      conn.release()
      return
    }

    const newVersion = editReq.version + 1

    // Check resolution: 2 approve or 2 reject
    const [approveRows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) as cnt FROM edit_request_votes WHERE editRequestId = ? AND vote = 'approve'`,
      [id],
    )
    const [rejectRows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) as cnt FROM edit_request_votes WHERE editRequestId = ? AND vote = 'reject'`,
      [id],
    )

    const approve = Number(approveRows[0]?.cnt ?? 0)
    const reject = Number(rejectRows[0]?.cnt ?? 0)

    let resolvedStatus: string | null = null

    if (approve >= 2) {
      resolvedStatus = 'approved'

      // Apply the edit to the original contribution
      const [editRows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT contributionId, proposedTitle, proposedContent, proposedContentFormat, proposedSummary, proposedTags FROM contribution_edit_requests WHERE id = ? FOR UPDATE`,
        [id],
      )
      const editRow = (editRows as Array<{ contributionId: string; proposedTitle: string | null; proposedContent: string | null; proposedContentFormat: string | null; proposedSummary: string | null; proposedTags: string | null }>)[0] ?? null
      if (editRow) {
        const updates: string[] = ['version = version + 1', 'updatedAt = ?']
        const updateParams: unknown[] = [now]

        if (editRow.proposedTitle) { updates.push('title = ?'); updateParams.push(editRow.proposedTitle) }
        if (editRow.proposedContent) {
          updates.push('contentRaw = ?')
          updateParams.push(editRow.proposedContent)
          const contentFormat = (editRow.proposedContentFormat as string) || 'markdown'
          const contentHtml = contentFormat === 'plain_text'
            ? plainTextToHtml(editRow.proposedContent as string)
            : markdownToHtml(editRow.proposedContent as string)
          updates.push('contentHtml = ?')
          updateParams.push(contentHtml)
          updates.push('contentFormat = ?')
          updateParams.push(contentFormat)
        }
        if (editRow.proposedSummary !== null) { updates.push('summary = ?'); updateParams.push(editRow.proposedSummary) }
        if (editRow.proposedTags) { updates.push('tags = ?'); updateParams.push(JSON.stringify(editRow.proposedTags)) }

        updateParams.push(editRow.contributionId)

        await conn.execute<mysql.ResultSetHeader>(
          `UPDATE contributions SET ${updates.join(', ')} WHERE id = ?`,
          updateParams as mysql.ExecuteValues,
        )
      }
    } else if (reject >= 2) {
      resolvedStatus = 'rejected'
    }

    // Update edit request status if resolved
    if (resolvedStatus) {
      await conn.execute<mysql.ResultSetHeader>(
        `UPDATE contribution_edit_requests SET status = ?, updatedAt = ? WHERE id = ?`,
        [resolvedStatus, now, id],
      )

      await conn.execute<mysql.ResultSetHeader>(
        `INSERT INTO contribution_review_events (id, contributionId, reviewerUserId, action, fromStatus, toStatus, createdAt, requestId)
         VALUES (?, ?, ?, 'edit_request_resolve', ?, ?, ?, ?)`,
        [genId('rev_'), editReq.contributionId, req.user!.userId, editReq.status, resolvedStatus, now, req.requestId],
      )
    }

    await conn.commit()
    conn.release()

    // Audit logs (outside transaction — fire-and-forget safe after commit)
    await writeAuditLog(req, {
      actorUserId: req.user!.userId,
      action: 'contribution.edit_request.vote',
      resourceType: 'edit_request',
      resourceId: id,
      after: { vote, status: resolvedStatus || editReq.status },
    })

    if (resolvedStatus) {
      await writeAuditLog(req, {
        actorUserId: req.user!.userId,
        action: 'contribution.edit_request.resolve',
        resourceType: 'edit_request',
        resourceId: id,
        after: { resolution: resolvedStatus },
      })
    }

    sendSuccess(res, {
      id,
      status: resolvedStatus || editReq.status,
      version: newVersion,
      votes: {
        approve,
        reject,
        total: approve + reject,
        required: REQUIRED_VOTES,
      },
    }, req.requestId)
  } catch (err) {
    try { await conn.rollback() } catch { /* ignore rollback error */ }
    conn.release()
    throw err
  }
})

export default router
