import type { Request, Response, NextFunction } from 'express'
import { verifyJwt } from '../utils/jwt'
import { sendError, Errors } from '../utils/response'
import { queryOne } from '../Database'
import { conf } from '../Config'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        userId: string
        sessionId: string
        tokenVersion: number
        roles: string[]
      }
    }
  }
}

/**
 * Requires a valid JWT Bearer token.
 * Sets req.user on success.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, Errors.UNAUTHORIZED.code, Errors.UNAUTHORIZED.message, req.requestId, Errors.UNAUTHORIZED.status)
    return
  }

  const token = authHeader.slice(7)

  // Allow temp admin token to bypass JWT verification
  const adminConf = conf.ADMIN as Record<string, string | undefined> | undefined
  const adminToken = adminConf?.TEMP_ADMIN_TOKEN as string | undefined
  if (adminToken && token === adminToken) {
    req.user = {
      userId: 'temp-admin',
      sessionId: 'temp-admin',
      tokenVersion: 0,
      roles: ['reviewer'],
    }
    next()
    return
  }

  const payload = await verifyJwt(token)
  if (!payload) {
    sendError(res, Errors.UNAUTHORIZED.code, '登录已过期，请重新登录', req.requestId, Errors.UNAUTHORIZED.status)
    return
  }

  // Verify session is still valid
  const session = await queryOne(
    `SELECT id, revokedAt, expiresAt FROM sessions WHERE id = ? AND userId = ?`,
    [payload.sid, payload.sub],
  )
  if (!session || session.revokedAt || session.expiresAt < Date.now()) {
    sendError(res, Errors.UNAUTHORIZED.code, '会话已失效，请重新登录', req.requestId, Errors.UNAUTHORIZED.status)
    return
  }

  // Verify tokenVersion matches
  const user = await queryOne(
    `SELECT tokenVersion FROM users WHERE id = ?`,
    [payload.sub],
  )
  if (!user || user.tokenVersion !== payload.tokenVersion) {
    sendError(res, Errors.UNAUTHORIZED.code, '登录已过期，请重新登录', req.requestId, Errors.UNAUTHORIZED.status)
    return
  }

  req.user = {
    userId: payload.sub,
    sessionId: payload.sid,
    tokenVersion: payload.tokenVersion,
    roles: payload.roles,
  }

  next()
}

/**
 * Optional auth — sets req.user if a valid token is present, but doesn't fail if absent.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    next()
    return
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token)
  if (payload) {
    const session = await queryOne(
      `SELECT id, revokedAt, expiresAt FROM sessions WHERE id = ? AND userId = ?`,
      [payload.sid, payload.sub],
    )
    if (session && !session.revokedAt && session.expiresAt >= Date.now()) {
      const user = await queryOne(
        `SELECT tokenVersion FROM users WHERE id = ?`,
        [payload.sub],
      )
      if (user && user.tokenVersion === payload.tokenVersion) {
        req.user = {
          userId: payload.sub,
          sessionId: payload.sid,
          tokenVersion: payload.tokenVersion,
          roles: payload.roles,
        }
      }
    }
  }

  next()
}

/**
 * Requires the user to have at least one of the specified roles.
 * Must be used after requireAuth.
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, Errors.UNAUTHORIZED.code, Errors.UNAUTHORIZED.message, req.requestId, Errors.UNAUTHORIZED.status)
      return
    }

    if (!req.user.roles.some((r) => allowedRoles.includes(r))) {
      sendError(res, Errors.FORBIDDEN.code, Errors.FORBIDDEN.message, req.requestId, Errors.FORBIDDEN.status)
      return
    }

    next()
  }
}

// Re-export requireAdmin as a convenience
export const requireAdmin = requireRole('reviewer')
