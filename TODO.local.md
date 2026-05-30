# TransCircle-Frontend 开发 TODO

来源: https://github.com/TransCircle/docs/blob/main/TODO.md

---

## 1. 投稿表单 — submit.transcircle.org

- [ ] Serverless 投稿表单
- [ ] 避免滥用的安全规则（频率限制、Honeypot、CAPTCHA）
- [ ] GitHub OAuth 登录（可认领投稿）
- [ ] X OAuth 登录
- [ ] 匿名投稿（无需登录）

## 2. 审核后台

- [ ] 项目组成员 GitHub 登录
- [ ] 投稿列表（待审核 / 已通过 / 已拒绝）
- [ ] 审核操作：通过 / 拒绝 / 要求修改

## 3. 自动构建流水线

- [ ] 审核通过 → 触发静态网页构建
- [ ] 展示投稿的页面纯静态

## 4. 投稿展示 — story.transcircle.org

- [ ] 纯静态展示站点
- [ ] 筛选 / 分类功能
- [ ] 跳转投稿站点

---

## 本地开发

```bash
pnpm install    # 装依赖
pnpm dev        # 启动 dev server
pnpm build      # 构建验证
```
