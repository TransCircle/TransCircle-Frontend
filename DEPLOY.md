# TransCircle 部署指南

## 架构总览

```
用户 → submit.transcircle.org (Cloudflare Pages, 前端 SPA)
           ↓  /v1/*  代理到后端
           → api.transcircle.org (Express + MySQL，独立部署)
```

| 组件     | 代码仓库                      | 技术栈                                  |
| -------- | ----------------------------- | --------------------------------------- |
| 前端 SPA | `TransCircle-Frontend`        | React + Vite，部署到 Cloudflare Pages   |
| 后端 API | `TransCircle-Backend-develop` | Express 5 + MySQL (Sequelize)，独立部署 |
| 数据库   | —                             | MySQL 8+（云服务或自建）                |

> **注意**：后端 API 和数据库由 `TransCircle-Backend-develop` 仓库管理。
> 本仓库仅负责前端 SPA 的构建和部署。

---

## 目录

1. [前置准备](#1-前置准备)
2. [前端部署（Cloudflare Pages）](#2-前端部署-cloudflare-pages)
3. [环境变量速查](#3-环境变量速查)
4. [本地开发快速启动](#4-本地开发快速启动)
5. [验证清单](#5-验证清单)

---

## 1. 前置准备

### 1.1 注册账号

| 服务       | 用途                     | 注册链接                    |
| ---------- | ------------------------ | --------------------------- |
| Cloudflare | 前端托管（免费计划即可） | https://dash.cloudflare.com |
| GitHub     | 代码托管 + CI/CD         | 已有                        |

### 1.2 OAuth App 注册

**GitHub OAuth App：**

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. 填写：
   - Application name: `TransCircle`
   - Homepage URL: `https://submit.transcircle.org`（开发期用 `http://localhost:5173`）
   - Authorization callback URL: `https://api.transcircle.org/v1/auth/oauth/github/callback`
3. 保存后复制 **Client ID** 和 **Client Secret**

**X (Twitter) OAuth 2.0：**

1. https://developer.twitter.com → Projects & Apps → 你的项目 → User authentication settings
2. App permissions: `Read`
3. Type of App: `Web App, Automated App or Bot`
4. Callback URI / Redirect URL: `https://api.transcircle.org/v1/auth/oauth/x/callback`
5. 保存后复制 **Client ID** 和 **Client Secret**

---

## 2. 前端部署（Cloudflare Pages）

### 2.1 配置生产 API 地址

部署前确保 `src/config.ts` 的生产环境 `API_BASE` 指向实际后端域名：

```ts
export const API_BASE: string = '/v1'
```

> 生产和开发均使用相对路径，通过 Cloudflare 的 `wrangler.jsonc` 代理配置将 `/v1/*` 指向后端。

### 2.2 方式 A：通过 GitHub Actions（推荐）

已有 `.github/workflows/deploy.yml`，在仓库 Settings → Secrets and variables → Actions 添加：

| Secret                  | 值                                     |
| ----------------------- | -------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token                   |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard 右侧的 Account ID |

**获取 Cloudflare API Token：**

1. Cloudflare Dashboard → My Profile → API Tokens → Create Token
2. 选 **Create Custom Token**：

| 字段                                     | 值       |
| ---------------------------------------- | -------- |
| Permissions → Account → Cloudflare Pages | `Edit`   |
| Account Resources                        | 当前账号 |
| TTL                                      | 365 days |

3. 复制生成的 token

### 2.3 方式 B：手动部署

```bash
# 1. 构建
pnpm install
pnpm run build

# 2. 部署
npx wrangler pages deploy dist --project-name=transcircle-submit --branch=main
```

### 2.4 绑定自定义域名

1. Cloudflare Dashboard → Workers & Pages → `transcircle-submit`
2. Custom domains → Add custom domain → 输入 `submit.transcircle.org`
3. 在 DNS 提供商处添加 CNAME 记录指向 `transcircle-submit.pages.dev`
4. 等待 SSL 证书签发（几分钟）

---

## 3. 环境变量速查

所有配置通过 Cloudflare Pages 的 Environment Variables 或 `wrangler.jsonc` 设置。

| 变量                    | 说明                                |
| ----------------------- | ----------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token（仅 CI 使用）  |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID（仅 CI 使用） |

---

## 4. 本地开发快速启动

### 4.1 启动前端

```bash
cd TransCircle-Frontend
pnpm install
pnpm run dev
# → http://localhost:5173 （自动代理 /v1 → http://localhost:1145）
```

### 4.2 重要提醒

后端 API 由 `TransCircle-Backend-develop` 仓库管理。
本地开发时需同时启动该仓库的后端服务，或通过 `vite.config.ts` 的 proxy 配置指向远程 API。

---

## 5. 验证清单

### 前端验证

- [ ] `submit.transcircle.org` 可访问，页面正常渲染
- [ ] 投稿页面 → 填写表单 → 投稿成功，返回 ID
- [ ] GitHub OAuth 登录 → 跳转到 GitHub → 授权 → 跳回，登录状态显示
- [ ] X OAuth 登录 → 同理
- [ ] 已登录用户投稿 → 投稿关联到账号
- [ ] 响应式布局正常（移动端/桌面端）
- [ ] 主题切换（亮色/暗色/高对比度）正常工作
- [ ] 中/繁切换正常工作

### 安全验证

- [ ] Refresh token 是 `HttpOnly` cookie，JS 不可读
- [ ] HTTPS 已启用（Cloudflare 自动）
- [ ] 所有用户可见文本均通过 i18n 包装
- [ ] 无障碍属性正确（aria-\*、role、键盘导航）
