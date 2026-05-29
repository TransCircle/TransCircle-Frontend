// POST /api/submit — create a new submission

import { ensureSchema } from './_db'

interface SubmissionBody {
  title: string
  content: string
  category: string
  authorType: 'real' | 'pen_name' | 'anonymous'
  authorName?: string
  contact?: string
  // honeypot
  website?: string
}

const VALID_CATEGORIES = ['个人经历', '观点评论', '资源指南']
const MAX_TITLE_LEN = 200
const MAX_CONTENT_LEN = 50000
const MAX_AUTHOR_NAME_LEN = 50
const MAX_CONTACT_LEN = 200

function generateId(): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = crypto.randomUUID().slice(0, 4).toUpperCase()
  return `TC-${ts}-${rand}`
}

function validate(body: SubmissionBody): string | null {
  if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
    return '标题不能为空'
  }
  if (body.title.length > MAX_TITLE_LEN) {
    return `标题不能超过${MAX_TITLE_LEN}字`
  }
  if (!body.content || typeof body.content !== 'string' || !body.content.trim()) {
    return '正文不能为空'
  }
  if (body.content.length > MAX_CONTENT_LEN) {
    return `正文不能超过${MAX_CONTENT_LEN}字`
  }
  if (!body.category || !VALID_CATEGORIES.includes(body.category)) {
    return '请选择有效分类'
  }
  if (!['real', 'pen_name', 'anonymous'].includes(body.authorType)) {
    return '署名方式无效'
  }
  if ((body.authorType === 'real' || body.authorType === 'pen_name') && !body.authorName?.trim()) {
    return '请输入署名名称'
  }
  if (body.authorName && body.authorName.length > MAX_AUTHOR_NAME_LEN) {
    return `署名不能超过${MAX_AUTHOR_NAME_LEN}字`
  }
  if (body.contact && body.contact.length > MAX_CONTACT_LEN) {
    return `联系方式不能超过${MAX_CONTACT_LEN}字`
  }
  return null
}

export const onRequestPost: PagesFunction<{ DB: D1Database }> = async ({ request, env }) => {
  let body: SubmissionBody
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: '请求格式无效' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Honeypot check
  if (body.website && body.website.length > 0) {
    // Silently accept but don't store — bot detection
    return new Response(JSON.stringify({ id: generateId(), status: 'pending' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const validationError = validate(body)
  if (validationError) {
    return new Response(JSON.stringify({ error: validationError }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const id = generateId()
  const now = new Date().toISOString()

  try {
    await ensureSchema(env.DB)
    await env.DB.prepare(
      `INSERT INTO submissions
       (id, title, content, category, author_type, author_name, contact, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
      .bind(id, body.title.trim(), body.content, body.category,
        body.authorType, body.authorName?.trim() || null,
        body.contact?.trim() || null, now)
      .run()
  } catch (err) {
    console.error('DB insert failed:', err)
    return new Response(JSON.stringify({ error: '服务器错误，请稍后重试' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ id, status: 'pending' }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  })
}
