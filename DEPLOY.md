# 部署清单

## 0. Cloudflare API Token（CI/CD）

1. Cloudflare Dashboard → My Profile → API Tokens → Create Token
2. 选 **Create Custom Token**，配置：

| 字段 | 值 |
|------|-----|
| Permissions → Account → Cloudflare Pages | `Edit` |
| Account Resources | 当前账号 |
| TTL | 365 days |

3. GitHub → 仓库 Settings → Secrets and variables → Actions，添加：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`

## 1. 后端部署（Express + MySQL）

> 参见 TransCircle-Backend-develop 仓库，不在此前端仓库管理。

## 2. Cloudflare Pages（前端静态托管）

1. Dashboard → Workers & Pages → Create → Pages → Connect to Git
2. 选择 `TransCircle/TransCircle-Frontend`，Build settings:
   - Build command: `pnpm run build`
   - Output directory: `dist`
3. **不需要绑定 D1**（后端已迁移到 Express + MySQL）

## 3. 验证

- [ ] `submit.transcircle.org` 可访问
- [ ] 匿名投稿正常
- [ ] `/admin` 登录后可用
- [ ] 审核通过/拒绝正常
