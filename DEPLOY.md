# 合入 main 后的部署清单

## 0. Cloudflare API Token（CI/CD 必需）

### 获取 Account ID

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 登录后，右侧边栏顶部可见 **Account ID**，点击复制
3. 也可从 URL 获取：`https://dash.cloudflare.com/<Account ID>`

### 创建 API Token

1. Cloudflare Dashboard → 右上角头像 → **My Profile**
2. 左侧 **API Tokens** → 点 **Create Token**
3. 选 **Create Custom Token**，配置：

   | 字段 | 值 |
   |------|-----|
   | Token name | `TransCircle-GitHub-Actions` |
   | Permissions → Account → Cloudflare Pages | `Edit` |
   | Permissions → Account → D1 | `Edit` |
   | Permissions → Account → Workers Scripts | `Edit` |
   | Account Resources | 选择当前账号 |
   | TTL | 365 days |

4. **Continue to summary** → **Create Token**
5. **立即复制 Token**（只显示一次，刷新后不可见）

### 添加 GitHub Secrets

1. GitHub → TransCircle-Frontend 仓库 → **Settings** → **Secrets and variables** → **Actions**
2. 点击 **New repository secret**，添加：
   - `CLOUDFLARE_API_TOKEN` = 上面复制的 Token
   - `CLOUDFLARE_ACCOUNT_ID` = 你的 Account ID

## 1. Cloudflare D1 数据库

```bash
# 用刚才的 Token 登录
npx wrangler login
# 或设置环境变量
# export CLOUDFLARE_API_TOKEN=xxx
# export CLOUDFLARE_ACCOUNT_ID=xxx

# 创建生产数据库
npx wrangler d1 create transcircle-submissions

# 记录输出的 database_id
# 替换 wrangler.jsonc 中的 PLACEHOLDER_D1_ID

# 执行迁移
npx wrangler d1 execute transcircle-submissions \
  --file=./migrations/0001_submissions.sql \
  --remote
```

## 2. Cloudflare Pages 项目

1. Dashboard → Workers & Pages → Create → Pages → Connect to Git
2. 选择 `TransCircle/TransCircle-Frontend` 仓库
3. Build settings:
   - Build command: `pnpm run build`
   - Output directory: `dist`
4. 绑定 D1：变量名 `DB`，选择 `transcircle-submissions`

## 3. Pages 环境变量（Settings → Environment variables）

所有变量统一在 Cloudflare Dashboard 管理，wrangler.jsonc 仅保留三个非敏感常量。

### 必需（生产运行依赖）

| 变量 | 说明 | 加密 |
|------|------|------|
| `SESSION_SECRET` | `openssl rand -hex 32` 生成，JWT 签名密钥 | 🔒 Secret |
| `TEMP_ADMIN_TOKEN` | 临时管理员令牌（OAuth 可用前唯一管理入口）| 🔒 Secret |

### OAuth（登录功能需要）

| 变量 | 说明 | 加密 |
|------|------|------|
| `GITHUB_CLIENT_ID` | GitHub OAuth App Client ID | 明文 |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App Client Secret | 🔒 Secret |
| `X_CLIENT_ID` | X OAuth 2.0 Client ID | 明文 |
| `X_CLIENT_SECRET` | X OAuth 2.0 Client Secret | 🔒 Secret |

### 可选

| 变量 | 说明 | 加密 |
|------|------|------|
| `STORY_REPO_TOKEN` | GitHub PAT (repo scope)，审核通过自动构建 story 站点 | 🔒 Secret |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile Site Key | 明文 |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile Secret Key | 🔒 Secret |

> **注意**：`GITHUB_ORG`、`STORY_REPO_OWNER`、`STORY_REPO_NAME` 已硬编码在 `wrangler.jsonc`，无需在 Dashboard 重复设置。

## 5. 验证

- [ ] `submit.transcircle.org` 可访问，投稿表单正常渲染
- [ ] 匿名投稿 → 返回 TC-xxx 编号
- [ ] `/admin` → 输入 TEMP_ADMIN_TOKEN → 看到投稿列表
- [ ] 审核通过/拒绝操作正常
- [ ] 连续 POST >10 次 → 返回 429

## 可选后续

- [ ] 在 GitHub 创建 OAuth App → 配置 callback → 启用 GitHub 登录
- [ ] 在 X Developer Portal 创建 OAuth 2.0 App → 启用 X 登录
- [ ] 配置 Turnstile → 在 SubmitForm 中接入验证码组件
- [ ] 创建 `story.transcircle.org` 仓库 → 配置 CF Pages → 放入 story/ 目录文件
- [ ] 创建 GitHub PAT（`STORY_REPO_TOKEN`）→ 启用审核通过自动构建
