# TransCircle-Frontend 待办

> 2026-05-30 更新 — PR #2 代码审查修复 + apidocs.md 对齐完成后

---

## 立即

- [ ] 更新 PR #2 description：架构图 `/api/*` → `/v1/*`，post-merge setup 补充 D1 表
- [ ] 移动端实机截图验证（E1）— iPhone/Android 各一，检查投稿表单 MdEditor 高度

---

## 短期（本周）

- [ ] 本地启动完整流程：`pnpm dev` → /submit 投稿 → /admin 审核通过 → story 重建
- [ ] 配置 GitHub OAuth App，测试登录 → 投稿关联 → 审核完整链路
- [ ] D1 创建 + migration 执行 + 部署到 CF Pages
- [ ] 验证 D1 限流在多 isolate 下共享生效

---

## 中期

- [ ] `story/` → TransCircle/story.transcircle.org 独立仓库
- [ ] `pending_registration` 前端注册页面（调 complete-registration）
- [ ] Turnstile 集成（`TURNSTILE_*` 已预留）
- [ ] 审核历史页面（展示 `contribution_review_events`）
- [ ] 对接 TransCircle-Backend（`api.transcircle.org`），下线 BFF

---

## 长期

- [ ] 草稿功能 `submitMode: draft`
- [ ] 投稿修改申请（apidocs.md §10）
- [ ] 图片上传（apidocs.md §11）
- [ ] 邮箱验证流程（apidocs.md §1.2）
- [ ] 社区功能扩展

---

## 本地开发

```bash
cd C:/BaiduNetdiskDownload/claude/TS/TransCircle-Frontend
pnpm dev        # 启动 dev server
pnpm build      # tsc -b && vite build
```
