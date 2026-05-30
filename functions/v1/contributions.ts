// POST /v1/contributions — create a new contribution
// Per apidocs.md §3

import { ensureSchema } from './_db'
import { getSession } from './_session'
import { successResponse, errorResponse } from './_response'
import { ulidWithPrefix } from './_ulid'

interface ContributionBody {
  title: string
  content: string
  contentFormat?: 'markdown' | 'plain_text'
  summary?: string
  tags?: string[]
  language?: string
  submitMode?: 'draft' | 'submit'
  // Legacy fields (still accepted for form compatibility)
  category?: string
  authorType?: 'real' | 'pen_name' | 'anonymous'
  authorName?: string
  contact?: string
  website?: string // honeypot
}

interface Env {
  DB: D1Database
  SESSION_SECRET: string
}

const MAX_TITLE_LEN = 120
const MAX_CONTENT_LEN = 50000
const MAX_SUMMARY_LEN = 300
const MAX_AUTHOR_NAME_LEN = 50
const MAX_CONTACT_LEN = 200
const MAX_TAGS = 8

function generateId(): string {
  return ulidWithPrefix('contrib_')
}

function validate(body: ContributionBody): { field: string; reason: string } | null {
  if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
    return { field: 'title', reason: '标题不能为空' }
  }
  if ([...body.title].length > MAX_TITLE_LEN) {
    return { field: 'title', reason: `标题长度必须在 1 到 ${MAX_TITLE_LEN} 个字符之间` }
  }
  if (!body.content || typeof body.content !== 'string' || !body.content.trim()) {
    return { field: 'content', reason: '正文不能为空' }
  }
  if ([...body.content].length > MAX_CONTENT_LEN) {
    return { field: 'content', reason: `正文不能超过${MAX_CONTENT_LEN}字` }
  }
  if (body.contentFormat && !['markdown', 'plain_text'].includes(body.contentFormat)) {
    return { field: 'contentFormat', reason: '必须是 markdown 或 plain_text' }
  }
  if (body.summary && [...body.summary].length > MAX_SUMMARY_LEN) {
    return { field: 'summary', reason: `摘要不能超过${MAX_SUMMARY_LEN}字` }
  }
  if (body.tags && body.tags.length > MAX_TAGS) {
    return { field: 'tags', reason: `标签最多${MAX_TAGS}个` }
  }
  if (body.authorName && [...body.authorName].length > MAX_AUTHOR_NAME_LEN) {
    return { field: 'authorName', reason: `署名不能超过${MAX_AUTHOR_NAME_LEN}字` }
  }
  if (body.contact && [...body.contact].length > MAX_CONTACT_LEN) {
    return { field: 'contact', reason: `联系方式不能超过${MAX_CONTACT_LEN}字` }
  }
  return null
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: ContributionBody
  try {
    body = await request.json()
  } catch {
    return errorResponse('BAD_REQUEST', '请求格式错误', 400)
  }

  // Honeypot check
  if (body.website && body.website.length > 0) {
    return successResponse({ id: generateId(), status: 'pending', createdAt: Date.now() }, 201)
  }

  const validationError = validate(body)
  if (validationError) {
    return errorResponse('VALIDATION_ERROR', '请求参数不合法', 422, [validationError])
  }

  const session = await getSession(request, env.SESSION_SECRET)
  const authorUserId = session?.userId || null
  const submitterGh = session?.provider === 'github' ? session.username : null
  const submitterX = session?.provider === 'x' ? session.username : null

  const id = generateId()
  const now = Date.now()
  const isDraft = body.submitMode === 'draft'
  const status = isDraft ? 'draft' : 'pending'

  // Map category to tags if not already provided
  const tags = body.tags && body.tags.length > 0
    ? JSON.stringify(body.tags)
    : (body.category ? JSON.stringify([body.category]) : '[]')

  try {
    await ensureSchema(env.DB)
    await env.DB.prepare(
      `INSERT INTO contributions
       (id, author_user_id, title, summary, content_raw, content_format,
        category, author_name, author_type, contact,
        submitter_gh, submitter_x, status, version, language, tags,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
      .bind(id, authorUserId,
        body.title.trim(), body.summary?.trim() || null,
        body.content, body.contentFormat || 'markdown',
        body.category || null, body.authorName?.trim() || null,
        body.authorType || 'anonymous', body.contact?.trim() || null,
        submitterGh, submitterX, status,
        body.language || 'zh-CN', tags,
        now, now)
      .run()
  } catch (err) {
    console.error('DB insert failed:', err)
    return errorResponse('INTERNAL_ERROR', '服务器错误，请稍后重试', 500)
  }

  return successResponse({ id, status, createdAt: now }, 201)
}
