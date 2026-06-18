import type { Request, Response, NextFunction } from 'express';
import { exec, queryOne } from '../Database';
import { sendError, Errors } from '../utils/response';
import { ulid } from '../utils/ulid';
import { metrics } from '../utils/metrics';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rateLimitAction?: string;
    }
  }
}

interface RateLimitConfig {
  /** Max requests in the window */
  max: number;
  /** Window in milliseconds */
  windowMs: number;
  /** Name for error messages */
  name: string;
}

const LIMITS: Record<string, RateLimitConfig> = {
  default: { max: 600, windowMs: 60_000, name: 'general' },     // 600/min — api.md §13.3
  submit: { max: 5, windowMs: 600_000, name: '投稿' },          // 5/10min per user — api.md §3.1
  'submit:ip': { max: 20, windowMs: 600_000, name: '投稿IP' },  // 20/10min per IP — api.md §3.1
  auth: { max: 30, windowMs: 300_000, name: '登录' },            // 30/5min — api.md §1.3
  register: { max: 30, windowMs: 3600_000, name: '注册' },       // 30/hour — api.md §1.1
  'register:ip': { max: 30, windowMs: 3600_000, name: '注册IP' }, // 同IP 30/h — api.md §1.1
  // Per-email registration limit: 24h/5 — api.md §1.1
  'register:email': { max: 5, windowMs: 86_400_000, name: '注册邮箱' },
  // Per-username registration limit: 24h/5 — api.md §1.1
  'register:username': { max: 5, windowMs: 86_400_000, name: '注册用户名' },
  // Login failure per IP×identifier: 15min/10 failures — api.md §1.3
  'login:fail:ip_identifier': { max: 10, windowMs: 900_000, name: '登录失败' },
  // Login failure per account: 15min/5 failures — api.md §1.3
  'login:fail:account': { max: 5, windowMs: 900_000, name: '登录锁定' },
  // Email resend: 1h/5 per email — api.md §1.2.2
  'email:resend': { max: 5, windowMs: 3600_000, name: '邮件重发' },
  // Password reset: 1h/3 per email — api.md §1.4.1
  'password:forgot:email': { max: 3, windowMs: 3600_000, name: '重置密码' },
  'password:forgot': { max: 20, windowMs: 3600_000, name: '重置密码IP' },
  'password:reset': { max: 10, windowMs: 300_000, name: '重置提交' },
  admin: { max: 60, windowMs: 60_000, name: '管理' },            // 60/min
  image: { max: 20, windowMs: 3600_000, name: '图片' },           // 20/h per user — api.md §11.1
  'image:ip': { max: 100, windowMs: 3600_000, name: '图片IP' },   // 100/h per IP — api.md §11.1
};

/** MySQL-based rate limiter middleware.
 * Uses a bucket per (key, action) — the key is typically IP.
 *
 * Canonical schema is in functions/schema.sql (rate_limits table).
 * The middleware assumes the table exists — if it doesn't, the
 * try/catch in rateLimitCheck degrades gracefully (no rate limiting).
 *
 * Set `req.rateLimitAction` to use a specific action bucket instead of 'default'.
 */
export function rateLimit(_req: Request, _res: Response, next: NextFunction): void {
  // Synchronous middleware wrapper — the actual async check runs in rateLimitCheck after body parsing.
  next();
}

/**
 * Async rate limit check — run after body parsing.
 * Supports both IP-based (default) and user-based rate limiting when req.user is set.
 */
export async function rateLimitCheck(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const action = req.rateLimitAction || 'default';
  const config = LIMITS[action] || LIMITS.default;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  const now = Date.now();
  const windowStart = Math.floor(now / config.windowMs) * config.windowMs;

  // Per-IP bucket (always applies)
  const ipBucketKey = `rl:${ip}:${action}:${windowStart}`;
  // Per-user bucket (when authenticated — api.md §13.3: 300/min global)
  const userId = (req.user as { userId?: string } | undefined)?.userId
  const userBucketKey = userId ? `rl:u:${userId}:${action}:${windowStart}` : null
  // Per-user global bucket (300/min independent of action)
  const userGlobalBucketKey = userId ? `rl:ug:${userId}:${Math.floor(now / 60000) * 60000}` : null

  // Cleanup old windows (best-effort)
  try {
    await exec(`DELETE FROM rate_limits WHERE windowStart < ?`, [now - config.windowMs * 2]);
  } catch { /* ignore cleanup errors */ }

  try {
    // Check both IP and user buckets
    const buckets = [ipBucketKey]
    if (userBucketKey) buckets.push(userBucketKey)
    if (userGlobalBucketKey) buckets.push(userGlobalBucketKey)

    for (const bucketKey of buckets) {
      await exec(
        `INSERT INTO rate_limits (id, bucketKey, windowStart, count, createdAt)
         VALUES (?, ?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE count = count + 1`,
        [ulid(), bucketKey, windowStart, now],
      );

      const updated = await queryOne(
        `SELECT count FROM rate_limits WHERE bucketKey = ?`,
        [bucketKey],
      );
      const currentCount = (updated?.count as number) || 1;

      // User global bucket uses separate 300/min limit (api.md §13.3)
      const isUserGlobal = bucketKey.startsWith('rl:ug:')
      const effectiveMax = isUserGlobal ? 300 : config.max
      const effectiveWindowMs = isUserGlobal ? 60000 : config.windowMs
      const effectiveWindowStart = isUserGlobal
        ? Math.floor(now / 60000) * 60000
        : windowStart

      if (currentCount > effectiveMax) {
        // Track rate limited metric per api.md §13.2.2
        const rlRoute = req.path.replace(/\/[a-z0-9_]{26,}/g, '/:id');
        const rlDim = isUserGlobal ? 'user' : (userBucketKey === bucketKey ? 'user_action' : 'ip');
        metrics.rateLimitedTotal[`${rlRoute}|${rlDim}`] = (metrics.rateLimitedTotal[`${rlRoute}|${rlDim}`] || 0) + 1;

        const retryAfter = Math.ceil((effectiveWindowStart + effectiveWindowMs - now) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        res.setHeader('X-RateLimit-Limit', String(effectiveMax));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(effectiveWindowStart + effectiveWindowMs));

        sendError(
          res,
          Errors.RATE_LIMITED.code,
          isUserGlobal
            ? `请求频率过高，请 ${retryAfter} 秒后重试`
            : `${config.name}请求过于频繁，请 ${retryAfter} 秒后重试`,
          req.requestId,
          Errors.RATE_LIMITED.status,
        );
        return;
      }

      res.setHeader('X-RateLimit-Limit', String(effectiveMax));
      res.setHeader('X-RateLimit-Remaining', String(effectiveMax - currentCount));
      res.setHeader('X-RateLimit-Reset', String(effectiveWindowStart + effectiveWindowMs));
    }
  } catch {
    // DB error — proceed without rate limiting
  }

  next();
}
