// GET /v1/admin/contributions/:id — get single contribution detail
// Per apidocs.md §6.2

import { ensureSchema } from '../../_db'
import { successResponse, errorResponse } from '../../_response'

interface Env {
  DB: D1Database
}

export const onRequestGet: PagesFunction<Env, 'id'> = async ({ env, params }) => {
  await ensureSchema(env.DB)
  const id = params.id
  if (!id) {
    return errorResponse('BAD_REQUEST', '缺少投稿ID', 400)
  }

  try {
    const r = await env.DB.prepare(
      'SELECT * FROM contributions WHERE id = ?',
    ).bind(id).first<Record<string, unknown>>()

    if (!r) {
      return errorResponse('CONTRIBUTION_NOT_FOUND', '投稿不存在', 404)
    }

    return successResponse({
      id: r.id,
      title: r.title,
      summary: r.summary || null,
      contentRaw: r.content_raw,
      contentFormat: r.content_format || 'markdown',
      category: r.category || null,
      authorName: r.author_name || null,
      authorType: r.author_type || 'anonymous',
      contact: r.contact || null,
      submitterGh: r.submitter_gh || null,
      submitterX: r.submitter_x || null,
      status: r.status,
      version: r.version || 1,
      language: r.language || 'zh-CN',
      tags: typeof r.tags === 'string' ? JSON.parse(r.tags as string) : [],
      reviewerGh: r.reviewer_gh || null,
      reviewNotes: r.review_notes || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      reviewedAt: r.reviewed_at || null,
      author: {
        id: r.author_user_id || null,
        displayName: (r.author_name || r.submitter_gh || r.submitter_x || '匿名') as string,
        avatarUrl: null,
      },
    })
  } catch (err) {
    console.error('Get contribution failed:', err)
    return errorResponse('INTERNAL_ERROR', '服务器错误', 500)
  }
}
