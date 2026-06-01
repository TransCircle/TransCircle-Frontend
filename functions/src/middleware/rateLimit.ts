import type { Request, Response, NextFunction } from 'express';
import { exec, queryOne } from '../Database';
import { sendError, Errors } from '../utils/response';
import { ulid } from '../utils/ulid';

declare global {
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
  default: { max: 30, windowMs: 60_000, name: 'general' },
  submit: { max: 5, windowMs: 3600_000, name: '投稿' },     // 5/hour
  auth: { max: 20, windowMs: 3600_000, name: '登录' },       // 20/hour
  admin: { max: 60, windowMs: 60_000, name: '管理' },        // 60/min
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
export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  // Store the action for async middleware
  res.locals.rateLimitAction = req.rateLimitAction || 'default';
  res.locals.rateLimitIp = req.ip || req.socket.remoteAddress || 'unknown';
  next();
}

/**
 * Async rate limit check — run after body parsing.
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
  const bucketKey = `rl:${ip}:${action}:${windowStart}`;

  // Cleanup old windows (best-effort)
  try {
    await exec(`DELETE FROM rate_limits WHERE windowStart < ?`, [now - config.windowMs * 2]);
  } catch { /* ignore cleanup errors */ }

  try {
    // Insert or increment
    const existing = await queryOne<any[]>(
      `SELECT id, count FROM rate_limits WHERE bucketKey = ?`,
      [bucketKey],
    );

    if (existing) {
      if (existing.count >= config.max) {
        // Rate limited
        const retryAfter = Math.ceil((windowStart + config.windowMs - now) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        res.setHeader('X-RateLimit-Limit', String(config.max));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(Math.ceil((windowStart + config.windowMs) / 1000)));

        sendError(
          res,
          Errors.RATE_LIMITED.code,
          `${config.name}请求过于频繁，请 ${retryAfter} 秒后重试`,
          req.requestId,
          Errors.RATE_LIMITED.status,
        );
        return;
      }

      await exec(`UPDATE rate_limits SET count = count + 1 WHERE id = ?`, [existing.id]);
      res.setHeader('X-RateLimit-Limit', String(config.max));
      res.setHeader('X-RateLimit-Remaining', String(config.max - existing.count - 1));
    } else {
      await exec(
        `INSERT INTO rate_limits (id, bucketKey, windowStart, count, createdAt) VALUES (?, ?, ?, 1, ?)`,
        [ulid(), bucketKey, windowStart, now],
      );
      res.setHeader('X-RateLimit-Limit', String(config.max));
      res.setHeader('X-RateLimit-Remaining', String(config.max - 1));
    }
  } catch {
    // DB error — proceed without rate limiting
  }

  next();
}
