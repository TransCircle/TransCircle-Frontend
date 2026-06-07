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
 * If pagination is provided, also includes { pagination } at the top level.
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  requestId: string,
  status = 200,
  pagination?: Pagination,
  deprecation?: DeprecationInfo,
): void {
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (deprecation) {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', deprecation.sunset);
    res.setHeader('Link', `<${deprecation.migrationLink}>; rel="deprecation"`);
  }
  const body: Record<string, unknown> = { data, requestId };
  if (pagination !== undefined) {
    body.pagination = pagination;
  }
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
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const body: ApiError = {
    error: { code, message },
    requestId,
  };
  if (details !== undefined) body.error.details = details;
  if (data !== undefined) body.error.data = data;
  res.status(status).json(body);
}

/**
 * Send a 204 No Content response.
 * Removes Content-Type header since 204 has no body (per HTTP semantics).
 */
export function sendNoContent(res: Response, requestId: string): void {
  res.removeHeader('Content-Type')
  res.setHeader('X-Request-Id', requestId)
  res.status(204).end()
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
 * Deprecation info for sunset endpoints (api.md §13.5).
 * When set, adds Deprecation, Sunset, and Link response headers.
 */
export interface DeprecationInfo {
  sunset: string; // HTTP-date, e.g. "Wed, 20 Nov 2026 00:00:00 GMT"
  migrationLink: string; // e.g. "/docs/migration/v2"
}

/**
 * Convert Zod flattened errors to api.md §12.3 spec format:
 * `[{ field: "title", reason: "错误描述" }]`
 */
export function zodErrorsToDetails(errors: ReturnType<import('zod').ZodError['flatten']>): Array<{ field: string; reason: string }> {
  const details: Array<{ field: string; reason: string }> = []
  for (const [field, reasons] of Object.entries(errors.fieldErrors)) {
    if (reasons) {
      for (const reason of reasons) {
        details.push({ field, reason: reason as string })
      }
    }
  }
  if (errors.formErrors.length > 0) {
    for (const reason of errors.formErrors) {
      details.push({ field: '_form', reason: reason as string })
    }
  }
  return details
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
  CONTENT_TOO_LARGE: { code: 'CONTENT_TOO_LARGE', message: '内容过大', status: 413 },
  UNSUPPORTED_MEDIA_TYPE: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '不支持的媒体类型', status: 415 },

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
  ACCOUNT_DELETED: { code: 'ACCOUNT_DELETED', message: '账户已被注销', status: 404 },
  ACCOUNT_LOCKED: { code: 'ACCOUNT_LOCKED', message: '账户已锁定，请 15 分钟后重试', status: 423 },
  PASSKEY_VERIFICATION_FAILED: { code: 'PASSKEY_VERIFICATION_FAILED', message: 'Passkey 验证失败', status: 422 },
  PASSKEY_ALREADY_REGISTERED: { code: 'PASSKEY_ALREADY_REGISTERED', message: 'Passkey 已注册', status: 409 },
  PASSKEY_NAME_TAKEN: { code: 'PASSKEY_NAME_TAKEN', message: 'Passkey 名称已存在', status: 409 },
  PASSKEY_REPLAY_DETECTED: { code: 'PASSKEY_REPLAY_DETECTED', message: 'Passkey 回放检测', status: 422 },
  PASSKEY_FROZEN: { code: 'PASSKEY_FROZEN', message: 'Passkey 已冻结', status: 403 },
  INVALID_TOTP_CODE: { code: 'INVALID_TOTP_CODE', message: '验证码错误', status: 422 },
  TOTP_CODE_REPLAY: { code: 'TOTP_CODE_REPLAY', message: '验证码已被使用', status: 422 },
  TOTP_ALREADY_ENABLED: { code: 'TOTP_ALREADY_ENABLED', message: 'TOTP 已启用', status: 409 },
  TOTP_NOT_ENABLED: { code: 'TOTP_NOT_ENABLED', message: 'TOTP 未启用', status: 404 },
  MFA_CHALLENGE_EXHAUSTED: { code: 'MFA_CHALLENGE_EXHAUSTED', message: '验证尝试次数过多', status: 429 },
  BAD_STATE: { code: 'BAD_STATE', message: 'OAuth state 校验失败', status: 400 },
  OAUTH_ERROR: { code: 'OAUTH_ERROR', message: 'OAuth 提供商返回错误', status: 400 },
  PKCE_VERIFICATION_FAILED: { code: 'PKCE_VERIFICATION_FAILED', message: 'PKCE 验证失败', status: 422 },

  // ── Resource ──
  NOT_FOUND: { code: 'NOT_FOUND', message: '资源不存在', status: 404 },
  CONTRIBUTION_NOT_FOUND: { code: 'CONTRIBUTION_NOT_FOUND', message: '投稿不存在', status: 404 },
  EDIT_REQUEST_NOT_FOUND: { code: 'EDIT_REQUEST_NOT_FOUND', message: '修改申请不存在', status: 404 },
  USER_NOT_FOUND: { code: 'USER_NOT_FOUND', message: '用户不存在', status: 404 },
  SESSION_NOT_FOUND: { code: 'SESSION_NOT_FOUND', message: '会话不存在', status: 404 },
  PASSKEY_NOT_FOUND: { code: 'PASSKEY_NOT_FOUND', message: 'Passkey 不存在', status: 404 },
  IMAGE_NOT_FOUND: { code: 'IMAGE_NOT_FOUND', message: '图片不存在', status: 404 },
  ROLE_NOT_FOUND: { code: 'ROLE_NOT_FOUND', message: '角色不存在', status: 404 },
  EMAIL_NOT_FOUND: { code: 'EMAIL_NOT_FOUND', message: '邮箱未注册', status: 404 },
  EMAIL_ALREADY_VERIFIED: { code: 'EMAIL_ALREADY_VERIFIED', message: '邮箱已验证', status: 409 },
  OAUTH_NOT_BOUND: { code: 'OAUTH_NOT_BOUND', message: '该 provider 未绑定', status: 404 },
  INVALID_IMAGE: { code: 'INVALID_IMAGE', message: '图片无效', status: 422 },

  // ── Conflict / State ──
  CONFLICT: { code: 'CONFLICT', message: '资源冲突', status: 409 },
  VERSION_CONFLICT: { code: 'VERSION_CONFLICT', message: '版本冲突，请刷新后重试', status: 409 },
  INVALID_STATE_TRANSITION: { code: 'INVALID_STATE_TRANSITION', message: '当前状态不允许该操作', status: 409 },
  USERNAME_TAKEN: { code: 'USERNAME_TAKEN', message: '用户名已被使用', status: 409 },
  EMAIL_TAKEN: { code: 'EMAIL_TAKEN', message: '该邮箱已被注册', status: 409 },
  OAUTH_ALREADY_LINKED: { code: 'OAUTH_ALREADY_LINKED', message: '该 OAuth 账号已被其他账号绑定', status: 409 },
  ALREADY_BOUND_TO_SELF: { code: 'ALREADY_BOUND_TO_SELF', message: '该 OAuth 账号已绑定到当前用户', status: 409 },
  PROVIDER_ALREADY_BOUND: { code: 'PROVIDER_ALREADY_BOUND', message: '当前账户在该 provider 下已有绑定', status: 409 },
  IDEMPOTENCY_KEY_MISMATCH: { code: 'IDEMPOTENCY_KEY_MISMATCH', message: 'Idempotency-Key 冲突', status: 409 },
  DUPLICATE_SUBMISSION: { code: 'DUPLICATE_SUBMISSION', message: '重复提交', status: 409 },
  LAST_LOGIN_METHOD: { code: 'LAST_LOGIN_METHOD', message: '解绑后无登录方式', status: 409 },
  ROLE_ALREADY_GRANTED: { code: 'ROLE_ALREADY_GRANTED', message: '用户已拥有该角色', status: 409 },
  ALREADY_VOTED: { code: 'ALREADY_VOTED', message: '已投过票', status: 409 },
  SELF_VOTE_FORBIDDEN: { code: 'SELF_VOTE_FORBIDDEN', message: '不可对自己的申请投票', status: 409 },
  CONTRIBUTION_NOT_EDITABLE: { code: 'CONTRIBUTION_NOT_EDITABLE', message: '投稿不可编辑', status: 409 },

  // ── External ──
  OAUTH_PROVIDER_ERROR: { code: 'OAUTH_PROVIDER_ERROR', message: 'OAuth 提供商不可用', status: 502 },
} as const;
