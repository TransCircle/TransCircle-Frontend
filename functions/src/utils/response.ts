import type { Response } from 'express';

export interface ApiSuccess<T = unknown> {
  data: T;
  requestId: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
    data?: unknown; // per api.md §12.3: structured metadata (mergeToken, nextAction, etc.)
  };
  requestId: string;
}

/**
 * Send a success response with data.
 * Matches contract: { data, requestId }
 */
export function sendSuccess<T>(res: Response, data: T, requestId: string, status = 200): void {
  const body: ApiSuccess<T> = { data, requestId };
  res.status(status).json(body);
}

/**
 * Send an error response with optional details and/or extra data.
 * Matches contract: { error: { code, message, details?, data? }, requestId }
 */
export function sendError(
  res: Response,
  code: string,
  message: string,
  requestId: string,
  status = 400,
  details?: unknown,
  data?: unknown,
): void {
  const body: ApiError = {
    error: { code, message },
    requestId,
  };
  if (details !== undefined) body.error.details = details;
  if (data !== undefined) body.error.data = data;
  res.status(status).json(body);
}

/**
 * List pagination envelope (per api.md §12.2)
 */
export interface Pagination {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Common error presets — spec-specific codes (per api.md §12.4)
 */
export const Errors = {
  // ── Generic ──
  UNAUTHORIZED: { code: 'UNAUTHORIZED', message: '请先登录', status: 401 },
  FORBIDDEN: { code: 'FORBIDDEN', message: '权限不足', status: 403 },
  VALIDATION_ERROR: { code: 'VALIDATION_ERROR', message: '请求数据校验失败', status: 422 },
  RATE_LIMITED: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试', status: 429 },
  INTERNAL_ERROR: { code: 'INTERNAL_ERROR', message: '服务器内部错误', status: 500 },
  BAD_REQUEST: { code: 'BAD_REQUEST', message: '请求格式错误', status: 400 },

  // ── Auth / Token ──
  INVALID_CREDENTIALS: { code: 'INVALID_CREDENTIALS', message: '用户名/邮箱或密码错误', status: 401 },
  INVALID_REFRESH_TOKEN: { code: 'INVALID_REFRESH_TOKEN', message: '刷新令牌无效', status: 401 },
  REFRESH_TOKEN_REVOKED: { code: 'REFRESH_TOKEN_REVOKED', message: '刷新令牌已被吊销', status: 401 },
  TOKEN_INVALID_OR_EXPIRED: { code: 'TOKEN_INVALID_OR_EXPIRED', message: '令牌无效或已过期', status: 410 },
  CSRF_TOKEN_INVALID: { code: 'CSRF_TOKEN_INVALID', message: 'CSRF 校验失败', status: 403 },
  MISSING_OAUTH_PENDING: { code: 'MISSING_OAUTH_PENDING', message: '缺少 OAuth pending cookie', status: 401 },
  STEP_UP_REQUIRED: { code: 'STEP_UP_REQUIRED', message: '需要二次认证', status: 403 },
  EMAIL_NOT_VERIFIED: { code: 'EMAIL_NOT_VERIFIED', message: '邮箱未验证', status: 403 },
  ACCOUNT_BANNED: { code: 'ACCOUNT_BANNED', message: '账户已被封禁', status: 403 },
  ACCOUNT_MERGED: { code: 'ACCOUNT_MERGED', message: '账户已合并', status: 403 },
  ACCOUNT_PENDING_DELETION: { code: 'ACCOUNT_PENDING_DELETION', message: '账户正在注销', status: 403 },

  // ── Resource ──
  NOT_FOUND: { code: 'NOT_FOUND', message: '资源不存在', status: 404 },
  CONTRIBUTION_NOT_FOUND: { code: 'CONTRIBUTION_NOT_FOUND', message: '投稿不存在', status: 404 },
  USER_NOT_FOUND: { code: 'USER_NOT_FOUND', message: '用户不存在', status: 404 },

  // ── Conflict ──
  CONFLICT: { code: 'CONFLICT', message: '资源冲突', status: 409 },
  VERSION_CONFLICT: { code: 'VERSION_CONFLICT', message: '版本冲突，请刷新后重试', status: 409 },
  USERNAME_TAKEN: { code: 'USERNAME_TAKEN', message: '用户名已被使用', status: 409 },
  EMAIL_TAKEN: { code: 'EMAIL_TAKEN', message: '该邮箱已被注册', status: 409 },
  OAUTH_ALREADY_LINKED: { code: 'OAUTH_ALREADY_LINKED', message: '该 OAuth 账号已被其他账号绑定', status: 409 },
  PROVIDER_ALREADY_BOUND: { code: 'PROVIDER_ALREADY_BOUND', message: '当前账户在该 provider 下已有绑定', status: 409 },
  IDEMPOTENCY_KEY_MISMATCH: { code: 'IDEMPOTENCY_KEY_MISMATCH', message: 'Idempotency-Key 冲突', status: 409 },

  // ── External ──
  OAUTH_PROVIDER_ERROR: { code: 'OAUTH_PROVIDER_ERROR', message: 'OAuth 提供商不可用', status: 502 },
} as const;
