import type { Request, Response, NextFunction } from 'express'
import { exec, queryOne } from '../Database'
import { ulid } from '../utils/ulid'
import { sendError, Errors } from '../utils/response'

/**
 * Idempotency-Key middleware for POST write endpoints (api.md §12 幂等性).
 *
 * Usage:
 *   router.post('/resource', idempotencyKey, handler)
 *
 * The middleware reads Idempotency-Key header, computes a request fingerprint (SHA-256 of body),
 * and on duplicate key + body returns the cached response.
 * Same key with different body returns 409 IDEMPOTENCY_KEY_MISMATCH.
 * Retention: 24 hours via idempotency_cache table.
 */
export async function idempotencyKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.headers['idempotency-key'] as string | undefined

  if (!key) {
    next()
    return
  }

  if (key.length < 16 || key.length > 64) {
    sendError(res, Errors.BAD_REQUEST.code, 'Idempotency-Key 格式无效', req.requestId, 400)
    return
  }
  // Per api.md §12: Idempotency-Key must be UUID v4 or ULID
  const isUuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
  const isUlid = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i.test(key)
  if (!isUuidV4 && !isUlid) {
    sendError(res, Errors.BAD_REQUEST.code, 'Idempotency-Key 须为 UUID v4 或 ULID 格式', req.requestId, 400)
    return
  }

  const userId = (req as Request & { user?: { userId: string } }).user?.userId || 'anonymous'
  const cacheKey = `idemp:${userId}:${key}`

  // Compute request fingerprint
  const bodyStr = JSON.stringify(req.body || {})
  const enc = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(bodyStr))
  const fingerprint = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const existing = await queryOne(
    `SELECT fingerprint, responseBody FROM idempotency_cache WHERE cacheKey = ? AND expiresAt > ?`,
    [cacheKey, Date.now()],
  )

  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      sendError(res, Errors.IDEMPOTENCY_KEY_MISMATCH.code, 'Idempotency-Key 与请求体不匹配', req.requestId, 409)
      return
    }
    if (existing.responseBody) {
      try {
        const parsed = existing.responseBody as { status?: number; body?: unknown }
        if (parsed.body) {
          res.status(parsed.status || 200).json(parsed.body)
          return
        }
      } catch { /* fall through */ }
    }
  }

  // Capture response to cache it
  const originalJson = res.json.bind(res)
  res.json = function (body: unknown) {
    const snapshot = { status: res.statusCode, body }
    exec(
      `INSERT INTO idempotency_cache (id, cacheKey, fingerprint, responseBody, expiresAt, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE responseBody = VALUES(responseBody)`,
      [ulid(), cacheKey, fingerprint, JSON.stringify(snapshot), Date.now() + 86_400_000, Date.now()],
    ).catch(() => { /* best-effort */ })
    return originalJson(body)
  }

  next()
}
