# TransCircle 部署指南

## 架构总览

```
用户 → submit.transcircle.org (Cloudflare Pages, 前端 SPA)
          ↓  /v1/*  代理到后端
          → api.transcircle.org (Railway / Fly.io, Express + MySQL)
```

本仓库 `TransCircle-Frontend` 同时包含：

| 组件 | 路径 | 技术栈 |
|------|------|--------|
| 前端 SPA | `src/` | React + Vite，部署到 Cloudflare Pages |
| 后端 API | `functions/` | Express 5 + mysql2，部署到 Node.js 主机 |
| 数据库 | — | MySQL 8+（云服务或自建） |

---

## 目录

1. [前置准备](#1-前置准备)
2. [MySQL 数据库部署](#2-mysql-数据库部署)
3. [后端部署（Railway）](#3-后端部署-railway)
4. [后端部署（Fly.io 备选）](#4-后端部署-flyio-备选)
5. [前端部署（Cloudflare Pages）](#5-前端部署-cloudflare-pages)
6. [环境变量速查](#6-环境变量速查)
7. [本地开发快速启动](#7-本地开发快速启动)
8. [验证清单](#8-验证清单)

---

## 1. 前置准备

### 1.1 注册账号

| 服务 | 用途 | 注册链接 |
|------|------|----------|
| Cloudflare | 前端托管（免费计划即可） | https://dash.cloudflare.com |
| Railway / Fly.io | 后端运行（有免费额度） | https://railway.app / https://fly.io |
| MySQL 云服务 | 数据库 | Railway 内置 MySQL / PlanetScale / 阿里云 RDS |
| GitHub | 代码托管 + CI/CD | 已有 |

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

### 1.3 临时管理员令牌

```bash
openssl rand -hex 32
# 输出如：a1b2c3d4e5f6...（64 字符）
# 保存到 ADMIN.TEMP_ADMIN_TOKEN 配置
```

---

## 2. MySQL 数据库部署

### 2.1 Railway MySQL（推荐，与后端同平台）

1. Railway Dashboard → New Project → `Provision MySQL`
2. 等待创建完成，点击 MySQL 服务 → Connect → 复制连接信息
3. 记录以下值：
   - `MYSQL_URL`（例如 `mysql://user:password@host:port/database`）
   - 或分别记录 HOST / PORT / USER / PASSWORD / DATABASE

### 2.2 PlanetScale（备选）

1. https://planetscale.com → Create database → `transcircle`
2. 连接标签页 → 复制密码
3. 连接串格式：`mysql://user:password@aws.connect.psdb.cloud/transcircle?ssl={"rejectUnauthorized":true}`

### 2.3 阿里云 RDS（中国用户备选）

1. RDS 控制台 → 创建实例 → MySQL 8.0
2. 设置白名单：`0.0.0.0/0`（生产环境建议限缩到后端 IP）
3. 创建数据库：`create database transcircle character set utf8mb4 collate utf8mb4_unicode_ci;`

### 2.4 初始化表结构

连接成功后执行以下任一方式：

**方式 A：脚本自动执行**
```bash
cd functions
# 先配好 config.toml 的 DB_CONFIG 部分
# 或设环境变量：DB_CONFIG__DB_HOSTNAME DB_CONFIG__DB_USERNAME 等
npm run db:setup
```

**方式 B：手动导入**
```bash
# 用 MySQL CLI
mysql -h <host> -u <user> -p transcircle < functions/schema.sql
```

**方式 C：Railway 内置**
```bash
# Railway CLI
railway run --service transcircle-db "mysql -u root < functions/schema.sql"
```

---

## 3. 后端部署（Railway）

### 3.1 项目结构准备

Railway 可以部署本仓库的 `functions/` 子目录。需要先调整 `functions/package.json` 让它能在 Railway 上被正确识别：

```diff
 // functions/package.json
 {
   "name": "transcircle-backend",
   "scripts": {
     "start": "node dist/Index.js",
     "build": "tsc",
+    "postinstall": "npm run build"
   }
 }
 ```

 > 或通过 Railway Dashboard -> Start Command 手动设为 `node dist/Index.js`

### 3.2 部署步骤

1. **Railway Dashboard** → New Project → `Deploy from GitHub repo`
2. 选择 `TransCircle/TransCircle-Frontend` 仓库
3. **关键：设置 Root Directory 为 `functions/`**
   - 在 Railway 项目设置 → Root Directory → 输入 `functions`
4. Railway 会自动检测 `package.json` 并执行 `npm install` + `postinstall`（build）

### 3.3 配置环境变量

在 Railway Dashboard → 项目 → Variables 中设置以下环境变量：

```env
# NODE_ENV 必须设为 production
NODE_ENV=production

# 数据库
DB_CONFIG__DB_HOSTNAME=<你的 MySQL 主机>
DB_CONFIG__DB_PORT=3306
DB_CONFIG__DB_USERNAME=<用户名>
DB_CONFIG__DB_PASSWORD=<密码>
DB_CONFIG__DB_DATABASE=transcircle

# Session / JWT 密钥（务必修改为随机字符串！）
SESSION__SESS_SECRET=<openssl rand -hex 32>
SESSION__SESS_MAXAGE=86400

# 服务端口（Railway 自动分配 80/443，也可固定）
SERV_CONFIG__SERV_PORT=1145

# OAuth
OAUTH__GITHUB_CLIENT_ID=<从 GitHub OAuth App 获取>
OAUTH__GITHUB_CLIENT_SECRET=<从 GitHub OAuth App 获取>
OAUTH__X_CLIENT_ID=<从 X Developer Portal 获取>
OAUTH__X_CLIENT_SECRET=<从 X Developer Portal 获取>

# 管理员
ADMIN__TEMP_ADMIN_TOKEN=<openssl rand -hex 32>

# CORS — 允许前端域名
CORS__ALLOWED_ORIGINS=https://submit.transcircle.org,https://*.transcircle.pages.dev

# 前端 URL（用于 OAuth 回调跳转）
APP_URL=https://submit.transcircle.org
```

### 3.4 获取后端域名

Railway 部署完成后会自动分配一个域名，例如 `transcircle-frontend.up.railway.app`。

在 Railway Dashboard → Networking → Generate Domain，得到 `*.railway.app` 域名。
**记下这个域名**，稍后需要配到前端的 `API_BASE`。

### 3.5 更新 OAuth 回调 URL

部署完成后，回到 GitHub OAuth App 和 X Developer Portal，将回调 URL 更新为实际域名：

```
https://<railway-domain>/v1/auth/oauth/github/callback
https://<railway-domain>/v1/auth/oauth/x/callback
```

---

## 4. 后端部署（Fly.io 备选）

> 如果 Railway 在中国访问慢，可选用 Fly.io

### 4.1 安装 flyctl

```bash
# macOS / Linux
curl -fsSL https://fly.io/install.sh | sh

# Windows (Git Bash)
curl -fsSL https://fly.io/install.sh | sh

# 登录
fly auth login
```

### 4.2 创建 fly.toml

在 `functions/` 目录下创建 `fly.toml`：

```toml
app = "transcircle-api"
primary_region = "hkg"  # 香港节点

[build]
  builder = "heroku/buildpacks:20"

[http_service]
  internal_port = 1145
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
```

### 4.3 部署

```bash
cd functions
fly launch --no-deploy
fly secrets set \
  NODE_ENV=production \
  DB_CONFIG__DB_HOSTNAME=... \
  DB_CONFIG__DB_USERNAME=... \
  DB_CONFIG__DB_PASSWORD=... \
  DB_CONFIG__DB_DATABASE=transcircle \
  SESSION__SESS_SECRET=... \
  OAUTH__GITHUB_CLIENT_ID=... \
  OAUTH__GITHUB_CLIENT_SECRET=... \
  OAUTH__X_CLIENT_ID=... \
  OAUTH__X_CLIENT_SECRET=... \
  ADMIN__TEMP_ADMIN_TOKEN=... \
  CORS__ALLOWED_ORIGINS=https://submit.transcircle.org \
  APP_URL=https://submit.transcircle.org
fly deploy
```

部署完成后：
```bash
fly open
# 得到 https://transcircle-api.fly.dev/
```

---

## 5. 前端部署（Cloudflare Pages）

### 5.1 配置生产 API 地址

部署前确保 `src/config.ts` 的生产环境 `API_BASE` 指向实际后端域名：

```ts
const API_BASE: string = import.meta.env.PROD
  ? 'https://<后端域名>'   // ← 改为 Railway 或 Fly.io 域名
  : '/v1'
```

> 例如：`'https://transcircle-frontend.up.railway.app'`

### 5.2 方式 A：通过 GitHub Actions（推荐）

已有 `.github/workflows/deploy.yml`，在仓库 Settings → Secrets and variables → Actions 添加：

| Secret | 值 |
|--------|-----|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（见下方说明） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard 右侧的 Account ID |

**获取 Cloudflare API Token：**

1. Cloudflare Dashboard → My Profile → API Tokens → Create Token
2. 选 **Create Custom Token**：

| 字段 | 值 |
|------|-----|
| Permissions → Account → Cloudflare Pages | `Edit` |
| Account Resources | 当前账号 |
| TTL | 365 days |

3. 复制生成的 token

### 5.3 方式 B：手动部署

```bash
# 1. 构建
pnpm install
pnpm run build

# 2. 部署
npx wrangler pages deploy dist --project-name=transcircle-submit --branch=main
```

### 5.4 绑定自定义域名

1. Cloudflare Dashboard → Workers & Pages → `transcircle-submit`
2. Custom domains → Add custom domain → 输入 `submit.transcircle.org`
3. 在 DNS 提供商处添加 CNAME 记录指向 `transcircle-submit.pages.dev`
4. 等待 SSL 证书签发（几分钟）

### 5.5 更新 CORS 配置

回到后端环境变量，确保 `CORS__ALLOWED_ORIGINS` 包含前端域名：

```
CORS__ALLOWED_ORIGINS=https://submit.transcircle.org,https://*.transcircle.pages.dev
```

---

## 6. 环境变量速查

### 所有配置项（对应 config.toml 各段）

| 环境变量 | 对应 TOML | 说明 |
|----------|-----------|------|
| `NODE_ENV` | — | `production` 启用安全模式（secure cookie 等） |
| `DB_CONFIG__DB_HOSTNAME` | `[DB_CONFIG] DB_HOSTNAME` | MySQL 主机 |
| `DB_CONFIG__DB_PORT` | `[DB_CONFIG] DB_PORT` | MySQL 端口，默认 3306 |
| `DB_CONFIG__DB_USERNAME` | `[DB_CONFIG] DB_USERNAME` | MySQL 用户名 |
| `DB_CONFIG__DB_PASSWORD` | `[DB_CONFIG] DB_PASSWORD` | MySQL 密码 |
| `DB_CONFIG__DB_DATABASE` | `[DB_CONFIG] DB_DATABASE` | 数据库名，默认 transcircle |
| `SESSION__SESS_SECRET` | `[SESSION] SESS_SECRET` | JWT 签名密钥（必改！） |
| `SESSION__SESS_MAXAGE` | `[SESSION] SESS_MAXAGE` | Refresh token 有效期（秒），默认 86400 |
| `SERV_CONFIG__SERV_PORT` | `[SERV_CONFIG] SERV_PORT` | Express 监听端口，默认 1145 |
| `OAUTH__GITHUB_CLIENT_ID` | `[OAUTH] GITHUB_CLIENT_ID` | GitHub OAuth Client ID |
| `OAUTH__GITHUB_CLIENT_SECRET` | `[OAUTH] GITHUB_CLIENT_SECRET` | GitHub OAuth Client Secret |
| `OAUTH__X_CLIENT_ID` | `[OAUTH] X_CLIENT_ID` | X OAuth 2.0 Client ID |
| `OAUTH__X_CLIENT_SECRET` | `[OAUTH] X_CLIENT_SECRET` | X OAuth 2.0 Client Secret |
| `ADMIN__TEMP_ADMIN_TOKEN` | `[ADMIN] TEMP_ADMIN_TOKEN` | 临时管理员令牌 |
| `CORS__ALLOWED_ORIGINS` | `[CORS] ALLOWED_ORIGINS` | 允许的前端域名，逗号分隔 |
| `APP_URL` | — | 前端 URL（OAuth 回调跳转用） |
| `DEBUG_CONFIG__DEBUG_MODE` | `[DEBUG_CONFIG] DEBUG_MODE` | 调试模式，生产关掉 |

> 环境变量名 = `TOML段名__键名`，双下划线分隔。
> 所有配置可混用：既可以用 `config.toml` 文件，也可以用环境变量覆盖。
> 生产环境**推荐全用环境变量**，不部署 `config.toml` 文件。

---

## 7. 本地开发快速启动

### 7.1 启动数据库

```bash
# 确保本地 MySQL 运行中
# 建库（如果还没有）
mysql -u root -e "CREATE DATABASE IF NOT EXISTS transcircle CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
# 导表结构
mysql -u root transcircle < functions/schema.sql

# 或一键脚本
cd functions && npx tsx src/setup.ts
```

### 7.2 启动后端

```bash
# 在 functions/ 目录下
cd functions
cp config.toml.example config.toml  # 按需编辑
npm install
npm run dev
# → http://localhost:1145
```

### 7.3 启动前端

```bash
# 在项目根目录下
cd TransCircle-Frontend
npm install
npm run dev
# → http://localhost:5173 （自动代理 /v1 → :1145）
```

### 7.4 同时启动前后端

```bash
npm run dev:all
# 前端 :5173 + 后端 :1145 同时运行
```

---

## 8. 验证清单

### 前端验证

- [ ] `submit.transcircle.org` 可访问，页面正常渲染
- [ ] 投稿页面 → 填写表单 → 匿名投稿成功，返回 TC-xxx ID
- [ ] GitHub OAuth 登录 → 跳转到 GitHub → 授权 → 跳回，登录状态显示
- [ ] X OAuth 登录 → 同理
- [ ] 已登录用户投稿 → 投稿关联到账号

### 后端验证

- [ ] `GET /v1/health` 返回 `{"status":"ok","timestamp":...}`
- [ ] `POST /v1/contributions` 匿名投稿返回 201
- [ ] `POST /v1/auth/oauth/exchange` 正确兑换 loginCode
- [ ] `POST /v1/admin/contributions/:id/review` 审核通过/拒绝正常（需 admin 身份）
- [ ] 限流生效：`X-RateLimit-Limit` 和 `X-RateLimit-Remaining` 响应头存在
- [ ] CORS 正确：非允许域名返回 403 / 无响应

### 安全验证

- [ ] Refresh token 是 `HttpOnly` cookie，JS 不可读
- [ ] 临时管理员令牌不在生产环境长期使用
- [ ] `SESSION__SESS_SECRET` 已改为随机字符串，非默认值
- [ ] HTTPS 已启用（Cloudflare + Railway/Fly.io 自动）
- [ ] 投稿 honeypot 字段可以拦截简单爬虫

---

## 调试技巧

### 查看后端日志

```bash
# Railway
railway logs --service transcircle-api

# Fly.io
fly logs
```

### 测试 API

```bash
# 健康检查
curl https://<backend-domain>/v1/health

# 匿名投稿
curl -X POST https://<backend-domain>/v1/contributions \
  -H 'Content-Type: application/json' \
  -d '{"title":"测试","content":"测试正文","category":"观点评论","submitMode":"submit"}'

# 带 token 的管理接口
curl https://<backend-domain>/v1/admin/contributions?status=pending \
  -H 'Authorization: Bearer <temp-admin-token>'
```

### 常见问题

| 问题 | 排查 |
|------|------|
| 前端 404 | Check `wrangler.jsonc` 的 `pages_build_output_dir` 是否为 `dist` |
| API 返回 502 | 后端未启动或端口不对，检查 `SERV_CONFIG__SERV_PORT` |
| OAuth 回调失败 | 回调 URL 必须与 OAuth App 注册时完全一致（含末尾斜杠） |
| 数据库连接失败 | 检查白名单、SSL 模式、凭据是否正确 |
| CORS 错误 | 检查 `CORS__ALLOWED_ORIGINS` 是否包含当前前端域名 |
