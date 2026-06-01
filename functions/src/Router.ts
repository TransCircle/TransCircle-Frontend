import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { log } from './Logger';
import { requestId } from './middleware/requestId';
import { corsHandler } from './middleware/cors';
import { rateLimit } from './middleware/rateLimit';
import { sendError, Errors } from './utils/response';

// Import route modules
import authRoutes from './routes/auth';
import meRoutes from './routes/me';
import contributionRoutes from './routes/contributions';
import adminRoutes from './routes/admin';
import storiesRoutes from './routes/stories';

const app: Express = express();

// ── Global middleware ───────────────────────────
app.use(requestId);              // Inject req.requestId
app.use(corsHandler);            // CORS
app.use(express.json());         // JSON body parser
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());         // Cookie parser
app.use(rateLimit);              // Rate limit marker

// ── Request logging ─────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const method = req.method.padEnd(6, ' ');
    const status = res.statusCode.toString().padStart(3, ' ');
    log(`${method} ${req.path} -> ${status} ${duration}ms [${req.requestId}]`);
  });
  next();
});

// ── Health check ────────────────────────────────
app.get('/v1/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ── API Routes ──────────────────────────────────
app.use('/v1/auth', authRoutes);
app.use('/v1/me', meRoutes);
app.use('/v1/contributions', contributionRoutes);
app.use('/v1/admin', adminRoutes);
app.use('/v1/stories', storiesRoutes);

// ── 404 handler ─────────────────────────────────
app.use((req: Request, res: Response) => {
  sendError(res, Errors.NOT_FOUND.code,
    `请求的接口不存在: ${req.method} ${req.path}`,
    req.requestId, 404);
});

// ── Global error handler ────────────────────────
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  log(`ERROR: ${err.message}`);
  if (err.stack) {
    const line = err.stack.split('\n')[1]?.trim();
    if (line) log(line);
  }

  sendError(res, Errors.INTERNAL_ERROR.code,
    '服务器内部错误，请稍后重试',
    req.requestId, 500);
});

export default app;
