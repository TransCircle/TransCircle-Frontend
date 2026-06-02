# API 规范合规修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 TransCircle-Frontend 中所有与 api.md 规范不符的代码，包括 `functions/` 后端和 `src/` 前端

**Architecture:** Express + TypeScript 后端（functions/），React + Vite 前端（src/）。后端已连 MySQL。修复分 6 个阶段：现有代码修复 → 缺失认证接口 → 缺失管理接口 → 公共接口 → 安全修复 → 前端修复

**Tech Stack:** Node.js/Express/TypeScript/MySQL2（后端），React/Vite/TypeScript（前端）

---

## 文件结构

```
functions/src/
  ├── middleware/
  │   └── auth.ts              # MODIFY: 修复 JWT 校验 + 角色系统
  ├── routes/
  │   ├── auth.ts              # MODIFY: 修复 logout/refresh/OAuth/cors
  │   ├── auth-register.ts     # CREATE: POST /auth/register + email verify/resend
  │   ├── auth-password.ts     # CREATE: POST /auth/password/forgot + reset, /me/password
  │   ├── auth-login.ts        # CREATE: POST /auth/login (password login)
  │   ├── auth-totp.ts         # CREATE: TOTP setup/enable/disable/verify/recovery-codes
  │   ├── auth-passkey.ts      # CREATE: Passkey register/login
  │   ├── auth-sessions.ts     # CREATE: session list/revoke/logout-all/refresh
  │   ├── auth-stepup.ts       # CREATE: step-up start/verify
  │   ├── auth-oauth-bind.ts   # CREATE: GET /me/oauth, DELETE /me/oauth/{provider}, GET /me/oauth/{provider}/bind/start
  │   ├── auth-merge.ts        # CREATE: POST /auth/merge
  │   ├── admin-contributions.ts # MODIFY: 修复字段+添加 publish/hide/restore/delete/review-history/stats
  │   ├── admin-edit-requests.ts # CREATE: admin edit-requests list/detail/vote
  │   ├── admin-users.ts       # CREATE: GET /admin/users, ban/unban, roles
  │   ├── admin-audit.ts       # CREATE: GET /admin/audit-logs
  │   ├── contributions.ts     # MODIFY: 修复投稿字段+添加 edit-requests
  │   ├── public-contributions.ts # CREATE: GET /public/contributions
  │   ├── images.ts            # CREATE: POST/GET /images
  │   └── me.ts                # MODIFY: 完善 /me 接口
  ├── utils/
  │   ├── jwt.ts               # REWRITE: Ed25519 + 规范 payload
  │   ├── password.ts          # CREATE: argon2id 哈希
  │   ├── response.ts          # MODIFY: 统一响应格式
  │   └── validation.ts        # MODIFY: 修正投稿校验
  ├── Router.ts                # MODIFY: 注册新路由
  ├── schema.sql               # MODIFY: 更新 contributions 表结构
  └── Config.ts                # 保持

src/
  ├── context/AuthContext.tsx   # MODIFY: MFA 处理、redirectAfter
  ├── pages/
  │   ├── Login.tsx            # MODIFY: MFA 流程
  │   ├── Admin.tsx            # MODIFY: 添加发布/隐藏/删除/统计/用户管理
  │   ├── OAuthBinding.tsx     # MODIFY: step-up 引导
  │   └── OAuthMerge.tsx       # MODIFY: step-up 引导
  ├── router/index.tsx         # MODIFY: 添加 settings/security 路由
  └── components/
      └── StepUpDialog.tsx     # CREATE: 通用 step-up 弹窗组件
```

---

## Phase 1: 现有后端代码不合规修复

### Task 1: 重写 JWT — Ed25519 + 规范 Payload

**Files:**

- Rewrite: `functions/src/utils/jwt.ts`

- [ ] **Step 1: 安装依赖 + 重写 jwt.ts**

```typescript
// 使用 crypto.subtle.generateKey 生成 Ed25519 密钥对
// JWT payload 按 api.md §JWT Payload Structure:
interface JwtPayload {
  iss: string // "https://api.transcircle.org"
  aud: string // "transcircle-web"
  sub: string // 用户 ID
  jti: string // JWT 唯一 ID (ulid)
  sid: string // session ID
  roles: string[] // ["reviewer"] 等
  tokenVersion: number
  iat: number // Unix 秒
  exp: number // Unix 秒
}
```

运行: `cd functions && pnpm add @noble/ed25519`

完整代码:

```typescript
import { conf } from '../Config'
import { ulid } from './ulid'

const sessionConf = conf.SESSION as Record<string, string | number | undefined> | undefined
const BASE_URL = 'https://api.transcircle.org'

// Ed25519 密钥在进程启动时生成一次（生产环境应从 KMS 加载）
let cachedPrivateKey: Uint8Array | null = null
let cachedPublicKey: Uint8Array | null = null

async function getKeyPair(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  if (cachedPrivateKey && cachedPublicKey) {
    return { privateKey: cachedPrivateKey, publicKey: cachedPublicKey }
  }
  const ed = await import('@noble/ed25519')
  const privateKey = ed.utils.randomPrivateKey()
  const publicKey = await ed.getPublicKeyAsync(privateKey)
  cachedPrivateKey = privateKey
  cachedPublicKey = publicKey
  return { privateKey, publicKey }
}

export interface JwtPayload {
  iss: string
  aud: string
  sub: string
  jti: string
  sid: string
  roles: string[]
  tokenVersion: number
  iat: number
  exp: number
}

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function decodeBase64url(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

export async function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'>): Promise<string> {
  const ed = await import('@noble/ed25519')
  const { privateKey } = await getKeyPair()
  const now = Math.floor(Date.now() / 1000)

  const jwtPayload: JwtPayload = {
    ...payload,
    jti: ulid(),
    iat: now,
    exp: now + 900, // 15 min
  }

  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })))
  const body = base64url(new TextEncoder().encode(JSON.stringify(jwtPayload)))
  const message = `${header}.${body}`
  const signature = await ed.signAsync(new TextEncoder().encode(message), privateKey)
  return `${message}.${base64url(signature)}`
}

export async function verifyJwt(token: string): Promise<JwtPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const ed = await import('@noble/ed25519')
    const { publicKey } = await getKeyPair()
    const valid = await ed.verifyAsync(
      decodeBase64url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      publicKey,
    )
    if (!valid) return null
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[1]))) as JwtPayload
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
```

- [ ] **Step 2: 更新所有引用 jwt.ts 的地方**

修改 `middleware/auth.ts`:

- 将 `payload.isAdmin` 改为 `payload.roles.includes('reviewer')`
- 将 `verifyJwt` 返回的类型检查适配新 payload

修改 `routes/auth.ts`:

- `signJwt({ sub: ..., sessionId: ..., tokenVersion: ..., isAdmin: ... })`
  → `signJwt({ sub, sid, tokenVersion, roles: userRoles ? ['reviewer'] : [], aud: 'transcircle-web', iss: 'https://api.transcircle.org' })`

运行: `cd functions && npx tsc --noEmit` 确认编译通过

- [ ] **Step 3: 提交**

```bash
git add functions/src/utils/jwt.ts functions/src/middleware/auth.ts functions/src/routes/auth.ts
git commit -m ":recycle: refactor(jwt): Ed25519 + 规范 payload (sid/jti/roles/aud/iss)"
```

### Task 2: 更换密码哈希为 argon2id

**Files:**

- Create: `functions/src/utils/password.ts`
- Modify: `functions/src/routes/auth.ts`

- [ ] **Step 1: 安装 argon2 + 创建 password.ts**

运行: `cd functions && pnpm add argon2`

```typescript
// functions/src/utils/password.ts
import argon2 from 'argon2'

// api.md 安全基线: argon2id, memory ≥ 64 MiB, iterations ≥ 3
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MiB
    timeCost: 3,
    parallelism: 1,
  })
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password)
}
```

- [ ] **Step 2: 替换 auth.ts 中的 PBKDF2 代码**

在 `auth.ts:628-638`（complete-registration 路由中）:

```typescript
// 删除所有 PBKDF2 crypto.subtle 代码，替换为:
const passwordHash = await hashPassword(password)
```

移除:

```typescript
const pbkdf2Key = await crypto.subtle.importKey(...)
const salt = crypto.getRandomValues(...)
const derivedBits = await crypto.subtle.deriveBits(...)
const passwordHash = btoa(...) + ':' + btoa(...)
```

- [ ] **Step 3: 提交**

```bash
git add functions/src/utils/password.ts functions/src/routes/auth.ts
git commit -m ":recycle: refactor(auth): 密码哈希更换为 argon2id (memory=64MiB, time=3)"
```

### Task 3: 修复 Logout — 不 bump tokenVersion + 返回 204

**Files:**

- Modify: `functions/src/routes/auth.ts` 的 logout 路由

- [ ] **Step 1: 重写 logout 路由**

```typescript
router.post('/logout', async (req, res) => {
  const rawToken = req.cookies?.refresh_token

  if (rawToken) {
    // 只吊销当前 session，不 bump tokenVersion
    const tokenHash = await hmacToken(rawToken)
    const event = await queryOne(
      `SELECT sessionId FROM refresh_token_events WHERE tokenHash = ? AND status = 'active'`,
      [tokenHash],
    )
    if (event) {
      await revokeSession(event.sessionId, 'logout')
      await exec(`UPDATE refresh_token_events SET status = 'revoked' WHERE tokenHash = ?`, [tokenHash])
    }
  }

  res.clearCookie('refresh_token', { path: '/v1/auth' })
  // api.md §1.11.3: 204 No Content
  res.status(204).end()
})
```

删除 `auth.ts` 中 logout 路由的旧代码，用以上替换。

- [ ] **Step 2: 编译检查**

运行: `cd functions && npx tsc --noEmit`

- [ ] **Step 3: 提交**

```bash
git add functions/src/routes/auth.ts
git commit -m ":bug: fix(auth): logout 不 bump tokenVersion + 返回 204"
```

### Task 4: 修复 Refresh — 正确使用 rotateRefreshToken

**Files:**

- Modify: `functions/src/routes/auth.ts` 的 refresh 路由

- [ ] **Step 1: 重写 refresh 路由**

```typescript
router.post('/refresh', rateLimitCheck, async (req, res) => {
  const rawToken = req.cookies?.refresh_token
  if (!rawToken) {
    sendError(res, 'INVALID_REFRESH_TOKEN', '刷新令牌无效', req.requestId, 401)
    return
  }

  // rotateRefreshToken 已实现原子 rotation + reuse detection
  const sessionInfo = await rotateRefreshToken(rawToken)
  if (!sessionInfo) {
    sendError(res, 'REFRESH_TOKEN_REVOKED', '刷新令牌已被吊销', req.requestId, 401)
    return
  }

  // 签发新 access token（使用同一个 session，不创建新 session）
  const accessToken = await signJwt({
    sub: sessionInfo.userId,
    sid: sessionInfo.id,
    tokenVersion: sessionInfo.tokenVersion,
    roles: sessionInfo.isAdmin ? ['reviewer'] : [],
    aud: 'transcircle-web',
    iss: 'https://api.transcircle.org',
  })

  // 新 refresh token 已经在 rotateRefreshToken 里写入了
  // 但我们需要把新 token 返回给客户端 — 需要从 rotateRefreshToken 获取
  // 修改 rotateRefreshToken 以返回新 token，或重新设计流程

  // 简化方案：走完整的 refresh_token_events 链查找
  const newEvent = await queryOne(
    `SELECT tokenPrefix FROM refresh_token_events
     WHERE sessionId = ? AND status = 'active'`,
    [sessionInfo.id],
  )
  // 由于我们存储的是 hash，无法还原原始 token
  // 因此需要修改 rotateRefreshToken 的返回类型，增加 newRawToken

  sendSuccess(res, { accessToken, tokenType: 'Bearer', expiresIn: 900 }, req.requestId)
})
```

等等，这里有一个问题：`rotateRefreshToken` 在 `session.ts` 中已经插入了新的 `refresh_token_events` 记录，但只存了 hash。route handler 无法获取新的原始 token 来返回给客户端。

需要修改 `session.ts` 的 `rotateRefreshToken` 函数返回新 token:

- [ ] **Step 2: 修改 rotateRefreshToken 返回新 token**

```typescript
export interface RotateResult {
  id: string
  userId: string
  tokenVersion: number
  isAdmin: boolean
  newRefreshToken: string // 新增：返回新 token
}
```

在 `rotateRefreshToken` 函数中，在生成 `newToken = randomToken()` 后，将 `newToken` 包含在返回值中。

- [ ] **Step 3: 完成 refresh 路由**

```typescript
router.post('/refresh', rateLimitCheck, async (req, res) => {
  const rawToken = req.cookies?.refresh_token
  if (!rawToken) {
    sendError(res, 'INVALID_REFRESH_TOKEN', '刷新令牌无效', req.requestId, 401)
    return
  }

  const result = await rotateRefreshToken(rawToken)
  if (!result) {
    sendError(res, 'REFRESH_TOKEN_REVOKED', '刷新令牌已被吊销', req.requestId, 401)
    return
  }

  const accessToken = await signJwt({
    sub: result.userId,
    sid: result.id,
    tokenVersion: result.tokenVersion,
    roles: result.isAdmin ? ['reviewer'] : [],
    aud: 'transcircle-web',
    iss: 'https://api.transcircle.org',
  })

  // 设置新 refresh token cookie
  const maxAge = 7 * 24 * 60 * 60
  res.cookie('refresh_token', result.newRefreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth',
    maxAge: maxAge * 1000,
  })

  sendSuccess(res, { accessToken, tokenType: 'Bearer', expiresIn: 900 }, req.requestId)
})
```

- [ ] **Step 4: 编译检查 + 提交**

- [ ] **Step 5: 提交 commit**

### Task 5: 修复投稿接口 — 删除非标准字段

**Files:**

- Modify: `functions/src/routes/contributions.ts`
- Modify: `functions/src/utils/validation.ts`
- Modify: `functions/src/routes/admin.ts`（列表和详情响应）
- Modify: `functions/schema.sql`

- [ ] **Step 1: 修正 validation.ts 的 contributionSchema**

```typescript
export const contributionSchema = z.object({
  title: z
    .string()
    .min(1, '标题不能为空')
    .refine((v) => [...v].length <= 120, '标题最多 120 个字符'),
  content: z
    .string()
    .min(1, '正文不能为空')
    .refine((v) => [...v].length <= 50000, '正文最多 50000 字符'),
  contentFormat: z.enum(['markdown', 'plain_text']).default('markdown'),
  summary: z
    .string()
    .refine((v) => [...v].length <= 300, '摘要最多 300 个字符')
    .optional(),
  tags: z
    .array(z.string().refine((v) => [...v].length <= 32, '标签最多 32 个字符'))
    .max(8)
    .default([]),
  language: z.enum(['zh-CN', 'zh-TW', 'en', 'ja', 'other']).default('zh-CN'),
  submitMode: z.enum(['draft', 'submit']).default('submit'),
  website: z.string().optional(), // honeypot
})
```

删除: `authorType`, `authorName`, `contact`, `category`

- [ ] **Step 2: 重写 contributions.ts**

简化 INSERT，去掉 `authorType`/`authorName`/`contact`/`category`/`submitterIpHash`/`submitterUserAgentHash`:

```typescript
await exec(
  `INSERT INTO contributions (id, authorUserId, title, summary, contentRaw, contentFormat, contentHtml, rendererVersion, status, version, language, tags, idempotencyKey, submittedAt, createdAt, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    id,
    req.user?.userId || null,
    data.title.trim(),
    data.summary?.trim() || null,
    data.content,
    data.contentFormat || 'markdown',
    data.content, // 简化版，后续改 DOMPurify
    'v1',
    status,
    1,
    data.language || 'zh-CN',
    JSON.stringify(data.tags || []),
    idempotencyKeyRef.current || null,
    submitMode === 'submit' ? now : null,
    now,
    now,
  ],
)
```

- [ ] **Step 3: 修复 admin.ts 的 contributions 响应**

删除 `authorType`/`authorName`/`contact`/`submitterGh`/`submitterX` 字段，添加 `summary`。

在 `admin.ts:69-88` 的 map 中:

```typescript
const submissions = rows.map((row: Record<string, unknown>) => ({
  id: row.id as string,
  title: row.title as string,
  summary: row.summary as string | null,
  status: row.status as string,
  version: row.version as number,
  createdAt: row.createdAt as number,
  updatedAt: row.updatedAt as number,
  submittedAt: row.submittedAt as number | null,
  publishedAt: row.publishedAt as number | null,
  author: row.username
    ? {
        id: row.authorUserId as string | null,
        displayName: (row.displayName || row.username) as string,
        avatarUrl: row.avatarUrl as string | null,
      }
    : null,
}))
```

- [ ] **Step 4: 提交**

### Task 6: 添加 audit_logs 写入

**Files:**

- Modify: `functions/src/routes/admin.ts`（review 操作）
- Modify: `functions/src/routes/contributions.ts`（create 操作）

- [ ] **Step 1: 在 admin.ts review 成功时写入 audit_logs**

在 `admin.ts` review 成功更新后（约 201 行）:

```typescript
await exec(
  `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, \`before\`, after, createdAt, requestId)
   VALUES (?, ?, 'contribution.review', 'contribution', ?, ?, ?, ?, ?)`,
  [
    ulid(),
    req.user!.userId,
    id,
    JSON.stringify({ status: contribution.status, version: expectedVersion }),
    JSON.stringify({ status: toStatus, version: newVersion }),
    now,
    req.requestId,
  ],
)
```

- [ ] **Step 2: 在 contributions.ts create 时写入 audit_logs**

```typescript
await exec(
  `INSERT INTO audit_logs (id, actorUserId, action, resourceType, resourceId, after, createdAt, requestId)
   VALUES (?, ?, 'contribution.create', 'contribution', ?, ?, ?, ?)`,
  [ulid(), req.user?.userId || null, id, JSON.stringify({ title: data.title, status }), now, req.requestId],
)
```

- [ ] **Step 3: 提交**

### Task 7: 修复健康检查格式

**Files:**

- Modify: `functions/src/Router.ts`

- [ ] **Step 1: 重写 /healthz 和 /readyz**

```typescript
app.get('/healthz', (req: Request, res: Response) => {
  sendSuccess(
    res,
    {
      status: 'ok',
      service: 'transcircle-api',
      version: '1.0.0',
      commit: process.env.GIT_COMMIT || 'unknown',
      uptimeSeconds: Math.floor(process.uptime()),
      checks: { database: 'ok' }, // 可扩展为实际检查
    },
    req.requestId,
  )
})

app.get('/readyz', async (req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1')
    sendSuccess(
      res,
      {
        status: 'ok',
        service: 'transcircle-api',
        version: '1.0.0',
        commit: process.env.GIT_COMMIT || 'unknown',
        uptimeSeconds: Math.floor(process.uptime()),
        checks: { database: 'ok' },
      },
      req.requestId,
    )
  } catch {
    res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not ready' },
      requestId: req.requestId,
    })
  }
})
```

- [ ] **Step 2: 提交**

### Task 8: 修复 OAuth 回调 — 添加所有缺失状态

**Files:**

- Modify: `functions/src/routes/auth.ts`

这是最大的改动。需要将 OAuth 回调从目前的 2 种状态扩展为完整的 10 种状态。

- [ ] **Step 1: 添加 status 速查表映射 + 完整回调逻辑**

修改 `auth.ts` 中两个 OAuth callback（github/x），使其走统一的分流逻辑:

```typescript
// 在回调中根据 oauth_accounts 查询结果 + users.status 分流:
async function handleOAuthCallback(
  provider: string,
  providerUserId: string,
  providerData: { username: string; displayName: string; avatarUrl: string | null; email: string | null; emailVerified: boolean },
  state: { mode: 'login' | 'bind'; userId?: string; redirectAfter?: string },
  req: Request, res: Response,
): Promise<void> {
  const existingOAuth = await queryOne(
    `SELECT oa.userId, u.status, u.tokenVersion, u.id
     FROM oauth_accounts oa JOIN users u ON u.id = oa.userId
     WHERE oa.provider = ? AND oa.providerUserId = ?`,
    [provider, providerUserId],
  )

  const APP_URL = 'https://submit.transcircle.org'

  if (existingOAuth) {
    // OAuth 已绑定到本地账号
    if (state.mode === 'bind') {
      if (existingOAuth.userId === state.userId) {
        // 已绑定到当前用户
        return res.redirect(`${APP_URL}/auth/callback?status=bind_already_self&provider=${provider}`)
      } else {
        // 已绑定到其他用户 → 合并流程
        const mergeToken = ulid()
        await exec(`INSERT INTO auth_tokens (...) VALUES (...)`, [...])
        return res.redirect(`${APP_URL}/auth/oauth/merge?status=bind_conflict_merge&mergeToken=${mergeToken}&conflictUserId=${existingOAuth.userId}`)
      }
    }

    // mode === 'login' — 按 users.status 分流
    switch (existingOAuth.status) {
      case 'active':
      case 'pending_verification': {
        // ... 创建 session、写 loginCode、redirect login_ok
        break
      }
      case 'banned':
        return res.redirect(`${APP_URL}/auth/callback?status=login_blocked&code=ACCOUNT_BANNED`)
      case 'merged':
        return res.redirect(`${APP_URL}/auth/callback?status=login_blocked&code=ACCOUNT_MERGED`)
      case 'pending_deletion':
        return res.redirect(`${APP_URL}/auth/callback?status=login_blocked&code=ACCOUNT_PENDING_DELETION`)
      case 'deleted':
        return res.redirect(`${APP_URL}/auth/callback?status=login_blocked&code=ACCOUNT_DELETED`)
    }
  } else {
    // OAuth 未绑定
    if (state.mode === 'bind') {
      const providerBound = await queryOne(
        `SELECT id FROM oauth_accounts WHERE userId = ? AND provider = ?`,
        [state.userId, provider],
      )
      if (providerBound) {
        return res.redirect(`${APP_URL}/auth/callback?status=bind_provider_taken&provider=${provider}`)
      }
      // 生成 oauth_pending_registration + pending_binding 重定向
    } else {
      // 生成 oauth_pending_registration + pending_registration 重定向
    }
  }
}
```

- [ ] **Step 2: 编译检查 + 提交**

---

## Phase 2: 缺失认证接口

### Task 9: 添加 POST /auth/register + 邮箱验证

**Files:**

- Create: `functions/src/routes/auth-register.ts`
- Modify: `functions/src/Router.ts`

- [ ] **Step 1: 创建 auth-register.ts**

包含:

- `POST /auth/register` — 注册新用户，api.md §1.1
- `POST /auth/email/verify` — 邮箱验证，api.md §1.2.1
- `POST /auth/email/resend` — 重发验证邮件，api.md §1.2.2

注册逻辑: 校验字段 → 检查唯一性 → argon2id 哈希密码 → INSERT users(status='pending_verification') → 生成 verify token → 返回 201

- [ ] **Step 2: 在 Router.ts 中注册**

```typescript
import authRegisterRoutes from './routes/auth-register'
app.use('/v1/auth', authRegisterRoutes)
```

- [ ] **Step 3: 提交**

### Task 10: 添加 POST /auth/login（密码登录）

**Files:**

- Create: `functions/src/routes/auth-login.ts`
- Modify: `functions/src/Router.ts`

包含:

- `POST /auth/login` — 邮箱/用户名 + 密码登录，api.md §1.3

实现:

1. 用 identifier 查用户（username 或 email）
2. argon2id 验证密码
3. 按 users.status 分流（active/pending_verification → 登录成功, banned/merged/pending_deletion/deleted → 对应错误）
4. 检查 MFA → 返回 mfaRequired: true/false
5. 创建 session + 签发 access/refresh token

- [ ] **Step 1: 创建 auth-login.ts**
- [ ] **Step 2: 注册路由 + 提交**

### Task 11: 添加密码重置接口

**Files:**

- Create: `functions/src/routes/auth-password.ts`
- Modify: `functions/src/Router.ts`

包含:

- `POST /auth/password/forgot` — 发起重置，api.md §1.4.1
- `POST /auth/password/reset` — 提交新密码，api.md §1.4.2
- `POST /me/password` — 修改密码，api.md §1.5

- [ ] **Step 1: 创建 auth-password.ts**
- [ ] **Step 2: 注册路由 + 提交**

### Task 12: 添加 OAuth 绑定/合并/查询接口

**Files:**

- Create: `functions/src/routes/auth-oauth-bind.ts`
- Create: `functions/src/routes/auth-merge.ts`
- Modify: `functions/src/Router.ts`

auth-oauth-bind.ts 包含:

- `GET /me/oauth` — 查询绑定状态，api.md §1.7.3
- `GET /me/oauth/{provider}/bind/start` — 发起绑定，api.md §1.7.1
- `DELETE /me/oauth/{provider}` — 解绑，api.md §1.7.2
- `POST /auth/oauth/complete-binding` — 完成绑定，api.md §1.6.5
- `GET /auth/oauth/pending-profile` — 预填信息，api.md §1.6.6

auth-merge.ts 包含:

- `POST /auth/merge` — 账号合并，api.md §1.8

- [ ] **Step 1: 创建两个路由文件**
- [ ] **Step 2: 注册路由 + 提交**

### Task 13: 添加 TOTP 全套接口

**Files:**

- Create: `functions/src/routes/auth-totp.ts`
- Modify: `functions/src/Router.ts`

包含:

- `POST /me/mfa/totp/setup` — §1.9.1
- `POST /me/mfa/totp/enable` — §1.9.2
- `DELETE /me/mfa/totp` — §1.9.3
- `POST /auth/mfa/totp/verify` — §1.9.4
- `POST /me/mfa/recovery-codes/regenerate` — §1.9.5

- [ ] **Step 1: 创建 auth-totp.ts**
- [ ] **Step 2: 注册路由 + 提交**

### Task 14: 添加 Passkey 全套接口

**Files:**

- Create: `functions/src/routes/auth-passkey.ts`
- Modify: `functions/src/Router.ts`

包含:

- `POST /me/passkeys/register/start` — §1.10.1
- `POST /me/passkeys/register/finish` — §1.10.2
- `GET /me/passkeys` — §1.10.3
- `DELETE /me/passkeys/{id}` — §1.10.4
- `POST /auth/passkey/login/start` — §1.10.5
- `POST /auth/passkey/login/finish` — §1.10.5

- [ ] **Step 1: 创建 auth-passkey.ts**
- [ ] **Step 2: 注册路由 + 提交**

### Task 15: 添加 Session 管理 + Step-up 接口

**Files:**

- Create: `functions/src/routes/auth-sessions.ts`
- Create: `functions/src/routes/auth-stepup.ts`
- Modify: `functions/src/Router.ts`

auth-sessions.ts 包含:

- `GET /auth/session` — §1.11.1
- `POST /auth/logout-all` — §1.11.4
- `GET /me/sessions` — §1.11.5
- `DELETE /me/sessions/{id}` — §1.11.6

auth-stepup.ts 包含:

- `POST /auth/step-up/start` — §1.12.1
- `POST /auth/step-up/verify` — §1.12.2

- [ ] **Step 1: 创建路由文件**
- [ ] **Step 2: 注册路由 + 提交**

---

## Phase 3: 管理后台接口

### Task 16: 添加发布/隐藏/恢复/删除/审核历史/统计

**Files:**

- Modify: `functions/src/routes/admin-contributions.ts`

- [ ] **Step 1: 添加 publish 路由**

```typescript
router.post('/contributions/:id/publish', requireAdmin, async (req, res) => {
  // §6.5: 将 approved → published
  // 校验 status=approved + expectedVersion
  // UPDATE status=published, publishedAt=now
  // 写 audit_logs + contribution_review_events
})
```

- [ ] **Step 2: 添加 hide/restore 路由**

```typescript
router.post('/contributions/:id/hide', requireAdmin, async (req, res) => {
  /* §6.4 */
})
router.post('/contributions/:id/restore', requireAdmin, async (req, res) => {
  /* §6.4 */
})
```

- [ ] **Step 3: 添加 delete 路由**

```typescript
router.post('/contributions/:id/delete', requireAdmin, async (req, res) => {
  /* §6.6 */
})
```

- [ ] **Step 4: 添加 review-events 路由**

```typescript
router.get('/contributions/:id/review-events', requireAdmin, async (req, res) => {
  /* §6.7 */
})
```

- [ ] **Step 5: 添加 stats 路由**

```typescript
router.get('/contributions/stats', requireAdmin, async (req, res) => {
  /* §6.8 */
})
```

- [ ] **Step 6: 提交**

### Task 17: 添加用户管理接口

**Files:**

- Create: `functions/src/routes/admin-users.ts`
- Modify: `functions/src/Router.ts`

包含:

- `GET /admin/users` — 用户列表，§7.1
- `GET /admin/users/{id}` — 用户详情，§7.2
- `POST /admin/users/{id}/roles` — 授予角色，§7.3
- `DELETE /admin/users/{id}/roles/{roleId}` — 撤销角色，§7.4
- `POST /admin/users/{id}/ban` — 封禁，§7.5
- `POST /admin/users/{id}/unban` — 解封，§7.5

- [ ] **Step 1: 创建 admin-users.ts**
- [ ] **Step 2: 注册路由 + 提交**

### Task 18: 添加审计日志接口

**Files:**

- Create: `functions/src/routes/admin-audit.ts`
- Modify: `functions/src/Router.ts`

包含:

- `GET /admin/audit-logs` — §8

- [ ] **Step 1: 创建 admin-audit.ts**
- [ ] **Step 2: 注册路由 + 提交**

---

## Phase 4: 公共接口

### Task 19: 添加公开投稿接口

**Files:**

- Create: `functions/src/routes/public-contributions.ts`
- Modify: `functions/src/Router.ts`

包含:

- `GET /public/contributions` — 已发布列表，§5.1
- `GET /public/contributions/{id}` — 公开详情，§5.2（返回 contentHtml 而非 contentRaw）

- [ ] **Step 1: 创建 public-contributions.ts**
- [ ] **Step 2: 注册路由 + 提交**

### Task 20: 添加修改申请接口

**Files:**

- Modify: `functions/src/routes/contributions.ts`
- Create: `functions/src/routes/admin-edit-requests.ts`
- Modify: `functions/src/Router.ts`

- [ ] **Step 1: 在 contributions.ts 添加 edit-requests 路由**

```typescript
// POST /contributions/{id}/edit-requests — §10.1
// POST /me/edit-requests/{id}/withdraw — §10.2
// GET /me/edit-requests — §10.3
```

- [ ] **Step 2: 创建 admin-edit-requests.ts**

```typescript
// GET /admin/edit-requests — §10.4
// GET /admin/edit-requests/{id} — §10.5
// POST /admin/edit-requests/{id}/vote — §10.6
```

- [ ] **Step 3: 注册路由 + 提交**

### Task 21: 添加图片上传/查看接口

**Files:**

- Create: `functions/src/routes/images.ts`
- Modify: `functions/src/Router.ts`

包含:

- `POST /images` — 上传，§11.1
- `GET /images/{id}` — 查看，§11.2

注意: 需要 multer 处理 multipart 上传，sharp 处理图片，文件存储到本地 files/ 目录

- [ ] **Step 1: 安装依赖并创建 images.ts**

```bash
cd functions && pnpm add multer sharp
pnpm add -D @types/multer
```

- [ ] **Step 2: 注册路由 + 提交**

---

## Phase 5: 安全问题修复

### Task 22: 添加内容安全清洗

**Files:**

- Create: `functions/src/utils/sanitize.ts`
- Modify: `functions/src/routes/contributions.ts`

- [ ] **Step 1: 创建 sanitize.ts**

```typescript
// 简易白名单 HTML 清洗（后续可换 DOMPurify）
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
}
```

- [ ] **Step 2: 在 contributions CREATE 和 UPDATE 时应用 sanitize**

```typescript
import { markdownToHtml } from './utils/sanitize'
// 存入 contentHtml = sanitizeHtml(renderMarkdown(data.content))
```

- [ ] **Step 3: 提交**

---

## Phase 6: 前端修复

### Task 23: 修复登录 — 处理 MFA 流程

**Files:**

- Modify: `src/context/AuthContext.tsx`
- Modify: `src/pages/Login.tsx`

- [ ] **Step 1: 在 AuthContext 中暴露 MFA 挑战状态**

```typescript
interface AuthContextValue {
  // ...现有...
  mfaChallenge: { token: string; methods: string[] } | null
  verifyMfaTotp: (code: string) => Promise<User | null>
}
```

- [ ] **Step 2: 在 Login.tsx 中添加 MFA 表单**

当 `mfaRequired: true` 时，显示 TOTP 输入框调用 `verifyMfaTotp()`

- [ ] **Step 3: 提交**

### Task 24: 修复 OAuth Start — 添加 redirectAfter

**Files:**

- Modify: `src/context/AuthContext.tsx`

- [ ] **Step 1: 修改 loginWithGitHub/loginWithX**

```typescript
const loginWithGitHub = useCallback(async () => {
  setLoginProvider('github')
  const redirectAfter = window.location.pathname + window.location.search
  try {
    const res = await fetch(`${API_BASE}/auth/oauth/github/start?redirectAfter=${encodeURIComponent(redirectAfter)}`)
    // ...
  }
}, [])
```

- [ ] **Step 2: 提交**

### Task 25: 创建 Step-up 对话框组件

**Files:**

- Create: `src/components/StepUpDialog.tsx`
- Modify: `src/pages/OAuthBinding.tsx`
- Modify: `src/pages/OAuthMerge.tsx`

- [ ] **Step 1: 创建 StepUpDialog 组件**

调用 `POST /v1/auth/step-up/start` 获取可用方法 → 显示密码/Passkey/TOTP 输入 → 调用 `POST /v1/auth/step-up/verify` → 成功后回调

- [ ] **Step 2: 在 OAuthBinding 和 OAuthMerge 中使用**

收到 `403 STEP_UP_REQUIRED` 时弹出 StepUpDialog，完成后自动重试原请求。

- [ ] **Step 3: 提交**

### Task 26: 扩展管理后台页面

**Files:**

- Modify: `src/pages/Admin.tsx`

- [ ] **Step 1: 添加 Publish 按钮（approved 状态投稿）**
- [ ] **Step 2: 添加 Hide/Restore 按钮（published/hidden 状态投稿）**
- [ ] **Step 3: 添加 Delete 按钮**
- [ ] **Step 4: 添加 Review History 展示**
- [ ] **Step 5: 添加 Stats 面板**
- [ ] **Step 6: 添加 User Management 页面**
- [ ] **Step 7: 提交**

### Task 27: 添加 Settings/Security 路由

**Files:**

- Modify: `src/router/index.tsx`
- Create: `src/pages/SettingsSecurity.tsx`

- [ ] **Step 1: 创建 SettingsSecurity 页面**
- [ ] **Step 2: 在 router 中注册 `/settings/security` 路由**
- [ ] **Step 3: 提交**
