# 待讨论架构问题文档

## H1: OAuth CSRF Token 生产部署通道

### 当前状况

- **Config**: `src/config.ts` 生产 API 为 `https://api.transcircle.org/v1`
- **Cookie**: `oauth_pending_csrf` 设于 API host（`api.transcircle.org`），`Path=/v1/auth/oauth`
- **前端读法**: `document.cookie.match(/oauth_pending_csrf=/)`（`src/api/client.ts:90-94`）
- **保存兜底**: `saveCsrfToken()` 写入 sessionStorage（`OAuthCallback.tsx:31-32`、`OAuthContinue.tsx:18-19`、`OAuthBinding.tsx`）

### 问题

```
Frontend:      transcircle.org  ─── document.cookie:  ❌ 看不到 api.transcircle.org 的 cookie
Backend API:   api.transcircle.org  ── Set-Cookie: oauth_pending_csrf=...  Path=/v1/auth/oauth
```

`document.cookie` **只能读取与当前页面同源的 cookie**。跨 host 场景下，前端永远读不到这个值 → `X-CSRF-Token` 恒为空 → API 返回 403 CSRF_TOKEN_INVALID。

目前 dev 能跑通是因为 Vite proxy 同源，生产则断裂。

### 方案选项

#### A. 同源反向代理 (推荐)

在 `transcircle.org` 部署一个反向代理（如 nginx/Caddy），将 `/v1/*` 转发到 `api.transcircle.org/v1/*`。

```
用户 → transcircle.org  →  nginx  →  api.transcircle.org/v1/*
                           ↑
                      Set-Cookie 现在与前站同源
```

- 优点：cookie 自动同源，前端代码无需改动；整个 CSRF 机制按设计工作
- 缺点：需要配置反代；API 服务器仍需区分来源

#### B. CSRF via Response Body

OAuth start 和 callback 的响应体同时返回 CSRF token（除 Set-Cookie 外）：

```json
{
  "data": { "authorizationUrl": "...", "csrfToken": "..." },
  "requestId": "req_xxx"
}
```

前端从 JSON 响应中提取 token，存入 sessionStorage，后续通过 `X-CSRF-Token` header 传递。

- 优点：不依赖同源 cookie；前端已有 `saveCsrfToken()` 基础设施
- 缺点：需要后端配合在多个 OAuth 端点响应中增加 `csrfToken` 字段

#### C. URL Fragment 传递

OAuth callback URL 中携带 CSRF token 作为 query 参数：

```
/auth/callback?status=login_ok&loginCode=xxx&csrfToken=xxx
```

- 优点：实现简单
- 缺点：token 可能出现在服务器日志中；URL 长度受限

#### D. 放宽 Cookie Domain

后端设置 `Domain=transcircle.org` 使 cookie 跨子域可读：

```
Set-Cookie: oauth_pending_csrf=...; Domain=transcircle.org; Path=/v1/auth/oauth; Secure; HttpOnly; SameSite=Lax
```

- 优点：前端代码无需改动
- 缺点：安全边界降低；需要确保所有子域 HTTPS

### 推荐方案

**方案 B（Response Body）** 最适合当前架构：

- 前端已有 `saveCsrfToken()` / `getCsrfToken()` 的 sessionStorage 通道
- 不需要基础设施变更（不改 nginx/域名）
- 只需要后端在 OAuth start 和 callback 响应中增加 `csrfToken` 字段
- 需要后端的端点：
  - `GET /v1/auth/oauth/:provider/start` → 返回 `{ csrfToken }`
  - OAuth callback → 返回 `{ ...params, csrfToken }`

---

## M9: Idempotency-Key 提升到表单意图层

### 当前状况

`src/api/client.ts:229`:

```typescript
const idempotencyKey = options.idempotent ? newIdempotencyKey() : undefined
```

Key 在 `apiRequest()` 每次调用时生成。如果请求超时/5xx 后用户再次点击提交按钮，新的请求会生成新的 key，服务端幂等快照永远不会命中。

### 目标

为每个 **业务意图**（注册、投稿提交、编辑申请创建）生成一次 key，在超时重试间复用。

### 修改方案

#### 1. 暴露 setIdempotencyKey 到 client.ts

```typescript
// client.ts — 添加 per-intent key 支持
let _intentKey: string | null = null

export function setIdempotencyKey(key: string | null): void {
  _intentKey = key
}

export function getIntentKey(): string | null {
  return _intentKey
}
```

#### 2. 修改 apiRequest 优先使用意图级 key

```typescript
// 在 apiRequest 中
const idempotencyKey = options.idempotent ? _intentKey || newIdempotencyKey() : undefined
if (idempotencyKey && !_intentKey) {
  _intentKey = idempotencyKey
}
```

#### 3. 在表单提交入口设置 key

```typescript
// RegisterDirect.tsx 提交前：
setIdempotencyKey(crypto.randomUUID())

// SubmitForm.tsx 提交前：
setIdempotencyKey(crypto.randomUUID())

// EditRequestForm.tsx 提交前：
setIdempotencyKey(crypto.randomUUID())
```

在 401 重试后或表单重置时清除：

```typescript
// 成功后或表单重置时：
setIdempotencyKey(null)
```

### 需要注意

- 必须确保 key 在重试间保持不变，但在新的意图开始时重新生成
- 表单组件的 `handleSubmit` 需要设置 key（而不是在 render 中设置）
- `RegisterDirect.tsx:81`、`SubmitForm.tsx:144`、`EditRequestForm.tsx` 需要接入
- 确保在 401 自动重试后 key 不被重新生成（当前行为正确：同一 `apiRequest` 调用内复用）

### 实施时机

M9 为低严重度问题，可在下一次表单相关迭代中实施。当前已在 `client.ts` 中添加 TODO 注释。
