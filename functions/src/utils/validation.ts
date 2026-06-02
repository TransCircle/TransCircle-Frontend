import { z } from 'zod'

export const loginCodeSchema = z.object({
  loginCode: z.string().min(1, 'loginCode 不能为空'),
})

// api.md §3.1 — 投稿字段
export const contributionSchema = z.object({
  title: z.string().min(1, '标题不能为空').refine((v) => [...v].length <= 120, '标题最多 120 个字符'),
  content: z.string().min(1, '正文不能为空').refine((v) => [...v].length <= 50000, '正文最多 50000 字符'),
  contentFormat: z.enum(['markdown', 'plain_text']).default('markdown'),
  summary: z.string().refine((v) => [...v].length <= 300, '摘要最多 300 个字符').optional(),
  tags: z
    .array(z.string().refine((v) => [...v].length <= 32, '标签最多 32 个字符'))
    .max(8, '最多 8 个标签')
    .default([]),
  language: z.enum(['zh-CN', 'zh-TW', 'en', 'ja', 'other']).default('zh-CN'),
  submitMode: z.enum(['draft', 'submit']).default('submit'),
  website: z.string().optional(), // honeypot
})

// api.md §6.3 — 审核操作
export const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  expectedVersion: z.number().int().positive('version 必须为正整数'),
  internalNote: z.string().refine((v) => [...v].length <= 1000, '最多 1000 个字符').optional(),
  publicNote: z.string().refine((v) => [...v].length <= 500, '最多 500 个字符').optional(),
})

// api.md §1.6.4 — OAuth 完成注册
export const completeRegistrationSchema = z.object({
  username: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{2,31}$/, '用户名须为3-32位，小写字母开头，仅含小写字母/数字/下划线/短横线'),
  email: z.string().email('邮箱格式不正确').refine((v) => [...v].length <= 254, '邮箱最多 254 个字符'),
  password: z.string().min(12, '密码至少 12 个字符').max(128),
  displayName: z
    .string()
    .refine((v) => [...v].length >= 1 && [...v].length <= 50, '显示名称需 1-50 个字符'),
  emailMatchesProvider: z.boolean().optional(),
})

// api.md §1.1 — 注册
export const registerSchema = z.object({
  username: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{2,31}$/, '用户名须为3-32位，小写字母开头，仅含小写字母/数字/下划线/短横线'),
  email: z.string().email('邮箱格式不正确').refine((v) => [...v].length <= 254, '邮箱最多 254 个字符'),
  password: z.string().min(12, '密码至少 12 个字符').max(128),
  displayName: z
    .string()
    .refine((v) => [...v].length >= 1 && [...v].length <= 50, '显示名称需 1-50 个字符'),
})

// api.md §1.3 — 登录
export const loginSchema = z.object({
  identifier: z.string().min(3).max(254),
  password: z.string().min(12).max(128),
})

// api.md §1.4.2 — 密码重置
export const passwordResetSchema = z.object({
  token: z.string().min(1, '重置令牌不能为空'),
  newPassword: z.string().min(12, '密码至少 12 个字符').max(128),
})
