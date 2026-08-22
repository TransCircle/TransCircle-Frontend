/**
 * Unified API client for TransCircle Frontend.
 *
 * 设计目标：
 * - 内存中管理 access token（不写 localStorage / sessionStorage，遵守 api.md JWT 存储建议）
 * - 401 时自动 refresh → retry（refresh token rotation 由后端保障）
 * - 统一的请求拦截（自动注入 Authorization / Content-Type / Idempotency-Key）
 * - 统一的错误解析
 * - 类型安全的辅助方法
 */

import { API_BASE as _API_BASE } from '@/config'
import i18n from '@/i18n/config'

/** Re-export for use by pages that need direct fetch (e.g. DELETE with body) */
export const API_BASE = _API_BASE

// ─── Token Management ──────────────────────────────────────────

let _memoryToken: string | null = null

export function setAccessToken(token: string | null): void {
  /* 任何一次 token 变化都是一次身份切换，必须让在途请求的认证代号失效。
     覆盖「旧 token → null → 新 token」的完整链路：只判「两端都非空」的话，
     会话过期清空后再登录另一个账号，代号自始至终没变，慢请求收到 401 时
     会被当成当前会话，用新账号的 token 重试。
     doRefresh 内部的续期不走这里（它直接写 _memoryToken），续的是同一段会话。 */
  if (token !== _memoryToken) {
    _authGeneration += 1
    // 在途的 refresh 属于上一段会话：它拿到结果也会因代号不符而作废，
    // 留着只会让新会话的 401 复用它、拿到 null，从而放弃自己的刷新机会。
    _refreshPromise = null
  }
  _memoryToken = token
}

export function getAccessToken(): string | null {
  return _memoryToken
}

// ─── Refresh Token Rotation ────────────────────────────────────

let _refreshPromise: Promise<string | null> | null = null
/* 刷新请求的超时。它是全局共享的排队 promise，拿不到某个调用方的 signal，
   自己不设上限的话，一次悬住的 /auth/refresh 会把所有等它的请求一起挂死——
   包括那些自己明明设了超时的（超时只能中断它们自己那一发，中断不了排在
   前面的刷新）。超时按瞬时错误处理：返回 null、保留 token，不误登出。 */
const REFRESH_TIMEOUT_MS = 10000
// 认证代号：clearAuth() 自增后，在途 doRefresh 的结果（含内存 token 写回）一律作废，
// 防止「登出瞬间在途 refresh 完成 → token 回填内存」的竞态。
let _authGeneration = 0

/**
 * Attempt to refresh the access token via POST /v1/auth/refresh.
 * Uses a promise queue so concurrent callers share one in-flight request.
 */
async function doRefresh(): Promise<string | null> {
  if (_refreshPromise) return _refreshPromise

  /* 用 promise 自身作身份标记：clearAuth() 会直接把 _refreshPromise 置空，
     于是新一轮 refresh 可以在旧的仍在途时启动；旧 promise 的 finally 若无条件
     清空，就会把新一轮的 promise 一并抹掉，后续调用者各自再发一次刷新请求。 */
  let self: Promise<string | null> | null = null
  self = (async () => {
    const gen = _authGeneration
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }

      if (res.status === 401) {
        // REFRESH_TOKEN_REVOKED or INVALID_REFRESH_TOKEN
        console.warn('[auth] refresh failed: 401 — session expired or revoked')
        // 代号已变（期间登出并重新登录）：这是上一段会话的 401，与当前会话无关。
        // 不加这道判断，旧会话的失败会清掉新用户的 token 并把他踢去登录页。
        if (gen !== _authGeneration) return null
        /* 会话到此作废，代号必须自增：否则此刻仍在途的慢请求随后收到 401 时，
           代号看起来没变，会被当作「当前会话」而走刷新重试——若用户已重新登录，
           那就是拿新账号的 token 重发旧账号的请求。 */
        _authGeneration += 1
        _memoryToken = null
        // 通知 AuthContext 清空 user / token / provider，使守卫立即重定向登录。
        // 否则内存 token 已清但 AuthContext.user 残留，SPA 会继续以登录态渲染到整页刷新。
        try {
          window.dispatchEvent(new CustomEvent('auth:session-expired'))
        } catch {
          /* 非浏览器环境忽略 */
        }
        return null
      }

      if (!res.ok) {
        console.warn(`[auth] refresh failed: HTTP ${res.status} — transient error, token preserved`)
        try {
          const body = await res.json().catch(() => ({}))
          console.warn('[auth] refresh error body:', body)
        } catch {
          /* empty */
        }
        return null
      }

      const body = (await res.json()) as {
        data?: { accessToken?: string }
        requestId?: string
      }
      if (body.data?.accessToken) {
        // 登出/过期后（_authGeneration 已自增）在途 refresh 的结果不再回填内存，
        // 也不能把「当前」token 交回给旧会话的调用者——那会让上一段会话的请求
        // 带着新用户的 token 重试。
        if (gen !== _authGeneration) return null
        _memoryToken = body.data.accessToken
        return _memoryToken
      }
      console.warn('[auth] refresh response missing accessToken, body:', body)
      return null
    } catch (err) {
      console.warn('[auth] refresh network error:', err)
      return null
    } finally {
      if (_refreshPromise === self) _refreshPromise = null
    }
  })()

  _refreshPromise = self
  return self
}

/**
 * 401 自动刷新并重试：如果响应是 401 且内存中有 token，尝试 refresh 后重试。
 * 返回重试后的 Response，或原始 Response（若 refresh 失败或无需刷新）。
 */
async function autoRefreshOn401(
  res: Response,
  url: string,
  init: RequestInit,
  headers: Headers,
  authGen: number,
): Promise<Response> {
  /* 认证上下文在请求往返期间换过（登出、或登出后换账号登录）：这个 401 属于
     上一段会话。此时刷新并重试，等于把 A 的请求体带着 B 的 token 再发一次——
     一次跨账号的请求重放。原样把 401 交回调用方即可。 */
  if (authGen !== _authGeneration) return res
  if (res.status === 401 && _memoryToken) {
    const newToken = await doRefresh()
    // 刷新本身是异步的：等待期间同样可能登出/换账号，所以拿到新 token 后要再查一次
    if (authGen !== _authGeneration) return res
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`)
      return fetch(url, { ...init, headers })
    }
    // doRefresh 已独占 token 生命周期：仅在 401/吊销时清空 _memoryToken，
    // 瞬时错误（5xx/网络）保留 token。此处不再无条件清空，避免瞬时故障误登出。
  }
  return res
}

// ─── Idempotency-Key Helper ────────────────────────────────────

/**
 * Generate a UUID v4 Idempotency-Key per api.md §12.
 * UUID v4 matches the required format (16-64 chars, UUID v4 or ULID).
 */
/** UUID v4，带 Safari 15.3- 的降级实现（那些环境没有 crypto.randomUUID）。 */
function uuidV4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export function newIdempotencyKey(): string {
  return uuidV4()
}

/**
 * 这次失败是否「请求可能已经到达服务端、只是结果未知」。
 *
 * 只有这一类失败重试时才必须复用同一个 Idempotency-Key：网络中断（status 0）、
 * 服务端错误（5xx）、限流（429）。明确的拒绝（400/403/404…）说明服务端已经表态，
 * 重试属于一件新的事，应当换新键。
 */
export function isRetryableFailure(status: number): boolean {
  return status === 0 || status === 429 || status >= 500
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

export type ApiResult<T = unknown> = ApiResultBase &
  (
    | {
        ok: true
        data: T
        /** 非 JSON 响应的原始 Response 对象（如 blob/image），此时 data=undefined */
        raw?: Response
        pagination?: {
          limit: number
          nextCursor: string | null
          hasMore: boolean
        }
      }
    | {
        ok: false
        error: ApiErrorBody['error']
      }
  )

// ─── Request Options ───────────────────────────────────────────

export interface ApiRequestOptions {
  /** Skip auto-injecting Authorization header */
  noAuth?: boolean
  /** Custom headers to merge */
  headers?: Record<string, string>
  /** Include Idempotency-Key header (UUID v4) */
  idempotent?: boolean
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

const EMPTY_HEADERS = {}

/**
 * Generate an X-Request-Id for client-side request tracing (api.md §12).
 * ULID-like format: short random hex string, ≤ 64 chars.
 */
function newRequestId(): string {
  /* 必须走 uuidV4 的降级路径：这里裸调 crypto.randomUUID 的话，在没有该 API 的
     Safari/WebView 里会在 apiRequest 的 try 之前就抛异常——不是某个请求失败，
     而是所有请求都发不出去。 */
  return `req_fe_${uuidV4().replace(/-/g, '').slice(0, 20)}`
}

/**
 * Core `fetch` wrapper.
 *
 * 1. Builds headers (Content-Type, Authorization, Idempotency-Key, X-Request-Id)
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

  // Idempotency-Key — 提升到业务意图层，超时重试复用同一 key（M9）
  const idempotencyKey = options.idempotent ? _intentKey || newIdempotencyKey() : undefined
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
    if (
      body instanceof FormData ||
      body instanceof Blob ||
      body instanceof ArrayBuffer ||
      body instanceof URLSearchParams ||
      body instanceof ReadableStream
    ) {
      init.body = body
      if (body instanceof FormData) {
        headers.delete('Content-Type')
      }
    } else {
      init.body = JSON.stringify(body)
    }
  }

  // Network error — keep _intentKey so retries reuse the same key (api.md §12).
  // If the request never reached the server, the server won't know the key and
  // will process it normally. If the request did reach the server but the response
  // was lost, reusing the key lets the server deduplicate. The error propagates
  // to the caller unchanged.
  // 记下发出请求时的认证代号，供 401 重试判断会话是否已经换人
  const authGenAtRequest = _authGeneration
  let res: Response
  try {
    res = await fetch(url, init)

    // ── Auto-refresh on 401 ──
    if (!options.skipRefresh) {
      res = await autoRefreshOn401(res, url, init, headers, authGenAtRequest)
    }
  } catch (err) {
    // Keep the intent key: a caller retry represents the same business intent and must reuse it.
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    return {
      ok: false,
      // message 必须有内容：调用方普遍用 `result.error.message || t(...)` 或直接
      // `throw new Error(message)`，空串会一路静默到 `error && <Alert>` 不渲染，
      // 断网时页面只剩一个空列表，看不出是失败还是真没数据。
      error: { code: 'NETWORK_ERROR', message: i18n.t('common.networkError') },
      requestId: '',
      status: 0,
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
    let json: Record<string, unknown>
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      return {
        ok: false,
        // 同 NETWORK_ERROR：空 message 会一路静默成空列表，至少带上 HTTP 状态
        error: { code: 'INVALID_RESPONSE', message: i18n.t('common.invalidResponse', { status }) },
        requestId: res.headers.get('X-Request-Id') || '',
        status,
        rateLimit,
      }
    }
    const requestId = (json.requestId as string) || res.headers.get('X-Request-Id') || ''

    // Log rate limit info for 429 responses (L1)
    if (status === 429 && rateLimit?.retryAfter) {
      console.warn(`[api] Rate limited: retry after ${rateLimit.retryAfter}s (${rateLimit.limit} req/window)`)
      try {
        window.dispatchEvent(new CustomEvent('api:rate-limit', { detail: rateLimit }))
      } catch {
        /* noop */
      }
    }

    if (status >= 200 && status < 300) {
      // path 可能含敏感 query（如 /admin/users?keyword=email），仅记录路径部分（api.md 安全基线）
      logRequestId(`${method} ${path.split('?')[0] ?? ''}`, json)
      const base = { requestId, status, rateLimit }
      const pagination = json.pagination as { limit: number; nextCursor: string | null; hasMore: boolean } | undefined
      const result: ApiResult<T> = pagination
        ? { ...base, ok: true as const, data: json.data as T, pagination }
        : { ...base, ok: true as const, data: json.data as T }
      return result
    }

    // Error response — api.md §12 format: { error: { code, message, details?, data? }, requestId }
    const errorData = json.error as
      | {
          code: string
          message: string
          details?: Array<{ field: string; reason: string }>
          data?: Record<string, unknown>
        }
      | undefined

    // Append retry-after info to rate-limited error messages so pages display it automatically (L1)
    if (status === 429 && rateLimit?.retryAfter && errorData?.message) {
      errorData.message += ' ' + i18n.t('common.rateLimitRetryIn', { seconds: rateLimit.retryAfter })
    }

    return {
      ok: false,
      error: errorData || { code: 'UNKNOWN', message: i18n.t('common.unknownError') },
      requestId: (json.requestId as string) || requestId,
      status,
      rateLimit,
    }
  }

  // Non-JSON response (e.g. image, plain text)
  // 返回 raw Response 供调用方自行处理（二进制/流等）
  if (status >= 200 && status < 300) {
    return { ok: true, data: undefined as T, raw: res, requestId: '', status, rateLimit }
  }

  return {
    ok: false,
    error: { code: 'HTTP_ERROR', message: i18n.t('common.httpError', { status }) },
    requestId: '',
    status,
    rateLimit,
  }
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
export async function uploadFile<
  T = {
    id: string
    url: string
    mimeType: string
    size: number
    width: number
    height: number
    sha256: string
    createdAt: number
  },
>(file: File, signal?: AbortSignal): Promise<ApiResult<T>> {
  const formData = new FormData()
  formData.append('file', file)

  const headers = new Headers()
  const tk = _memoryToken
  if (tk) headers.set('Authorization', `Bearer ${tk}`)
  headers.set('X-Request-Id', newRequestId())

  // 同 apiRequest：记下认证代号，会话换人后不做 401 重试
  const authGenAtRequest = _authGeneration
  let res: Response
  try {
    res = await fetch(`${API_BASE}/images`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: formData,
      signal,
    })

    // 401 时自动刷新重试（共享逻辑，与 apiRequest 一致）
    res = await autoRefreshOn401(
      res,
      `${API_BASE}/images`,
      {
        method: 'POST',
        headers,
        credentials: 'include',
        body: formData,
        signal,
      },
      headers,
      authGenAtRequest,
    )
  } catch {
    // 网络错误（断开/DNS/超时等），与 apiRequest 一致的错误格式
    return { ok: false, error: { code: 'NETWORK_ERROR', message: i18n.t('common.networkError') }, requestId: '', status: 0 }
  }

  const status = res.status
  const contentType = res.headers.get('content-type') || ''
  const requestId = res.headers.get('X-Request-Id') || ''

  if (status >= 200 && status < 300) {
    if (!contentType.includes('application/json')) {
      return { ok: true, data: undefined as T, raw: res, requestId, status }
    }
    const json = (await res.json()) as Record<string, unknown>
    return { ok: true, data: json.data as T, requestId: (json.requestId as string) || requestId, status }
  }

  if (contentType.includes('application/json')) {
    const json = (await res.json()) as Record<string, unknown>
    return {
      ok: false,
      error: (json as { error?: { code: string; message: string } }).error || {
        code: 'UNKNOWN',
        message: i18n.t('imageUploader.errorFallback'),
      },
      requestId: (json.requestId as string) || requestId,
      status,
    }
  }

  return {
    ok: false,
    error: { code: 'UPLOAD_ERROR', message: i18n.t('common.httpError', { status }) },
    requestId,
    status,
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
  // 先自增代号作废所有在途 refresh，再清空状态。
  _authGeneration += 1
  _memoryToken = null
  _refreshPromise = null
  _intentKey = null
}
