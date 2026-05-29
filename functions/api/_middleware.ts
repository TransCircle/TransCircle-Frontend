// CORS + rate limiting middleware for /api/* routes
// NOTE: The rate limiter uses in-memory storage and is not shared across Workers
// instances. For production, consider using Cloudflare Rate Limiting rules or
// a Durable Object / KV-based counter for distributed enforcement.

const RATE_LIMIT_WINDOW = 60 * 60 * 1000 // 1 hour
const RATE_LIMIT_MAX = 10 // max submissions per IP per hour

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimitStore = new Map<string, RateLimitEntry>()

const ALLOWED_ORIGINS = [
  'https://submit.transcircle.org',
  'http://localhost:5173',
  'http://localhost:8788',
]

function getClientIP(request: Request): string {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown'
}

function addCORSHeaders(request: Request, response: Response): Response {
  const origin = request.headers.get('Origin') || ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', allowed)
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  headers.set('Access-Control-Max-Age', '86400')
  return new Response(response.body, { ...response, headers })
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitStore.get(ip)

  // Lazy cleanup: handle stale entries on access
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
    return true
  }

  if (entry.count >= RATE_LIMIT_MAX) return false

  entry.count++
  return true
}

export const onRequest: PagesFunction = async ({ request, next }) => {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('Origin') || ''
    const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowed,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  // Rate limit POST/PATCH requests
  if (request.method === 'POST' || request.method === 'PATCH') {
    const ip = getClientIP(request)
    if (!checkRateLimit(ip)) {
      return addCORSHeaders(request, new Response(
        JSON.stringify({ error: '提交过于频繁，请稍后再试' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      ))
    }
  }

  const response = await next()
  return addCORSHeaders(request, response)
}
