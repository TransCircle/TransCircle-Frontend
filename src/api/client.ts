/**
 * Unified API client for TransCircle Frontend.
 *
 * 设计目标：
 * - 内存中管理 access token（不写 localStorage / sessionStorage，遵守 api.md JWT 存储建议）
 * - 401 时自动 refresh → retry（refresh token rotation 由后端保障）
 * - 统一的请求拦截（自动注入 Authorization / Content-Type / Idempotency-Key / X-CSRF-Token）
 * - 统一的错误解析
 * - 类型安全的辅助方法
 */

import { API_BASE as _API_BASE } from '@/config'

/** Re-export for use by pages that need direct fetch (e.g. DELETE with body) */
export const API_BASE = _API_BASE

// ─── Token Management ──────────────────────────────────────────

let _memoryToken: string | null = null
let _loginProvider: string | null = null // 'github' | 'x' | null

export function setAccessToken(token: string | null): void {
  _memoryToken = token
}

export function getAccessToken(): string | null {
  return _memoryToken
}

export function setLoginProvider(provider: string | null): void {
  _loginProvider = provider
}

export function getLoginProvider(): string | null {
  return _loginProvider
}

// ─── Refresh Token Rotation ────────────────────────────────────

let _refreshPromise: Promise<string | null> | null = null

/**
 * Attempt to refresh the access token via POST /v1/auth/refresh.
 * Uses a promise queue so concurrent callers share one in-flight request.
 */
async function doRefresh(): Promise<string | null> {
  if (_refreshPromise) return _refreshPromise

  _refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })

      if (res.status === 401) {
        // REFRESH_TOKEN_REVOKED or INVALID_REFRESH_TOKEN
        _memoryToken = null
        return null
      }

      if (!res.ok) return null

      const body = (await res.json()) as {
        data?: { accessToken?: string }
        requestId?: string
      }
      if (body.data?.accessToken) {
        _memoryToken = body.data.accessToken
        return _memoryToken
      }
      return null
    } catch {
      return null
    } finally {
      _refreshPromise = null
    }
  })()

  return _refreshPromise
}

// ─── CSRF Token Helper ─────────────────────────────────────────

/**
 * Read oauth_pending_csrf cookie for OAuth flows (api.md §1.6.2).
 * Falls back to sessionStorage for cross-page navigation resilience.
 */
export function getCsrfToken(): string {
  const match = document.cookie.match(/oauth_pending_csrf=([^;]+)/)
  if (match?.[1]) return match[1]
  return sessionStorage.getItem('oauth_pending_csrf') || ''
}

/** Persist CSRF token to sessionStorage so it survives page navigation */
export function saveCsrfToken(token: string): void {
  sessionStorage.setItem('oauth_pending_csrf', token)
}

/** Clean up CSRF token after use */
export function clearCsrfToken(): void {
  sessionStorage.removeItem('oauth_pending_csrf')
}

// ─── Idempotency-Key Helper ────────────────────────────────────

/**
 * Generate a UUID v4 Idempotency-Key per api.md §12.
 * UUID v4 matches the required format (16-64 chars, UUID v4 or ULID).
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Safari 15.3- fallback: UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

// ─── Per-Intent Idempotency-Key ──────────────────────────────

let _intentKey: string | null = null

/**
 * Set an idempotency-key for the current business intent.
 * The key persists until explicitly cleared, so retries (e.g. after 401 refresh
 * or network timeout) reuse the same key — matching api.md's requirement that
 * keys are generated "per business intent" and reused across retries.
 */
export function setIntentKey(key: string | null): void {
  _intentKey = key
}

export function clearIntentKey(): void {
  _intentKey = null
}

// ─── API Response Types ────────────────────────────────────────

export interface ApiSuccess<T = unknown> {
  data: T
  requestId: string
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: Array<{ field: string; reason: string }>
    data?: Record<string, unknown>
  }
  requestId: string
}

export interface RateLimitInfo {
  limit: number
  remaining: number
  reset: number
  retryAfter?: number
}

type ApiResultBase = {
  requestId: string
  status: number
  rateLimit?: RateLimitInfo
}

export type ApiResult<T = unknown> = ApiResultBase & ({
  ok: true
  data: T
  pagination?: {
    limit: number
    nextCursor: string | null
    hasMore: boolean
  }
} | {
  ok: false
  error: ApiErrorBody['error']
})

// ─── Request Options ───────────────────────────────────────────

export interface ApiRequestOptions {
  /** Skip auto-injecting Authorization header */
  noAuth?: boolean
  /** Custom headers to merge */
  headers?: Record<string, string>
  /** Include Idempotency-Key header (UUID v4) */
  idempotent?: boolean
  /** Include X-CSRF-Token header */
  csrf?: boolean
  /** Don't attempt refresh on 401 */
  skipRefresh?: boolean
  /** AbortSignal for cancellation */
  signal?: AbortSignal
}

// ─── Conditional log helper ────────────────────────────────────

function logRequestId(label: string, body: { requestId?: string }): void {
  if (body.requestId) {
    console.debug(`[api] ${label} requestId=${body.requestId}`)
  }
}

// ─── Core Request Function ─────────────────────────────────────

const EMPTY_HEADERS = {} as const

/**
 * Generate an X-Request-Id for client-side request tracing (api.md §12).
 * ULID-like format: short random hex string, ≤ 64 chars.
 */
function newRequestId(): string {
  return `req_fe_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

/**
 * Core `fetch` wrapper.
 *
 * 1. Builds headers (Content-Type, Authorization, X-CSRF-Token, Idempotency-Key, X-Request-Id)
 * 2. Sends request
 * 3. On 401 + valid token → attempts refresh → retries once
 * 4. Parses JSON body into `ApiResult`
 */
export async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<ApiResult<T>> {
  const url = `${API_BASE}${path}`
  const headers = new Headers(options.headers || EMPTY_HEADERS)

  // Content-Type
  if (body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=utf-8')
  }

  // Authorization
  if (!options.noAuth) {
    const tk = _memoryToken
    if (tk) headers.set('Authorization', `Bearer ${tk}`)
  }

  // CSRF — only set when token is non-empty to avoid sending a blank header
  if (options.csrf) {
    const csrfToken = getCsrfToken()
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken)
  }

  // Idempotency-Key — 提升到业务意图层，超时重试复用同一 key（M9）
  const idempotencyKey = options.idempotent
    ? (_intentKey || newIdempotencyKey())
    : undefined
  if (idempotencyKey && !_intentKey) {
    _intentKey = idempotencyKey
  }
  if (idempotencyKey) {
    headers.set('Idempotency-Key', idempotencyKey)
  }

  // X-Request-Id — 客户端请求追踪（api.md §12 通用请求头）
  if (!headers.has('X-Request-Id')) {
    headers.set('X-Request-Id', newRequestId())
  }

  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',
    signal: options.signal,
  }
  if (body !== undefined) {
    if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer ||
        body instanceof URLSearchParams || body instanceof ReadableStream) {
      init.body = body
      if (body instanceof FormData) {
        headers.delete('Content-Type')
      }
    } else {
      init.body = JSON.stringify(body)
    }
  }

  let res = await fetch(url, init)

  // ── Auto-refresh on 401 ──
  if (res.status === 401 && !options.skipRefresh && _memoryToken) {
    const newToken = await doRefresh()
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`)
      res = await fetch(url, { ...init, headers })
    } else {
      setAccessToken(null)
    }
  }

  // ── Parse response ──
  // Clear intent key only after idempotent requests to prevent
  // non-idempotent calls from accidentally wiping a key set for an upcoming
  // idempotent request (M9 / N1).
  if (options.idempotent) {
    _intentKey = null
  }
  const status = res.status
  const contentType = res.headers.get('content-type') || ''

  // Parse rate limit headers (api.md §12 通用响应头)
  const rateLimit: RateLimitInfo | undefined = (() => {
    const limit = res.headers.get('X-RateLimit-Limit')
    const remaining = res.headers.get('X-RateLimit-Remaining')
    const reset = res.headers.get('X-RateLimit-Reset')
    const retryAfter = res.headers.get('Retry-After')
    if (limit && remaining && reset) {
      return {
        limit: Number(limit),
        remaining: Number(remaining),
        reset: Number(reset),
        ...(retryAfter ? { retryAfter: Number(retryAfter) } : {}),
      }
    }
    return undefined
  })()

  if (status === 204) {
    return { ok: true, data: undefined as T, requestId: res.headers.get('X-Request-Id') || '', status, rateLimit }
  }

  if (contentType.includes('application/json')) {
    const json = (await res.json()) as Record<string, unknown>
    const requestId = (json.requestId as string) || res.headers.get('X-Request-Id') || ''

    // Log rate limit info for 429 responses (L1)
    if (status === 429 && rateLimit?.retryAfter) {
      console.warn(`[api] Rate limited: retry after ${rateLimit.retryAfter}s (${rateLimit.limit} req/window)`)
      try { window.dispatchEvent(new CustomEvent('api:rate-limit', { detail: rateLimit })) } catch {/* noop */}
    }

    if (status >= 200 && status < 300) {
      logRequestId(`${method} ${path}`, json)
      // Persist CSRF token from response body if present (H1 — supports cross-origin OAuth flows)
      const responseCsrf = json.csrfToken as string | undefined
      if (responseCsrf) saveCsrfToken(responseCsrf)
      const base = { requestId, status, rateLimit }
      const pagination = json.pagination as { limit: number; nextCursor: string | null; hasMore: boolean } | undefined
      const result: ApiResult<T> = pagination
        ? { ...base, ok: true as const, data: json.data as T, pagination }
        : { ...base, ok: true as const, data: json.data as T }
      return result
    }

    // Error response — api.md §12 format: { error: { code, message, details?, data? }, requestId }
    // Also extract CSRF token from error responses (H1)
    const errorCsrf = json.csrfToken as string | undefined
    if (errorCsrf) saveCsrfToken(errorCsrf)
    const errorData = json.error as { code: string; message: string; details?: Array<{ field: string; reason: string }>; data?: Record<string, unknown> } | undefined

    // Append retry-after info to rate-limited error messages so pages display it automatically (L1)
    if (status === 429 && rateLimit?.retryAfter && errorData?.message) {
      errorData.message += ` (请在 ${rateLimit.retryAfter} 秒后重试)`
    }

    return {
      ok: false,
      error: errorData || { code: 'UNKNOWN', message: 'Unknown error' },
      requestId: (json.requestId as string) || requestId,
      status,
      rateLimit,
    }
  }

  // Non-JSON response (e.g. image, plain text)
  if (status >= 200 && status < 300) {
    return { ok: true, data: res as unknown as T, requestId: '', status, rateLimit }
  }

  return { ok: false, error: { code: 'HTTP_ERROR', message: `HTTP ${status}` }, requestId: '', status, rateLimit }
}

// ─── HTTP Verb Helpers ─────────────────────────────────────────

export function get<T = unknown>(path: string, options?: ApiRequestOptions): Promise<ApiResult<T>> {
  return apiRequest<T>('GET', path, undefined, options)
}

export function post<T = unknown>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<ApiResult<T>> {
  return apiRequest<T>('POST', path, body, options)
}

export function patch<T = unknown>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<ApiResult<T>> {
  return apiRequest<T>('PATCH', path, body, options)
}

export function del<T = unknown>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<ApiResult<T>> {
  return apiRequest<T>('DELETE', path, body, options)
}

/**
 * Upload a file via multipart/form-data (api.md §11.1).
 */
export async function uploadFile<T = {
  id: string
  url: string
  mimeType: string
  size: number
  width: number
  height: number
  sha256: string
  createdAt: number
}>(
  file: File,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  const formData = new FormData()
  formData.append('file', file)

  const headers = new Headers()
  const tk = _memoryToken
  if (tk) headers.set('Authorization', `Bearer ${tk}`)
  headers.set('X-Request-Id', newRequestId())

  let res = await fetch(`${API_BASE}/images`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: formData,
    signal,
  })

  if (res.status === 401 && _memoryToken) {
    const newToken = await doRefresh()
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`)
      res = await fetch(`${API_BASE}/images`, {
        method: 'POST', headers, credentials: 'include', body: formData, signal,
      })
    } else {
      setAccessToken(null)
    }
  }

  const status = res.status
  const contentType = res.headers.get('content-type') || ''
  const requestId = res.headers.get('X-Request-Id') || ''

  if (status >= 200 && status < 300) {
    if (!contentType.includes('application/json')) {
      return { ok: true, data: res as unknown as T, requestId, status }
    }
    const json = await res.json() as Record<string, unknown>
    return { ok: true, data: json.data as T, requestId: (json.requestId as string) || requestId, status }
  }

  if (contentType.includes('application/json')) {
    const json = await res.json() as Record<string, unknown>
    return {
      ok: false,
      error: (json as { error?: { code: string; message: string } }).error || { code: 'UNKNOWN', message: 'Upload failed' },
      requestId: (json.requestId as string) || requestId, status,
    }
  }

  return {
    ok: false,
    error: { code: 'UPLOAD_ERROR', message: `HTTP ${status}` },
    requestId, status,
  }
}

/**
 * Convenience: refresh the access token at app init.
 * Returns the new access token or null.
 */
export async function tryRefreshToken(): Promise<string | null> {
  const token = await doRefresh()
  return token
}

/**
 * Clear all auth state (on logout or session expiry).
 */
export function clearAuth(): void {
  _memoryToken = null
  _loginProvider = null
  _refreshPromise = null
  _intentKey = null
}
