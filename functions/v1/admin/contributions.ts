// GET /v1/admin/contributions — list contributions with cursor pagination
// Per apidocs.md §6.1

import { ensureSchema } from '../_db'
import { errorResponse } from '../_response'

interface Env {
  DB: D1Database
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  await ensureSchema(env.DB)
  const url = new URL(request.url)
  const status = url.searchParams.get('status') || 'pending'
  const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100)
  const cursor = url.searchParams.get('cursor') || ''

  const validStatuses = ['draft', 'pending', 'in_review', 'approved', 'rejected', 'published', 'hidden', 'withdrawn']
  if (!validStatuses.includes(status)) {
    return errorResponse('VALIDATION_ERROR', '无效状态', 400, [{
      field: 'status', reason: `必须是 ${validStatuses.join('/')} 之一`,
    }])
  }

  try {
    let rows: Record<string, unknown>[]
    if (cursor) {
      const decoded = atob(cursor)
      const [cursorCreated, cursorId] = decoded.split('|')
      rows = await env.DB.prepare(
        `SELECT id, title, summary, content_raw, content_format, category,
                author_name, author_type, contact, submitter_gh, submitter_x,
                status, version, language, tags, reviewer_gh, review_notes,
                created_at, updated_at, reviewed_at
         FROM contributions
         WHERE status = ? AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      ).bind(status, cursorCreated, cursorCreated, cursorId, limit + 1).all().then(r => r.results)
    } else {
      rows = await env.DB.prepare(
        `SELECT id, title, summary, content_raw, content_format, category,
                author_name, author_type, contact, submitter_gh, submitter_x,
                status, version, language, tags, reviewer_gh, review_notes,
                created_at, updated_at, reviewed_at
         FROM contributions
         WHERE status = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      ).bind(status, limit + 1).all().then(r => r.results)
    }

    const hasMore = rows.length > limit
    if (hasMore) rows = rows.slice(0, limit)

    let nextCursor: string | null = null
    if (hasMore && rows.length > 0) {
      const last = rows[rows.length - 1]
      nextCursor = btoa(`${last.created_at}|${last.id}`)
    }

    // Map to contract format
    const items = rows.map(r => ({
      id: r.id,
      title: r.title,
      summary: r.summary || null,
      status: r.status,
      author: {
        id: r.author_user_id || null,
        displayName: r.author_name || (r.submitter_gh || r.submitter_x || '匿名'),
        avatarUrl: null,
      },
      category: r.category || null,
      authorType: r.author_type || 'anonymous',
      authorName: r.author_name || null,
      submitterGh: r.submitter_gh || null,
      submitterX: r.submitter_x || null,
      tags: tryParseJson(r.tags),
      language: r.language || 'zh-CN',
      version: r.version || 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      reviewedAt: r.reviewed_at || null,
      reviewerGh: r.reviewer_gh || null,
      reviewNotes: r.review_notes || null,
    }))

    return new Response(JSON.stringify({
      data: items,
      pagination: { limit, nextCursor, hasMore },
      requestId: `req_${crypto.randomUUID()}`,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('List contributions failed:', err)
    return errorResponse('INTERNAL_ERROR', '服务器错误', 500)
  }
}

function tryParseJson(v: unknown): string[] {
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch { return [] }
  }
  return []
}
