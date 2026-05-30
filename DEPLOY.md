# 合入 main 后的部署清单

## 1. Cloudflare D1 数据库

```bash
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

## 3. Secrets（Settings → Environment variables → Add secret）

| 变量 | 说明 |
|------|------|
| `TEMP_ADMIN_TOKEN` | 临时管理员令牌（OAuth 配置完成前必设） |
| `SESSION_SECRET` | `openssl rand -hex 32` 生成 |
| `GITHUB_CLIENT_ID` | GitHub OAuth App（可选） |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App（可选） |
| `X_CLIENT_ID` | X OAuth App（可选） |
| `X_CLIENT_SECRET` | X OAuth App（可选） |
| `STORY_REPO_TOKEN` | GitHub PAT，自动构建用（可选） |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile（可选） |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile（可选） |

## 4. 非敏感环境变量

| 变量 | 值 |
|------|-----|
| `GITHUB_ORG` | `TransCircle` |
| `STORY_REPO_OWNER` | `TransCircle` |
| `STORY_REPO_NAME` | `story.transcircle.org` |
| `GITHUB_CLIENT_ID` | GitHub OAuth Client ID（非敏感，可放这里） |
| `X_CLIENT_ID` | X OAuth Client ID（非敏感，可放这里） |
| `TURNSTILE_SITE_KEY` | Turnstile Site Key（非敏感，可放这里） |

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
