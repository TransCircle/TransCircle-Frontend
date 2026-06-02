import type { Request, Response, NextFunction } from 'express';
import { verifyJwt } from '../utils/jwt';
import { getValidSession } from '../utils/session';
import { sendError, Errors } from '../utils/response';
import { conf } from '../Config';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        sessionId: string;
        tokenVersion: number;
        isAdmin: boolean;
      };
    }
  }
}

/**
 * Requires a valid JWT Bearer token.
 * Sets req.user on success.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, Errors.UNAUTHORIZED.code, Errors.UNAUTHORIZED.message, req.requestId, Errors.UNAUTHORIZED.status);
    return;
  }

  const token = authHeader.slice(7);

  // Allow temp admin token to bypass JWT verification
  const adminConf = conf.ADMIN as Record<string, string | undefined> | undefined;
  const adminToken = adminConf?.TEMP_ADMIN_TOKEN as string | undefined;
  if (adminToken && token === adminToken) {
    req.user = {
      userId: 'temp-admin',
      sessionId: 'temp-admin',
      tokenVersion: 0,
      isAdmin: true,
    };
    next();
    return;
  }

  const payload = await verifyJwt(token);
  if (!payload) {
    sendError(res, Errors.UNAUTHORIZED.code, '登录已过期，请重新登录', req.requestId, Errors.UNAUTHORIZED.status);
    return;
  }

  // Verify session is still valid
  const valid = await getValidSession(payload.sessionId, payload.sub, payload.tokenVersion);
  if (!valid) {
    sendError(res, Errors.UNAUTHORIZED.code, '会话已失效，请重新登录', req.requestId, Errors.UNAUTHORIZED.status);
    return;
  }

  req.user = {
    userId: payload.sub,
    sessionId: payload.sessionId,
    tokenVersion: payload.tokenVersion,
    isAdmin: payload.isAdmin,
  };

  next();
}

/**
 * Optional auth — sets req.user if a valid token is present, but doesn't fail if absent.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.slice(7);
  const payload = await verifyJwt(token);
  if (payload) {
    const valid = await getValidSession(payload.sessionId, payload.sub, payload.tokenVersion);
    if (valid) {
      req.user = {
        userId: payload.sub,
        sessionId: payload.sessionId,
        tokenVersion: payload.tokenVersion,
        isAdmin: payload.isAdmin,
      };
    }
  }

  next();
}

/**
 * Requires the user to be an admin.
 * Must be used after requireAuth.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    sendError(res, Errors.UNAUTHORIZED.code, Errors.UNAUTHORIZED.message, req.requestId, Errors.UNAUTHORIZED.status);
    return;
  }

  // Check for temp admin token as alternative
  const authHeader = req.headers.authorization;
  const adminConf = conf.ADMIN as Record<string, string | undefined> | undefined;
  const adminToken = adminConf?.TEMP_ADMIN_TOKEN as string | undefined;

  if (authHeader === `Bearer ${adminToken}` && adminToken) {
    req.user.isAdmin = true;
    next();
    return;
  }

  if (!req.user.isAdmin) {
    sendError(res, Errors.FORBIDDEN.code, Errors.FORBIDDEN.message, req.requestId, Errors.FORBIDDEN.status);
    return;
  }

  next();
}
