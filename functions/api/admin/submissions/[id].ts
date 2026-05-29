// GET /api/admin/submissions/:id — get single submission detail (includes contact)

import { ensureSchema } from '../../_db'

interface Env {
  DB: D1Database
}

export const onRequestGet: PagesFunction<Env, 'id'> = async ({ env, params }) => {
  await ensureSchema(env.DB)
  const id = params.id
  if (!id) {
    return new Response(JSON.stringify({ error: '缺少投稿ID' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const submission = await env.DB.prepare(
      'SELECT * FROM submissions WHERE id = ?',
    ).bind(id).first()

    if (!submission) {
      return new Response(JSON.stringify({ error: '投稿不存在' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify(submission), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Get submission failed:', err)
    return new Response(JSON.stringify({ error: '服务器错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
