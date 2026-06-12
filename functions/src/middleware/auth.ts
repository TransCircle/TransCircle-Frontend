import type { Request, Response, NextFunction } from 'express'
import { verifyJwt } from '../utils/jwt'
import { sendError, Errors } from '../utils/response'
import { exec, queryOne } from '../Database'
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
 * Requires a valid JWT Bearer token or TEMP_ADMIN_TOKEN.
 * Sets req.user on success.
 */
// Lazy-ensure temp admin user exists in DB (for FK constraints in audit/review tables)
let _tempAdminEnsured = false

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, Errors.UNAUTHORIZED.code, Errors.UNAUTHORIZED.message, req.requestId, Errors.UNAUTHORIZED.status)
    return
  }

  const token = authHeader.slice(7)

  // Check TEMP_ADMIN_TOKEN (dev/debug bypass: token in memory only, not a real JWT)
  const adminConf = conf.ADMIN as Record<string, string | undefined> | undefined
  const tempAdminToken = adminConf?.TEMP_ADMIN_TOKEN as string | undefined
  if (tempAdminToken && token === tempAdminToken) {
    if (!_tempAdminEnsured) {
      await exec(
        `INSERT IGNORE INTO users (id, username, displayName, status, createdAt)
         VALUES ('usr_temp_admin', 'temp_admin', '临时管理员', 'active', UNIX_TIMESTAMP(NOW()) * 1000)`,
      )
      _tempAdminEnsured = true
    }
    req.user = {
      userId: 'usr_temp_admin',
      sessionId: 'sess_temp_admin',
      tokenVersion: 0,
      roles: ['admin', 'reviewer'],
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

  // Verify tokenVersion matches and user status is allowed
  const user = await queryOne(
    `SELECT tokenVersion, status FROM users WHERE id = ?`,
    [payload.sub],
  )
  if (!user || user.tokenVersion !== payload.tokenVersion) {
    sendError(res, Errors.UNAUTHORIZED.code, '登录已过期，请重新登录', req.requestId, Errors.UNAUTHORIZED.status)
    return
  }
  // Per api.md §1.1 user status table — each status gets its own error code
  if (user.status !== 'active' && user.status !== 'pending_verification') {
    switch (user.status) {
      case 'banned':
        sendError(res, Errors.ACCOUNT_BANNED.code, Errors.ACCOUNT_BANNED.message, req.requestId, Errors.ACCOUNT_BANNED.status)
        return
      case 'merged':
        sendError(res, Errors.ACCOUNT_MERGED.code, Errors.ACCOUNT_MERGED.message, req.requestId, Errors.ACCOUNT_MERGED.status)
        return
      case 'pending_deletion':
        sendError(res, Errors.ACCOUNT_PENDING_DELETION.code, Errors.ACCOUNT_PENDING_DELETION.message, req.requestId, Errors.ACCOUNT_PENDING_DELETION.status)
        return
      case 'deleted':
        sendError(res, Errors.ACCOUNT_DELETED.code, Errors.ACCOUNT_DELETED.message, req.requestId, Errors.ACCOUNT_DELETED.status)
        return
      default:
        sendError(res, Errors.UNAUTHORIZED.code, '账户状态异常，无法访问', req.requestId, Errors.UNAUTHORIZED.status)
        return
    }
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
        `SELECT tokenVersion, status FROM users WHERE id = ?`,
        [payload.sub],
      )
      if (user && user.tokenVersion === payload.tokenVersion && (user.status === 'active' || user.status === 'pending_verification')) {
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

/**
 * 要求用户拥有 reviewer 或 admin 角色。
 * admin 具有全部 reviewer 权限（api.md §15.10 权限映射）。
 */
export const requireReviewer = requireRole('reviewer', 'admin')
/** 同 requireReviewer — admin 角色也可通过 */
export const requireAdmin = requireReviewer
