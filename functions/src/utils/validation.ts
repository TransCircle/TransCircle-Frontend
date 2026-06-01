import { z } from 'zod';

export const loginCodeSchema = z.object({
  loginCode: z.string().min(1, 'loginCode 不能为空'),
});

export const contributionSchema = z.object({
  title: z.string().min(1, '标题不能为空').refine(v => [...v].length <= 120, '标题最多 120 个字符'),
  content: z.string().min(1, '正文不能为空').refine(v => [...v].length <= 50000, '正文最多 50000 字符'),
  contentFormat: z.enum(['markdown', 'plain_text']).default('markdown'),
  category: z.string().min(1, '分类不能为空').refine(v => [...v].length <= 50, '分类最多 50 个字符'),
  tags: z.array(z.string().refine(v => [...v].length <= 50, '标签最多 50 个字符')).max(10).default([]),
  language: z.enum(['zh-CN', 'zh-TW', 'en', 'ja', 'other']).default('zh-CN'),
  submitMode: z.enum(['draft', 'submit']).default('submit'),
  authorType: z.enum(['real', 'pen_name', 'anonymous']).default('anonymous'),
  authorName: z.string().refine(v => [...v].length <= 100, '最多 100 个字符').optional(),
  contact: z.string().refine(v => [...v].length <= 200, '最多 200 个字符').optional(),
  website: z.string().optional(), // honeypot
  idempotencyKey: z.string().refine(v => [...v].length <= 64, '最多 64 个字符').optional(),
});

export const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'request_changes']),
  expectedVersion: z.number().int().positive('version 必须为正整数'),
  internalNote: z.string().refine(v => [...v].length <= 1000, '最多 1000 个字符').optional(),
  publicNote: z.string().refine(v => [...v].length <= 500, '最多 500 个字符').optional(),
});

export const completeRegistrationSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_-]+$/, '用户名只能包含字母、数字、下划线和连字符')
    .refine(v => [...v].length >= 2 && [...v].length <= 32, {
      message: '用户名长度需 2-32 个字符',
    }),
  email: z.string().email('邮箱格式不正确').refine(v => [...v].length <= 254, '邮箱最多 254 个字符'),
  password: z.string().min(12, '密码至少 12 个字符').max(128),
  displayName: z.string().refine(v => [...v].length >= 1 && [...v].length <= 50, '显示名称需 1-50 个字符'),
  emailMatchesProvider: z.boolean().optional(),
});
