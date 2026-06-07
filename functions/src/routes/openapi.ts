import { Router } from 'express'
import { sendSuccess } from '../utils/response'

const router: Router = Router()

// GET /v1/openapi.json — api.md §13.4
router.get('/openapi.json', (_req, res) => {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'TransCircle API',
      version: '1.0.0',
      description: '投稿 API 接口 — 第四版规范。\n\nBase URL: https://api.transcircle.org\n认证方式: Bearer Token + JWT',
    },
    servers: [
      { url: 'https://api.transcircle.org', description: 'Production' },
      { url: 'https://sandbox-api.transcircle.org', description: 'Sandbox' },
    ],
    paths: {
      '/v1/auth/register': {
        post: {
          summary: '用户注册',
          tags: ['Auth'],
          operationId: 'authRegister',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterRequest' } } },
          },
          responses: {
            '201': { description: '注册成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterResponse' } } } },
            '409': { description: '用户名/邮箱已被占用', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
            '422': { description: '字段校验失败', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } } },
            '429': { description: '触发限流', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          },
        },
      },
      '/v1/auth/email/verify': {
        post: { summary: '验证邮箱', tags: ['Auth'], operationId: 'emailVerify' },
      },
      '/v1/auth/email/resend': {
        post: { summary: '重发验证邮件', tags: ['Auth'], operationId: 'emailResend' },
      },
      '/v1/auth/login': {
        post: {
          summary: '密码登录',
          tags: ['Auth'],
          operationId: 'authLogin',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
          },
          responses: {
            '200': { description: '登录成功或需要 MFA', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            '401': { description: '凭据错误', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
            '423': { description: '账户锁定', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          },
        },
      },
      '/v1/auth/password/forgot': {
        post: { summary: '发起密码重置', tags: ['Auth'], operationId: 'passwordForgot' },
      },
      '/v1/auth/password/reset': {
        post: { summary: '提交新密码', tags: ['Auth'], operationId: 'passwordReset' },
      },
      '/v1/me/password': {
        post: { summary: '修改密码', tags: ['Auth'], operationId: 'changePassword' },
      },
      '/v1/auth/refresh': {
        post: {
          summary: '刷新 Access Token',
          tags: ['Auth'],
          operationId: 'refreshToken',
          responses: {
            '200': { description: '刷新成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/RefreshResponse' } } } },
          },
        },
      },
      '/v1/auth/logout': {
        post: { summary: '退出当前会话', tags: ['Auth'], operationId: 'logout', responses: { '204': { description: '成功' } } },
      },
      '/v1/auth/logout-all': {
        post: { summary: '退出全部会话', tags: ['Auth'], operationId: 'logoutAll' },
      },
      '/v1/auth/session': {
        get: { summary: '获取当前会话信息', tags: ['Auth'], operationId: 'getSession' },
      },
      '/v1/me/sessions': {
        get: { summary: '列出活跃会话', tags: ['Auth'], operationId: 'listSessions' },
        delete: { summary: '吊销指定 session', tags: ['Auth'], operationId: 'revokeSession' },
      },
      '/v1/auth/oauth/github/start': {
        get: { summary: '发起 GitHub OAuth 授权', tags: ['OAuth'], operationId: 'oauthGithubStart' },
      },
      '/v1/auth/oauth/github/callback': {
        get: { summary: 'GitHub OAuth 回调', tags: ['OAuth'], operationId: 'oauthGithubCallback' },
      },
      '/v1/auth/oauth/x/start': {
        get: { summary: '发起 X OAuth 授权', tags: ['OAuth'], operationId: 'oauthXStart' },
      },
      '/v1/auth/oauth/x/callback': {
        get: { summary: 'X OAuth 回调', tags: ['OAuth'], operationId: 'oauthXCallback' },
      },
      '/v1/auth/oauth/exchange': {
        post: { summary: '兑换登录结果', tags: ['OAuth'], operationId: 'oauthExchange' },
      },
      '/v1/auth/oauth/complete-registration': {
        post: { summary: 'OAuth 完成密码注册', tags: ['OAuth'], operationId: 'oauthCompleteRegistration' },
      },
      '/v1/auth/oauth/complete-binding': {
        post: { summary: 'OAuth 绑定到当前账号', tags: ['OAuth'], operationId: 'oauthCompleteBinding' },
      },
      '/v1/auth/oauth/pending-profile': {
        get: { summary: '拉取 OAuth 补全预填信息', tags: ['OAuth'], operationId: 'oauthPendingProfile' },
      },
      '/v1/auth/oauth/native/start': {
        post: { summary: '原生端发起 OAuth 授权 (PKCE)', tags: ['OAuth'], operationId: 'oauthNativeStart' },
      },
      '/v1/auth/oauth/native/exchange': {
        post: { summary: '原生端兑换 OAuth 回调', tags: ['OAuth'], operationId: 'oauthNativeExchange' },
      },
      '/v1/auth/oauth/native/complete-registration': {
        post: { summary: '原生端完成密码注册并绑定', tags: ['OAuth'], operationId: 'oauthNativeCompleteRegistration' },
      },
      '/v1/auth/oauth/native/complete-binding': {
        post: { summary: '原生端绑定 OAuth 到当前账号', tags: ['OAuth'], operationId: 'oauthNativeCompleteBinding' },
      },
      '/v1/auth/merge': {
        post: { summary: '账号合并', tags: ['Auth'], operationId: 'accountMerge' },
      },
      '/v1/me/mfa/totp/setup': {
        post: {
          summary: '开始设置 TOTP',
          tags: ['MFA'],
          operationId: 'totpSetup',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: '成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/TotpSetupResponse' } } } },
          },
        },
      },
      '/v1/me/mfa/totp/enable': {
        post: { summary: '确认并启用 TOTP', tags: ['MFA'], operationId: 'totpEnable' },
      },
      '/v1/me/mfa/totp': {
        delete: { summary: '禁用 TOTP', tags: ['MFA'], operationId: 'totpDisable' },
      },
      '/v1/auth/mfa/totp/verify': {
        post: { summary: 'MFA 登录验证', tags: ['MFA'], operationId: 'mfaTotpVerify' },
      },
      '/v1/me/mfa/recovery-codes/regenerate': {
        post: { summary: '重新生成恢复码', tags: ['MFA'], operationId: 'recoveryCodesRegenerate' },
      },
      '/v1/me/passkeys/register/start': {
        post: { summary: '开始注册 Passkey', tags: ['Passkey'], operationId: 'passkeyRegisterStart' },
      },
      '/v1/me/passkeys/register/finish': {
        post: { summary: '完成 Passkey 注册', tags: ['Passkey'], operationId: 'passkeyRegisterFinish' },
      },
      '/v1/me/passkeys': {
        get: { summary: '查看已注册 Passkey 列表', tags: ['Passkey'], operationId: 'listPasskeys' },
      },
      '/v1/me/passkeys/{id}': {
        delete: { summary: '删除 Passkey', tags: ['Passkey'], operationId: 'deletePasskey' },
      },
      '/v1/auth/passkey/login/start': {
        post: { summary: 'Passkey 登录 — 开始', tags: ['Passkey'], operationId: 'passkeyLoginStart' },
      },
      '/v1/auth/passkey/login/finish': {
        post: { summary: 'Passkey 登录 — 完成', tags: ['Passkey'], operationId: 'passkeyLoginFinish' },
      },
      '/v1/auth/step-up/start': {
        post: { summary: '发起 Step-up 再认证', tags: ['Auth'], operationId: 'stepUpStart' },
      },
      '/v1/auth/step-up/verify': {
        post: { summary: '完成 Step-up 验证', tags: ['Auth'], operationId: 'stepUpVerify' },
      },
      '/v1/me': {
        get: {
          summary: '获取当前用户资料',
          tags: ['User'],
          operationId: 'getProfile',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: '成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserProfile' } } } },
          },
        },
        patch: {
          summary: '更新当前用户资料',
          tags: ['User'],
          operationId: 'updateProfile',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties: { displayName: { type: 'string', maxLength: 50 }, avatarUrl: { type: 'string', nullable: true } } } } },
          },
          responses: {
            '200': { description: '更新成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserProfile' } } } },
          },
        },
      },
      '/v1/me/oauth': {
        get: { summary: '查询 OAuth 绑定状态', tags: ['OAuth'], operationId: 'listOAuthBinds' },
      },
      '/v1/me/oauth/{provider}': {
        delete: { summary: '解绑 OAuth 账号', tags: ['OAuth'], operationId: 'unbindOAuth' },
      },
      '/v1/me/oauth/github/bind/start': {
        get: { summary: '发起 GitHub 绑定', tags: ['OAuth'], operationId: 'githubBindStart' },
      },
      '/v1/me/oauth/x/bind/start': {
        get: { summary: '发起 X 绑定', tags: ['OAuth'], operationId: 'xBindStart' },
      },
      '/v1/me/export': {
        post: { summary: '导出我的数据 (GDPR)', tags: ['User'], operationId: 'exportData' },
      },
      '/v1/me/delete': {
        post: { summary: '注销账户 (GDPR)', tags: ['User'], operationId: 'deleteAccount' },
      },
      '/v1/me/delete/cancel': {
        post: { summary: '撤销账户注销', tags: ['User'], operationId: 'cancelDelete' },
      },
      '/v1/me/contributions': {
        get: { summary: '获取我的投稿列表', tags: ['Contributions'], operationId: 'myContributions' },
      },
      '/v1/me/contributions/{id}': {
        get: { summary: '获取我的投稿详情', tags: ['Contributions'], operationId: 'myContributionDetail' },
        patch: { summary: '修改草稿', tags: ['Contributions'], operationId: 'updateDraft' },
      },
      '/v1/me/contributions/{id}/submit': {
        post: { summary: '提交草稿', tags: ['Contributions'], operationId: 'submitContribution' },
      },
      '/v1/me/contributions/{id}/withdraw': {
        post: { summary: '撤回投稿', tags: ['Contributions'], operationId: 'withdrawContribution' },
      },
      '/v1/contributions': {
        post: {
          summary: '提交投稿',
          tags: ['Contributions'],
          operationId: 'createContribution',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ContributionRequest' } } },
          },
          responses: {
            '201': { description: '创建成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/ContributionCreateResponse' } } } },
            '403': { description: '权限不足/邮箱未验证', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          },
        },
      },
      '/v1/contributions/{id}/edit-requests': {
        post: { summary: '提交修改申请', tags: ['EditRequests'], operationId: 'createEditRequest' },
      },
      '/v1/me/edit-requests': {
        get: { summary: '查看我的修改申请列表', tags: ['EditRequests'], operationId: 'myEditRequests' },
      },
      '/v1/me/edit-requests/{id}/withdraw': {
        post: { summary: '撤回修改申请', tags: ['EditRequests'], operationId: 'withdrawEditRequest' },
      },
      '/v1/public/contributions': {
        get: { summary: '公开展示 — 列表', tags: ['Public'], operationId: 'publicContributions' },
      },
      '/v1/public/contributions/{id}': {
        get: { summary: '公开展示 — 详情', tags: ['Public'], operationId: 'publicContributionDetail' },
      },
      '/v1/images': {
        post: { summary: '上传图片', tags: ['Images'], operationId: 'uploadImage' },
      },
      '/v1/images/{id}': {
        get: { summary: '查看图片', tags: ['Images'], operationId: 'getImage' },
      },
      '/v1/admin/contributions': {
        get: { summary: '审核后台 — 投稿列表', tags: ['Admin'], operationId: 'adminContributions' },
      },
      '/v1/admin/contributions/stats': {
        get: { summary: '审核后台 — 统计', tags: ['Admin'], operationId: 'adminStats' },
      },
      '/v1/admin/contributions/{id}': {
        get: { summary: '审核后台 — 投稿详情', tags: ['Admin'], operationId: 'adminContributionDetail' },
      },
      '/v1/admin/contributions/{id}/review': {
        post: { summary: '审核投稿', tags: ['Admin'], operationId: 'reviewContribution' },
      },
      '/v1/admin/contributions/{id}/publish': {
        post: { summary: '发布投稿', tags: ['Admin'], operationId: 'publishContribution' },
      },
      '/v1/admin/contributions/{id}/hide': {
        post: { summary: '隐藏投稿', tags: ['Admin'], operationId: 'hideContribution' },
      },
      '/v1/admin/contributions/{id}/restore': {
        post: { summary: '恢复投稿', tags: ['Admin'], operationId: 'restoreContribution' },
      },
      '/v1/admin/contributions/{id}/delete': {
        post: { summary: '删除投稿', tags: ['Admin'], operationId: 'adminDeleteContribution' },
      },
      '/v1/admin/contributions/{id}/review-events': {
        get: { summary: '审核事件历史', tags: ['Admin'], operationId: 'reviewEvents' },
      },
      '/v1/admin/users': {
        get: { summary: '用户列表', tags: ['Admin'], operationId: 'adminUsers' },
      },
      '/v1/admin/users/{id}': {
        get: { summary: '用户详情', tags: ['Admin'], operationId: 'adminUserDetail' },
      },
      '/v1/admin/users/{id}/ban': {
        post: { summary: '封禁用户', tags: ['Admin'], operationId: 'banUser' },
      },
      '/v1/admin/users/{id}/unban': {
        post: { summary: '解封用户', tags: ['Admin'], operationId: 'unbanUser' },
      },
      '/v1/admin/users/{id}/roles': {
        post: { summary: '授予角色', tags: ['Admin'], operationId: 'grantRole' },
      },
      '/v1/admin/users/{id}/roles/{roleId}': {
        delete: { summary: '撤销角色', tags: ['Admin'], operationId: 'revokeRole' },
      },
      '/v1/admin/audit-logs': {
        get: { summary: '审计日志', tags: ['Admin'], operationId: 'auditLogs' },
      },
      '/v1/admin/edit-requests': {
        get: { summary: '审核员查看修改申请列表', tags: ['Admin'], operationId: 'adminEditRequests' },
      },
      '/v1/admin/edit-requests/{id}': {
        get: { summary: '审核员查看修改申请详情', tags: ['Admin'], operationId: 'adminEditRequestDetail' },
      },
      '/v1/admin/edit-requests/{id}/vote': {
        post: { summary: '审核员投票', tags: ['Admin'], operationId: 'voteEditRequest' },
      },
      '/v1/stories/published': {
        get: { summary: '已发布投稿（Story 站点格式）', tags: ['Public'], operationId: 'publishedStories' },
      },
      '/healthz': {
        get: { summary: '健康检查（轻量）', tags: ['Ops'], operationId: 'healthz' },
      },
      '/readyz': {
        get: { summary: '就绪检查（含 DB）', tags: ['Ops'], operationId: 'readyz' },
      },
      '/metrics': {
        get: { summary: 'Prometheus 指标', tags: ['Ops'], operationId: 'metrics' },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Bearer Token（JWT），有效期 15 分钟',
        },
      },
      schemas: {
        // ── 统一响应信封 ──
        ApiSuccess: {
          type: 'object',
          required: ['data', 'requestId'],
          properties: {
            data: { description: '响应数据' },
            requestId: { type: 'string', example: 'req_01HZYC8AA4V7J9M2C3K5N6P7Q8' },
            pagination: { $ref: '#/components/schemas/Pagination' },
          },
        },
        ApiError: {
          type: 'object',
          required: ['error', 'requestId'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string', example: '请求数据校验失败' },
                details: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ErrorDetail' },
                },
                data: { description: '结构化附加数据（如 mergeToken, nextAction）' },
              },
            },
            requestId: { type: 'string', example: 'req_01HZYC8AA4V7J9M2C3K5N6P7Q8' },
          },
        },
        ValidationError: {
          type: 'object',
          required: ['error', 'requestId'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'details'],
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string', example: '请求数据校验失败' },
                details: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ErrorDetail' },
                },
              },
            },
            requestId: { type: 'string' },
          },
        },
        ErrorDetail: {
          type: 'object',
          required: ['field', 'reason'],
          properties: {
            field: { type: 'string', example: 'password' },
            reason: { type: 'string', example: '密码至少 12 个字符' },
          },
        },
        Pagination: {
          type: 'object',
          required: ['limit', 'nextCursor', 'hasMore'],
          properties: {
            limit: { type: 'integer', example: 20 },
            nextCursor: { type: 'string', nullable: true, example: 'MTcxNjE2MzIwMDAwMA' },
            hasMore: { type: 'boolean', example: false },
          },
        },

        // ── Auth ──
        RegisterRequest: {
          type: 'object',
          required: ['username', 'email', 'password', 'displayName'],
          properties: {
            username: { type: 'string', pattern: '^[a-z][a-z0-9_-]{2,31}$', example: 'alice123' },
            email: { type: 'string', format: 'email', maxLength: 254, example: 'alice@example.com' },
            password: { type: 'string', minLength: 12, maxLength: 128, example: 'Strong@Passw0rd_2026!' },
            displayName: { type: 'string', minLength: 1, maxLength: 50, example: 'Alice' },
          },
        },
        RegisterResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                user: { $ref: '#/components/schemas/UserObject' },
                verificationEmailSent: { type: 'boolean' },
              },
            },
            requestId: { type: 'string' },
          },
        },
        LoginRequest: {
          type: 'object',
          required: ['identifier', 'password'],
          properties: {
            identifier: { type: 'string', minLength: 3, maxLength: 254, example: 'alice@example.com' },
            password: { type: 'string', example: 'Strong@Passw0rd_2026!' },
          },
        },
        LoginResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                mfaRequired: { type: 'boolean', example: false },
                accessToken: { type: 'string' },
                tokenType: { type: 'string', example: 'Bearer' },
                expiresIn: { type: 'integer', example: 900 },
                refreshToken: { type: 'string' },
                user: { $ref: '#/components/schemas/UserBrief' },
                mfaChallengeToken: { type: 'string' },
                mfaChallengeExpiresIn: { type: 'integer' },
                availableMethods: { type: 'array', items: { type: 'string' } },
              },
            },
            requestId: { type: 'string' },
          },
        },
        RefreshResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                accessToken: { type: 'string' },
                tokenType: { type: 'string', example: 'Bearer' },
                expiresIn: { type: 'integer', example: 900 },
              },
            },
            requestId: { type: 'string' },
          },
        },

        // ── User ──
        UserObject: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'usr_01HZYC7Q9N8K2P4R6X0M9A1B2C' },
            username: { type: 'string', example: 'alice123' },
            email: { type: 'string', nullable: true, example: 'alice@example.com' },
            displayName: { type: 'string', example: 'Alice' },
            avatarUrl: { type: 'string', nullable: true },
            emailVerified: { type: 'boolean' },
            status: { type: 'string', enum: ['active', 'pending_verification', 'banned', 'merged', 'pending_deletion', 'deleted'] },
            createdAt: { type: 'integer', description: 'Unix 毫秒' },
          },
        },
        UserBrief: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            username: { type: 'string' },
            displayName: { type: 'string' },
            avatarUrl: { type: 'string', nullable: true },
            emailVerified: { type: 'boolean' },
          },
        },
        UserProfile: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                email: { type: 'string', nullable: true },
                displayName: { type: 'string' },
                avatarUrl: { type: 'string', nullable: true },
                emailVerified: { type: 'boolean' },
                status: { type: 'string' },
                roles: { type: 'array', items: { type: 'string' } },
                security: {
                  type: 'object',
                  properties: {
                    hasPassword: { type: 'boolean' },
                    totpEnabled: { type: 'boolean' },
                    passkeyCount: { type: 'integer' },
                    oauthProviders: { type: 'array', items: { type: 'string' } },
                  },
                },
                createdAt: { type: 'integer' },
                lastLoginAt: { type: 'integer', nullable: true },
              },
            },
            requestId: { type: 'string' },
          },
        },

        // ── TOTP ──
        TotpSetupResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                setupId: { type: 'string', example: 'totp_setup_xxx' },
                secret: { type: 'string', example: 'JBSWY3DPEHPK3PXP' },
                otpauthUrl: { type: 'string', example: 'otpauth://totp/...' },
                qrCodeImage: { type: 'string', nullable: true },
                expiresIn: { type: 'integer', example: 600 },
              },
            },
            requestId: { type: 'string' },
          },
        },

        // ── Contributions ──
        ContributionRequest: {
          type: 'object',
          required: ['title', 'content', 'contentFormat'],
          properties: {
            title: { type: 'string', maxLength: 120, example: '用户输入标题' },
            content: { type: 'string', maxLength: 50000, example: 'Markdown 内容' },
            contentFormat: { type: 'string', enum: ['markdown', 'plain_text'] },
            summary: { type: 'string', maxLength: 300, nullable: true },
            tags: { type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 8 },
            language: { type: 'string', enum: ['zh-CN', 'zh-TW', 'en', 'ja', 'other'], default: 'zh-CN' },
            submitMode: { type: 'string', enum: ['draft', 'submit'], default: 'submit' },
          },
        },
        ContributionCreateResponse: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'string', example: 'contrib_01HZYC9R4M6X8P2Q1N0A7B5C3D' },
                status: { type: 'string', example: 'pending' },
                createdAt: { type: 'integer' },
              },
            },
            requestId: { type: 'string' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  }

  sendSuccess(res, spec, _req.requestId)
})

export default router
