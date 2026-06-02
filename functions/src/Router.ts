import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import cookieParser from 'cookie-parser'
import { log } from './Logger'
import { requestId } from './middleware/requestId'
import { corsHandler } from './middleware/cors'
import { rateLimit } from './middleware/rateLimit'
import { sendError, Errors } from './utils/response'
import { sendSuccess } from './utils/response'
import pool from './Database'

// Import route modules
import authRoutes from './routes/auth'
import authRegisterRoutes from './routes/auth-register'
import authLoginRoutes from './routes/auth-login'
import authPasswordRoutes from './routes/auth-password'
import authSessionsRoutes from './routes/auth-sessions'
import authTotpRoutes from './routes/auth-totp'
import authStepupRoutes from './routes/auth-stepup'
import authOauthBindRoutes from './routes/auth-oauth-bind'
import authMergeRoutes from './routes/auth-merge'
import meRoutes from './routes/me'
import contributionRoutes from './routes/contributions'
import adminRoutes from './routes/admin'
import adminUsersRoutes from './routes/admin-users'
import adminAuditRoutes from './routes/admin-audit'
import publicContributionsRoutes from './routes/public-contributions'
import storiesRoutes from './routes/stories'

const app: Express = express()

// ── Global middleware ───────────────────────────
app.use(requestId)
app.use(corsHandler)
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(rateLimit)

// ── Request logging ─────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    const method = req.method.padEnd(6, ' ')
    const status = res.statusCode.toString().padStart(3, ' ')
    log(`${method} ${req.path} -> ${status} ${duration}ms [${req.requestId}]`)
  })
  next()
})

// ── Health checks per api.md §13.1 ─────────────
app.get('/healthz', (req: Request, res: Response) => {
  sendSuccess(res, {
    status: 'ok',
    service: 'transcircle-api',
    version: '1.0.0',
    commit: process.env.GIT_COMMIT || 'unknown',
    uptimeSeconds: Math.floor(process.uptime()),
    checks: { database: 'ok' },
  }, req.requestId)
})

app.get('/readyz', async (req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1')
    sendSuccess(res, {
      status: 'ok',
      service: 'transcircle-api',
      version: '1.0.0',
      commit: process.env.GIT_COMMIT || 'unknown',
      uptimeSeconds: Math.floor(process.uptime()),
      checks: { database: 'ok' },
    }, req.requestId)
  } catch {
    res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not ready' },
      requestId: req.requestId,
    })
  }
})

// Legacy health endpoint
app.get('/v1/health', (req: Request, res: Response) => {
  sendSuccess(res, { status: 'ok', timestamp: Date.now() }, req.requestId)
})

// ── API Routes ──────────────────────────────────
app.use('/v1/auth', authRoutes)
app.use('/v1/auth', authRegisterRoutes)
app.use('/v1/auth', authLoginRoutes)
app.use('/v1', authPasswordRoutes)    // /auth/password/forgot, /auth/password/reset, /me/password
app.use('/v1', authSessionsRoutes)    // /auth/session, /auth/logout-all, /me/sessions
app.use('/v1', authTotpRoutes)        // /me/mfa/totp/*, /auth/mfa/totp/verify
app.use('/v1', authStepupRoutes)      // /auth/step-up/start, /auth/step-up/verify
app.use('/v1', authOauthBindRoutes)   // /me/oauth
app.use('/v1', authMergeRoutes)       // /auth/merge
app.use('/v1/me', meRoutes)
app.use('/v1/contributions', contributionRoutes)
app.use('/v1/admin', adminRoutes)
app.use('/v1/admin', adminUsersRoutes)
app.use('/v1/admin', adminAuditRoutes)
app.use('/v1/public', publicContributionsRoutes)
app.use('/v1/stories', storiesRoutes)

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
