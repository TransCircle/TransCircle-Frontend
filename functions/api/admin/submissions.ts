// GET /api/admin/submissions — list submissions with optional status filter

import { ensureSchema } from '../_db'

interface Env {
  DB: D1Database
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  await ensureSchema(env.DB)
  const url = new URL(request.url)
  const status = url.searchParams.get('status') || 'pending'
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100)
  const offset = Number(url.searchParams.get('offset')) || 0

  const validStatuses = ['pending', 'approved', 'rejected']
  if (!validStatuses.includes(status)) {
    return new Response(JSON.stringify({ error: '无效状态' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Exclude sensitive fields (contact) from list view unless explicitly requested
  const showContact = url.searchParams.get('showContact') === '1'

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, title, category, author_type, author_name,
              ${showContact ? 'contact,' : ''}
              status, reviewer_gh, review_notes, created_at, reviewed_at
       FROM submissions
       WHERE status = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    ).bind(status, limit, offset).all()

    const total = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM submissions WHERE status = ?',
    ).bind(status).first<{ count: number }>()

    return new Response(JSON.stringify({
      submissions: results,
      total: total?.count ?? 0,
      limit,
      offset,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('List submissions failed:', err)
    return new Response(JSON.stringify({ error: '服务器错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
