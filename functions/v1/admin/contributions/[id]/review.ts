// POST /v1/admin/contributions/:id/review — approve or reject a contribution
// Per apidocs.md §6.3

import { ensureSchema } from '../../../_db'
import { triggerRebuild } from '../../../_build'
import { getSession } from '../../../_session'
import { successResponse, errorResponse } from '../../../_response'
import { ulidWithPrefix, requestId } from '../../../_ulid'

interface ReviewBody {
  decision: 'approved' | 'rejected'
  publicNote?: string
  internalNote?: string
  expectedVersion: number
}

interface Env {
  DB: D1Database
  SESSION_SECRET: string
  STORY_REPO_TOKEN?: string
  STORY_REPO_OWNER?: string
  STORY_REPO_NAME?: string
}

export const onRequestPost: PagesFunction<Env, 'id'> = async ({ request, env, params, waitUntil }) => {
  await ensureSchema(env.DB)

  const session = await getSession(request, env.SESSION_SECRET)
  const reviewerUserId = session?.userId || 'unknown'
  const reviewerGh = session?.username || 'unknown'

  const id = params.id
  if (!id) {
    return errorResponse('BAD_REQUEST', '缺少投稿ID', 400)
  }

  let body: ReviewBody
  try {
    body = await request.json()
  } catch {
    return errorResponse('BAD_REQUEST', '请求格式错误', 400)
  }

  if (!['approved', 'rejected'].includes(body.decision)) {
    return errorResponse('VALIDATION_ERROR', '无效的审核决定', 400, [{
      field: 'decision', reason: '必须是 approved 或 rejected',
    }])
  }

  if (typeof body.expectedVersion !== 'number' || body.expectedVersion < 1) {
    return errorResponse('VALIDATION_ERROR', '缺少 expectedVersion', 400, [{
      field: 'expectedVersion', reason: '必须是正整数',
    }])
  }

  const now = Date.now()

  try {
    // Optimistic lock: check version matches
    const current = await env.DB.prepare(
      'SELECT status, version FROM contributions WHERE id = ?',
    ).bind(id).first<{ status: string; version: number }>()

    if (!current) {
      return errorResponse('CONTRIBUTION_NOT_FOUND', '投稿不存在', 404)
    }

    if (current.version !== body.expectedVersion) {
      return errorResponse('VERSION_CONFLICT', '投稿状态已被其他审核员修改，请刷新后重试', 409)
    }

    // Validate state transition
    const validStatuses = ['pending', 'in_review']
    if (!validStatuses.includes(current.status)) {
      return errorResponse('INVALID_STATE_TRANSITION', '当前状态不可审核', 409)
    }

    const newStatus = body.decision === 'approved' ? 'approved' : 'rejected'
    const newVersion = current.version + 1

    const result = await env.DB.prepare(
      `UPDATE contributions
       SET status = ?, version = ?, reviewer_gh = ?, review_notes = ?,
           reviewed_at = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
    ).bind(newStatus, newVersion, reviewerGh,
      body.internalNote || body.publicNote || null,
      now, now, id, body.expectedVersion).run()

    if (result.meta.changes === 0) {
      return errorResponse('VERSION_CONFLICT', '投稿状态已被其他审核员修改，请刷新后重试', 409)
    }

    // Write review event (§15.12)
    const reqId = requestId()
    await env.DB.prepare(
      `INSERT INTO contribution_review_events
       (id, contribution_id, reviewer_user_id, action, from_status, to_status, public_note, internal_note, created_at, request_id)
       VALUES (?, ?, ?, 'review', ?, ?, ?, ?, ?, ?)`,
    ).bind(ulidWithPrefix('rev_evt_'), id, reviewerUserId,
      current.status, newStatus,
      body.publicNote || null, body.internalNote || null,
      now, reqId).run()

    // Trigger rebuild if approved
    if (body.decision === 'approved') {
      waitUntil(triggerRebuild(env))
    }

    return successResponse({
      id,
      status: newStatus,
      version: newVersion,
      review: {
        reviewerUserId,
        reviewedAt: now,
        decision: body.decision,
        publicNote: body.publicNote || null,
        internalNote: body.internalNote || null,
      },
    })
  } catch (err) {
    console.error('Review failed:', err)
    return errorResponse('INTERNAL_ERROR', '服务器错误', 500)
  }
}
