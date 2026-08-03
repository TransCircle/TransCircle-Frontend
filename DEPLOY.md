# TransCircle 故事站前端部署与统一登录检查

## 架构

```text
浏览器 → 故事站前端（React/Vite）
             │ 同源 /v1
             ▼
         故事站 Backend :1145
             │ 普通用户 OIDC
             ▼
         TransCircle Pass :1146 / https://api.transcircle.org/pass
             │ 需要认证时的 interaction
             ▼
         主站 Pass 门户 :5174 / https://transcircle.org/login
```

- 故事站不承载账号密码、注册、Passkey、TOTP 或第三方账号登录界面。
- 普通登录 CTA 由前端请求 Backend `/v1/auth/oauth/pass/start`，再整页跳转到 Pass 授权地址。
- Pass 无登录态时跳到主站门户登录；已有 Pass 会话时直接完成 SSO。
- OIDC callback 落故事站 Backend；Backend 验证 state、PKCE、nonce、ID Token 与 UserInfo 后建立**故事站独立业务会话**。
- 管理员身份通过独立 IAM `tc_story` 流程获得；Pass 登录不携带或同步管理权限。

权威接入文档：

- `docs-main/pass-guide.md`
- `docs-main/iam-admin-api.md`
- `docs-main/AGENTS.md`

## 前端构建

```bash
cd TransCircle-Frontend
pnpm install
pnpm typecheck
pnpm lint
pnpm build
```

开发服务器：

```bash
pnpm dev
# 默认 http://localhost:5173
# vite.config.ts 将 /v1 代理到 http://localhost:1145
```

当前仓库尚未配置前端自动化测试；`pnpm test` 只输出 `no tests configured`，不能视为回归覆盖。

## 前端环境变量

以 `.env.example` 为准。Vite 只会将 `VITE_*` 打入浏览器产物：

- `VITE_LOGOUT_REDIRECT`：故事站登出后的跳转目标。
- `VITE_PASS_ACCOUNT_BASE`：主站 Pass 账户中心地址。
- `VITE_IMAGE_BASE`：图片资源基址。

禁止在前端环境变量中保存 Pass/IAM `client_secret`、机器令牌、数据库凭据或服务端会话密钥。

## Backend / Pass 配置要求

### 故事站 Backend

`TransCircle-Backend/config.example.toml` 中：

- `[FRONTEND].FRONTEND_URL` 指向故事站公开 origin。
- `[PASS].ISSUER`：生产为 `https://api.transcircle.org/pass`，本地通常为 `http://localhost:1146`。
- Pass `OIDC_REDIRECT_URI` 必须与 Pass 后台登记值逐字符一致，并落在故事站 Backend。
- client secret 仅由 Backend 保存。

### Pass

`TransCircle-Pass/config.toml.example` 中：

- `[OIDC_PROVIDER].ISSUER` 配置真实公开 issuer。
- `[FRONTEND].FRONTEND_URL` 指向主站门户 origin，生产通常为 `https://transcircle.org`。
- 故事站 client 使用最小 scope `openid profile email`；可信第一方策略由 Pass 管理员明确设置。

不存在 `pass.transcircle.org`。生产 Pass issuer 固定使用：

```text
https://api.transcircle.org/pass
```

## 发布验证

### 登录与会话

- [ ] 故事站 Navbar 桌面和移动“登录”均直接发起 Pass OIDC，不显示故事站登录选择页。
- [ ] 未登录 Pass：跳主站登录，完成后回到原故事站 path + query。
- [ ] 已登录 Pass、无故事站会话：静默 SSO 或主动授权无需再次输入凭据，并建立故事站本地会话。
- [ ] `/login`、`/register` 和历史本地账户 URL 不显示旧表单，只进入 Pass 授权或安全错误页。
- [ ] `/auth/callback` 使用一次性 loginCode 交换故事站 access token，完成后 URL 不保留可复用 code。
- [ ] 故事站登出只吊销故事站会话，不宣称同时退出 Pass；登出后刷新不会立刻静默回登。
- [ ] 主站/Pass access token、refresh token 或 Cookie 未作为故事站 API 凭据复用。

### 管理权限

- [ ] 普通 Pass 用户访问 `/admin` 只看到无权限状态，不获得 IAM 权限，也不循环登录。
- [ ] 明确的 IAM 管理流程强校验 `tc_app === "tc_story"`。
- [ ] IAM 权限按 `tc_story` 获取；Pass token 不解析 `tc_roles` / `tc_permissions`。

### 安全

- [ ] Pass OIDC 使用 Authorization Code + PKCE S256、state、nonce、RS256/JWKS。
- [ ] `redirectAfter` 拒绝绝对 URL、`//host`、反斜杠、控制字符和认证路由。
- [ ] callback 响应使用 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`。
- [ ] Refresh Cookie 为 HttpOnly、Secure（生产）、适当 SameSite，且故事站与 Pass Cookie 名称/用途隔离。
- [ ] 无 token、code、secret、完整会话或敏感用户信息进入日志。

### UI

- [ ] light/dark 两主题正常；不存在独立 high-contrast 模式要求。
- [ ] `zh-CN` / `zh-TW` 文案同步。
- [ ] 登录按钮使用真实 button，支持键盘和可见焦点。
- [ ] 移动抽屉开始登录前正确关闭，主内容不会残留 `inert`。
- [ ] 加载与错误状态有屏幕阅读器可读的 status/alert。
