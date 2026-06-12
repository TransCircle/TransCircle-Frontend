import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import cookieParser from 'cookie-parser'
import path from 'path'
import { fileURLToPath } from 'url'
import { log } from './Logger'
import { requestId } from './middleware/requestId'
import { corsHandler } from './middleware/cors'
import { rateLimit } from './middleware/rateLimit'
import { sendError, Errors } from './utils/response'
import { sendSuccess } from './utils/response'
import pool from './Database'
import { metrics } from './utils/metrics'

// Import route modules
import authRoutes from './routes/auth'
import authRegisterRoutes from './routes/auth-register'
import authLoginRoutes from './routes/auth-login'
import authPasswordRoutes from './routes/auth-password'
import authSessionsRoutes from './routes/auth-sessions'
import authTotpRoutes from './routes/auth-totp'
import authStepupRoutes from './routes/auth-stepup'
import authPasskeyRoutes from './routes/auth-passkey'
import authOauthBindRoutes from './routes/auth-oauth-bind'
import authOauthNativeRoutes from './routes/auth-oauth-native'
import authMergeRoutes from './routes/auth-merge'
import meRoutes from './routes/me'
import contributionRoutes from './routes/contributions'
import adminRoutes from './routes/admin'
import adminUsersRoutes from './routes/admin-users'
import adminAuditRoutes from './routes/admin-audit'
import publicContributionsRoutes from './routes/public-contributions'
import editRequestRoutes from './routes/edit-requests'
import imagesRoutes from './routes/images'
import storiesRoutes from './routes/stories'
import openapiRoutes from './routes/openapi'

const app: Express = express()

// ── Global middleware ───────────────────────────
app.use(requestId)
app.use(corsHandler)
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(rateLimit)

// ── Request logging + metrics ───────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  metrics.httpTotal++
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    // Record request duration histogram per api.md §13.2.2
    metrics.httpRequestDurationSeconds.push(duration / 1000)
    const method = req.method.padEnd(6, ' ')
    const status = res.statusCode.toString().padStart(3, ' ')
    metrics.httpByStatus[res.statusCode] = (metrics.httpByStatus[res.statusCode] || 0) + 1
    const pathGroup = req.path.replace(/\/[a-z0-9_]{26,}/g, '/:id')
    metrics.httpByPath[pathGroup] = (metrics.httpByPath[pathGroup] || 0) + 1
    const dimKey = `${req.method}|${pathGroup}|${res.statusCode}`
    metrics.httpByMethodPathStatus[dimKey] = (metrics.httpByMethodPathStatus[dimKey] || 0) + 1
    log(`${method} ${req.path} -> ${status} ${duration}ms [${req.requestId}]`)
  })
  next()
})

// ── Health checks per api.md §13.1 ─────────────
async function runHealthChecks(): Promise<{ status: string; checks: Record<string, string> }> {
  const checks: Record<string, string> = {}
  let allOk = true

  // Database check
  try {
    await pool.query('SELECT 1')
    checks.database = 'ok'
  } catch {
    checks.database = 'error'
    allOk = false
  }

  // ObjectStorage check (config-based, no runtime dep on probe)
  const storageConfigured = !!(process.env.IMAGE_STORAGE_DIR || process.env.S3_BUCKET || process.env.R2_BUCKET)
  checks.objectStorage = storageConfigured ? 'ok' : 'degraded'
  if (!storageConfigured) allOk = false

  // KMS check (config-based, key dir or env presence)
  const kmsConfigured = !!(process.env.JWT_KEY_DIR || process.env.KMS_KEY_ID)
  checks.kms = kmsConfigured ? 'ok' : 'degraded'
  if (!kmsConfigured) allOk = false

  return { status: allOk ? 'ok' : 'degraded', checks }
}

app.get('/healthz', async (req: Request, res: Response) => {
  const { status, checks } = await runHealthChecks()
  const isHealthy = status === 'ok'
  if (!isHealthy) {
    res.setHeader('Retry-After', '5')
  }
  sendSuccess(res, {
    status,
    service: 'transcircle-api',
    version: '1.0.0',
    commit: process.env.GIT_COMMIT || 'unknown',
    uptimeSeconds: Math.floor(process.uptime()),
    checks,
  }, req.requestId, isHealthy ? 200 : 503)
})

app.get('/readyz', async (req: Request, res: Response) => {
  const { status, checks } = await runHealthChecks()
  const isReady = status === 'ok'
  if (!isReady) {
    res.setHeader('Retry-After', '5')
  }
  sendSuccess(res, {
    status,
    service: 'transcircle-api',
    version: '1.0.0',
    commit: process.env.GIT_COMMIT || 'unknown',
    uptimeSeconds: Math.floor(process.uptime()),
    checks,
  }, req.requestId, isReady ? 200 : 503)
})

// ── Serve frontend static files (同源部署 — api.md §1.6.2 CSRF/Cookie 模型)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distPath = path.join(__dirname, '../../dist')
app.use(express.static(distPath))

// ── API Routes ──────────────────────────────────
app.use('/v1/auth', authRoutes)
app.use('/v1/auth', authRegisterRoutes)
app.use('/v1/auth', authLoginRoutes)
app.use('/v1', authPasswordRoutes)    // /auth/password/forgot, /auth/password/reset, /me/password
app.use('/v1', authSessionsRoutes)    // /auth/session, /auth/logout-all, /me/sessions
app.use('/v1', authTotpRoutes)        // /me/mfa/totp/*, /auth/mfa/totp/verify
app.use('/v1', authStepupRoutes)      // /auth/step-up/start, /auth/step-up/verify
app.use('/v1', authPasskeyRoutes)     // /me/passkeys/*, /auth/passkey/login/*
app.use('/v1', authOauthBindRoutes)   // /me/oauth
app.use('/v1', authOauthNativeRoutes) // /auth/oauth/native/*
app.use('/v1', authMergeRoutes)       // /auth/merge
app.use('/v1/me', meRoutes)
app.use('/v1/contributions', contributionRoutes)
app.use('/v1/admin', adminRoutes)
app.use('/v1/admin', adminUsersRoutes)
app.use('/v1/admin', adminAuditRoutes)
app.use('/v1/public', publicContributionsRoutes)
app.use('/v1', editRequestRoutes)        // /v1/contributions/:id/edit-requests, /v1/me/edit-requests/*, /v1/admin/edit-requests/*
app.use('/v1/images', imagesRoutes)      // api.md §11
app.use('/v1', openapiRoutes)            // /v1/openapi.json — api.md §13.4
app.use('/v1/stories', storiesRoutes)

// ── Metrics endpoint per api.md §13.2 ──────────
app.get('/metrics', (req: Request, res: Response) => {
  const basicAuth = req.headers.authorization
  const metricsUser = process.env.METRICS_BASIC_AUTH_USER
  const metricsPass = process.env.METRICS_BASIC_AUTH_PASS

  if (metricsUser && metricsPass) {
    if (!basicAuth || !basicAuth.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="metrics"')
      res.status(401).end('Unauthorized')
      return
    }
    const decoded = Buffer.from(basicAuth.slice(6), 'base64').toString('utf-8')
    const [user, pass] = decoded.split(':')
    if (user !== metricsUser || pass !== metricsPass) {
      res.status(403).end('Forbidden')
      return
    }
  }

  const start = Date.now()
  // Basic process metrics per spec
  const uptime = Math.floor(process.uptime())
  const mem = process.memoryUsage()

  const lines = [
    '# HELP http_requests_total Total HTTP requests',
    '# TYPE http_requests_total counter',
    `http_requests_total{method="all",route="all",status="all"} ${metrics.httpTotal}`,
    ...Object.entries(metrics.httpByStatus).map(
      ([status, count]) => `http_requests_total{method="all",route="all",status="${status}"} ${count}`,
    ),
    ...Object.entries(metrics.httpByPath).map(
      ([path, count]) => `http_requests_total{method="all",route="${path}",status="all"} ${count}`,
    ),
    ...Object.entries(metrics.httpByMethodPathStatus).map(
      ([dimKey, count]) => {
        const [method, route, status] = dimKey.split('|')
        return `http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`
      },
    ),
    '',
    // ── auth_login_total ──
    '# HELP auth_login_total Total login attempts',
    '# TYPE auth_login_total counter',
    ...Object.entries(metrics.authLoginTotal).map(
      ([result, count]) => `auth_login_total{result="${result}"} ${count}`,
    ),
    '',
    // ── auth_token_refresh_total ──
    '# HELP auth_token_refresh_total Token refresh results',
    '# TYPE auth_token_refresh_total counter',
    ...Object.entries(metrics.authTokenRefreshTotal).map(
      ([result, count]) => `auth_token_refresh_total{result="${result}"} ${count}`,
    ),
    '',
    // ── auth_oauth_callback_total ──
    '# HELP auth_oauth_callback_total OAuth callback results',
    '# TYPE auth_oauth_callback_total counter',
    ...Object.entries(metrics.authOauthCallbackTotal).map(
      ([key, count]) => {
        const [provider, status] = key.split('|')
        return `auth_oauth_callback_total{provider="${provider}",status="${status}"} ${count}`
      },
    ),
    '',
    // ── mfa_verify_total ──
    '# HELP mfa_verify_total MFA verification attempts',
    '# TYPE mfa_verify_total counter',
    ...Object.entries(metrics.mfaVerifyTotal).map(
      ([key, count]) => {
        const [method, result] = key.split('|')
        return `mfa_verify_total{method="${method}",result="${result}"} ${count}`
      },
    ),
    '',
    // ── passkey_replay_detected_total ──
    '# HELP passkey_replay_detected_total Passkey replay detections',
    '# TYPE passkey_replay_detected_total counter',
    `passkey_replay_detected_total ${metrics.passkeyReplayDetectedTotal}`,
    '',
    // ── rate_limited_total ──
    '# HELP rate_limited_total Rate limited requests',
    '# TYPE rate_limited_total counter',
    ...Object.entries(metrics.rateLimitedTotal).map(
      ([key, count]) => {
        const [route, dimension] = key.split('|')
        return `rate_limited_total{route="${route}",dimension="${dimension}"} ${count}`
      },
    ),
    '',
    // ── image_upload_total ──
    '# HELP image_upload_total Image upload results',
    '# TYPE image_upload_total counter',
    ...Object.entries(metrics.imageUploadTotal).map(
      ([key, count]) => {
        const [result, mime] = key.split('|')
        return `image_upload_total{result="${result}",mime="${mime}"} ${count}`
      },
    ),
    '',
    // ── contribution_review_latency_seconds ──
    '# HELP contribution_review_latency_seconds Review latency from submission to first review',
    '# TYPE contribution_review_latency_seconds histogram',
    `contribution_review_latency_seconds_count ${metrics.contributionReviewLatencySeconds.length}`,
    metrics.contributionReviewLatencySeconds.length > 0
      ? `contribution_review_latency_seconds_sum ${metrics.contributionReviewLatencySeconds.reduce((a, b) => a + b, 0)}`
      : 'contribution_review_latency_seconds_sum 0',
    ...(() => {
      const buckets = [60, 300, 600, 1800, 3600, 7200, 14400, 28800, 86400]
      return buckets.map(le => {
        const count = metrics.contributionReviewLatencySeconds.filter(v => v <= le).length
        return `contribution_review_latency_seconds_bucket{le="${le}"} ${count}`
      })
    })(),
    `contribution_review_latency_seconds_bucket{le="+Inf"} ${metrics.contributionReviewLatencySeconds.length}`,
    '',
    // ── http_request_duration_seconds (api.md §13.2.2) ──
    '# HELP http_request_duration_seconds HTTP request duration in seconds',
    '# TYPE http_request_duration_seconds histogram',
    `http_request_duration_seconds_count ${metrics.httpRequestDurationSeconds.length}`,
    metrics.httpRequestDurationSeconds.length > 0
      ? `http_request_duration_seconds_sum ${metrics.httpRequestDurationSeconds.reduce((a, b) => a + b, 0)}`
      : 'http_request_duration_seconds_sum 0',
    ...(() => {
      const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
      return buckets.map(le => {
        const count = metrics.httpRequestDurationSeconds.filter(v => v <= le).length
        return `http_request_duration_seconds_bucket{le="${le}"} ${count}`
      })
    })(),
    `http_request_duration_seconds_bucket{le="+Inf"} ${metrics.httpRequestDurationSeconds.length}`,
    '# HELP process_uptime_seconds Process uptime in seconds',
    '# TYPE process_uptime_seconds gauge',
    `process_uptime_seconds ${uptime}`,
    '',
    '# HELP process_memory_bytes Process memory usage in bytes',
    '# TYPE process_memory_bytes gauge',
    `process_memory_bytes{type="rss"} ${mem.rss}`,
    `process_memory_bytes{type="heapTotal"} ${mem.heapTotal}`,
    `process_memory_bytes{type="heapUsed"} ${mem.heapUsed}`,
    '',
    '# HELP nodejs_eventloop_lag_seconds Event loop lag',
    '# TYPE nodejs_eventloop_lag_seconds gauge',
    `nodejs_eventloop_lag_seconds ${Date.now() - start}`,
    '',
  ]

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  res.status(200).end(lines.join('\n'))
})

// ── SPA fallback — Express 5 不支持 `app.get('*')`，改用中间件 ──
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/v1/') || req.path === '/healthz' || req.path === '/readyz' || req.path === '/metrics') {
    return next()
  }
  res.sendFile(path.join(distPath, 'index.html'))
})

// ── 404 handler ─────────────────────────────────
app.use((req: Request, res: Response) => {
  sendError(res, 'NOT_FOUND', `请求的接口不存在: ${req.method} ${req.path}`, req.requestId, 404)
})

// ── Global error handler ────────────────────────
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  void _next
  log(`ERROR: ${err.message}`)
  if (err.stack) {
    const line = err.stack.split('\n')[1]?.trim()
    if (line) log(line)
  }
  sendError(res, Errors.INTERNAL_ERROR.code, '服务器内部错误，请稍后重试', req.requestId, 500)
})

export default app
