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
 * Send an error response.
 * Matches contract: { error: { code, message, details? }, requestId }
 */
export function sendError(
  res: Response,
  code: string,
  message: string,
  requestId: string,
  status = 400,
  details?: unknown,
): void {
  const body: ApiError = {
    error: { code, message },
    requestId,
  };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}

/**
 * Common error presets
 */
export const Errors = {
  UNAUTHORIZED: { code: 'UNAUTHORIZED', message: '请先登录', status: 401 },
  FORBIDDEN: { code: 'FORBIDDEN', message: '权限不足', status: 403 },
  NOT_FOUND: { code: 'NOT_FOUND', message: '资源不存在', status: 404 },
  CONFLICT: { code: 'CONFLICT', message: '资源冲突', status: 409 },
  RATE_LIMITED: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试', status: 429 },
  VALIDATION_ERROR: { code: 'VALIDATION_ERROR', message: '请求数据校验失败', status: 400 },
  INTERNAL_ERROR: { code: 'INTERNAL_ERROR', message: '服务器内部错误', status: 500 },
  GONE: { code: 'GONE', message: '资源已过期', status: 410 },
} as const;
