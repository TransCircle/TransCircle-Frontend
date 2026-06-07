import type { Request, Response, NextFunction } from 'express';
import { conf } from '../Config';

const corsConf = conf.CORS as Record<string, string | undefined> | undefined;
const rawOrigins = corsConf?.ALLOWED_ORIGINS as string | undefined;
const appConf = conf.APP as Record<string, string | undefined> | undefined;
const frontendUrl = appConf?.FRONTEND_URL || '';
const isProduction = !frontendUrl.includes('localhost') && !frontendUrl.includes('127.0.0.1');

const ALLOWED_ORIGINS: string[] = rawOrigins
  ? rawOrigins.split(',').map((s) => s.trim()).filter(Boolean)
  : isProduction
    ? [frontendUrl || 'https://submit.transcircle.org']
    : ['http://localhost:5173', 'http://localhost:4173'];

export function corsHandler(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-Requested-With');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.removeHeader('Content-Type');
    res.status(204).end();
    return;
  }

  next();
}
