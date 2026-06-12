import { z } from 'zod'

/**
 * Password validation per api.md §1.1:
 * - Length 12-128 Unicode characters
 * - At least 3 of 4 categories: uppercase, lowercase, digits, symbols
 * - Must not contain username or email local part (case-insensitive)
 */
export function validatePassword(password: string, username?: string, email?: string): string | null {
  if ([...password].length < 12) return '密码至少 12 个字符'
  if ([...password].length > 128) return '密码最多 128 个字符'

  const hasUpper = /[A-Z]/.test(password)
  const hasLower = /[a-z]/.test(password)
  const hasDigit = /[0-9]/.test(password)
  const hasSymbol = /[^a-zA-Z0-9]/.test(password)

  const categories = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length
  if (categories < 3) {
    return '密码必须包含大写字母、小写字母、数字、符号中的至少 3 类'
  }

  if (username) {
    const lowerPwd = password.toLowerCase()
    if (lowerPwd.includes(username.toLowerCase())) {
      return '密码不能包含用户名'
    }
  }

  if (email) {
    const localPart = email.split('@')[0]
    if (localPart) {
      const lowerPwd = password.toLowerCase()
      if (lowerPwd.includes(localPart.toLowerCase())) {
        return '密码不能包含邮箱地址'
      }
    }
  }

  return null
}

/** Shared base for register/complete-registration schemas. */
const usernameField = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{2,31}$/, '用户名须为3-32位，小写字母开头，仅含小写字母/数字/下划线/短横线')
const emailField = z.string().email('邮箱格式不正确').refine((v) => [...v].length <= 254, '邮箱最多 254 个字符')
const displayNameField = z
  .string()
  .refine((v) => [...v].length >= 1 && [...v].length <= 50, '显示名称需 1-50 个字符')

export const loginCodeSchema = z.object({
  loginCode: z.string().min(1, 'loginCode 不能为空'),
})

// api.md §3.1 — 投稿字段
export const contributionSchema = z.object({
  title: z.string().min(1, '标题不能为空').refine((v) => [...v].length <= 120, '标题最多 120 个字符'),
  content: z.string().min(1, '正文不能为空').refine((v) => [...v].length <= 50000, '正文最多 50000 字符'),
  contentFormat: z.enum(['markdown', 'plain_text']),
  summary: z.string().refine((v) => [...v].length <= 300, '摘要最多 300 个字符').optional(),
  tags: z
    .array(z.string().refine((v) => [...v].length >= 1 && [...v].length <= 32, '标签须 1-32 个字符'))
    .max(8, '最多 8 个标签')
    .default([]),
  language: z.enum(['zh-CN', 'zh-TW', 'en', 'ja', 'other']).default('zh-CN'),
  submitMode: z.enum(['draft', 'submit']).default('submit'),
})

// api.md §6.3 — 审核操作（支持 approved / rejected / in_review 过渡）
export const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']).optional(),
  toStatus: z.enum(['in_review']).optional(),
  expectedVersion: z.number().int().positive('version 必须为正整数'),
  internalNote: z.string().refine((v) => [...v].length <= 1000, '最多 1000 个字符').nullable().optional(),
  publicNote: z.string().refine((v) => [...v].length <= 500, '最多 500 个字符').nullable().optional(),
}).refine(
  (data) => data.decision !== undefined || data.toStatus !== undefined,
  { message: 'decision 或 toStatus 必填一项', path: ['decision'] },
)

/** Password field with base validation (Unicode char count per api.md). */
const passwordField = z.string()
  .refine((v) => [...v].length >= 12, '密码至少 12 个字符')
  .refine((v) => [...v].length <= 128, '密码最多 128 个字符')

// api.md §1.6.4 — OAuth 完成注册
export const completeRegistrationSchema = z.object({
  username: usernameField,
  email: emailField,
  password: passwordField,
  displayName: displayNameField,
  emailMatchesProvider: z.boolean().optional().default(true),
}).superRefine((data, ctx) => {
  const err = validatePassword(data.password, data.username, data.email)
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err, path: ['password'] })
})

// api.md §1.1 — 注册
export const registerSchema = z.object({
  username: usernameField,
  email: emailField,
  password: passwordField,
  displayName: displayNameField,
}).superRefine((data, ctx) => {
  const err = validatePassword(data.password, data.username, data.email)
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err, path: ['password'] })
})

// api.md §1.3 — 登录
export const loginSchema = z.object({
  identifier: z.string().min(3).max(254),
  password: z.string()
    .refine((v) => [...v].length >= 12, '密码至少 12 个字符')
    .refine((v) => [...v].length <= 128, '密码最多 128 个字符'),
})

// api.md §1.4.2 — 密码重置（含密码复杂规则校验）
export const passwordResetSchema = z.object({
  token: z.string().min(1, '重置令牌不能为空'),
  newPassword: passwordField,
}).superRefine((data, ctx) => {
  const err = validatePassword(data.newPassword)
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err, path: ['newPassword'] })
})
