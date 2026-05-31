# TransCircle-Frontend 待办

> 2026-05-30 更新 — PR #2 代码审查修复 + apidocs.md 对齐完成后

---

## 立即

- [ ] 更新 PR #2 description：架构图 `/api/*` → `/v1/*`，反映 Express+MySQL 后端
- [ ] 移动端实机截图验证（E1）— iPhone/Android 各一，检查投稿表单 MdEditor 高度

---

## 短期（本周）

- [ ] 本地启动完整流程：`pnpm dev`（前端）+ Backend-develop（Express），投稿 → 审核完整链路
- [ ] 配置 GitHub OAuth App，测试登录 → 投稿关联 → 审核完整链路

---

## 中期

- [ ] `story/` → TransCircle/story.transcircle.org 独立仓库
- [x] `pending_registration` 前端注册页面（调 complete-registration）
- [x] 对接 TransCircle-Backend，下线 `functions/` 旧 BFF

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
