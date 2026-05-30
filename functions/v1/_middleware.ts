// CORS + D1-backed rate limiting middleware for /v1/* routes
// Rate limits are shared across all Workers isolates via D1.

import { errorResponse } from './_response'

const RATE_LIMIT_WINDOW = 60 * 60 * 1000 // 1 hour
const RATE_LIMIT_MAX = 10 // max submissions per IP per hour

const PRODUCTION_ORIGINS = [
  'https://submit.transcircle.org',
]

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:8788',
]

function getAllowedOrigins(request: Request): string[] {
  const host = request.headers.get('Host') || ''
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1')
  return isLocal ? [...PRODUCTION_ORIGINS, ...DEV_ORIGINS] : PRODUCTION_ORIGINS
}

function getClientIP(request: Request): string {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown'
}

async function hashIP(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
}

function addCORSHeaders(request: Request, response: Response): Response {
  const origins = getAllowedOrigins(request)
  const origin = request.headers.get('Origin') || ''
  const allowed = origins.includes(origin) ? origin : origins[0]
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', allowed)
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  headers.set('Access-Control-Max-Age', '86400')
  headers.set('Vary', 'Origin')
  return new Response(response.body, { ...response, headers })
}

async function checkRateLimit(db: D1Database, ip: string): Promise<boolean> {
  const now = Date.now()
  const ipHash = await hashIP(ip)

  // Try to insert a new entry. If it already exists and is within the window, increment.
  await db.prepare(
    `INSERT INTO rate_limits (ip_hash, count, reset_at)
     VALUES (?, 1, ?)
     ON CONFLICT (ip_hash) DO UPDATE SET
       count = CASE WHEN reset_at > ? THEN count + 1 ELSE 1 END,
       reset_at = CASE WHEN reset_at > ? THEN reset_at ELSE ? END`,
  ).bind(ipHash, now + RATE_LIMIT_WINDOW, now, now, now + RATE_LIMIT_WINDOW).run()

  // Read back the current count
  const row = await db.prepare(
    `SELECT count, reset_at FROM rate_limits WHERE ip_hash = ?`,
  ).bind(ipHash).first<{ count: number; reset_at: number }>()

  if (!row) return true
  if (now > row.reset_at) return true
  return row.count <= RATE_LIMIT_MAX
}

export const onRequest: PagesFunction<{ DB: D1Database }> = async ({ request, env, next }) => {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    const origins = getAllowedOrigins(request)
    const origin = request.headers.get('Origin') || ''
    const allowed = origins.includes(origin) ? origin : origins[0]
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowed,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
      },
    })
  }

  // Rate limit POST/PATCH requests via D1 (shared across isolates)
  if (request.method === 'POST' || request.method === 'PATCH') {
    const ip = getClientIP(request)
    if (!(await checkRateLimit(env.DB, ip))) {
      const resp = errorResponse('RATE_LIMITED', '提交过于频繁，请稍后再试', 429)
      return addCORSHeaders(request, resp)
    }
  }

  const response = await next()
  return addCORSHeaders(request, response)
}
