// PATCH /api/admin/review — approve, reject, or request changes for a submission

import { ensureSchema } from '../_db'
import { triggerRebuild } from '../_build'
import { getSession } from '../_session'

interface ReviewBody {
  id: string
  action: 'approve' | 'reject' | 'request_changes'
  notes?: string
}

interface Env {
  DB: D1Database
  SESSION_SECRET: string
  STORY_REPO_TOKEN?: string
  STORY_REPO_OWNER?: string
  STORY_REPO_NAME?: string
}

export const onRequestPatch: PagesFunction<Env> = async ({ request, env }) => {
  await ensureSchema(env.DB)

  const session = await getSession(request, env.SESSION_SECRET)
  const reviewer = session?.username || 'unknown'

  let body: ReviewBody
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: '请求格式无效' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!body.id) {
    return new Response(JSON.stringify({ error: '缺少投稿ID' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!['approve', 'reject', 'request_changes'].includes(body.action)) {
    return new Response(JSON.stringify({ error: '无效操作' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const statusMap = {
    approve: 'approved',
    reject: 'rejected',
    request_changes: 'pending', // stays pending but with notes
  }

  const now = new Date().toISOString()

  try {
    const result = await env.DB.prepare(
      `UPDATE submissions
       SET status = ?, reviewer_gh = ?, review_notes = ?, reviewed_at = ?
       WHERE id = ?`,
    ).bind(statusMap[body.action], reviewer,
      body.notes || null, now, body.id).run()

    if (result.meta.changes === 0) {
      return new Response(JSON.stringify({ error: '投稿不存在或状态未变更' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Trigger rebuild of story.transcircle.org if approved
    if (body.action === 'approve') {
      env.ctx?.waitUntil(triggerRebuild(env))
    }

    return new Response(JSON.stringify({
      id: body.id,
      status: statusMap[body.action],
      reviewed_at: now,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Review failed:', err)
    return new Response(JSON.stringify({ error: '服务器错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
