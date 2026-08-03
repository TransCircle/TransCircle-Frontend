# TransCircle Web

TransCircle Web 是 TransCircle 项目的前端应用仓库。

该仓库代码目前尚未部署，请在本地进行测试。

该仓库用于承载：

- 故事投稿页
- 审核后台
- 用户的故事站资料与投稿管理

主导航站及 TransCircle Pass 用户门户位于 `transcircle-main`。故事站不提供独立的账号密码或注册界面：普通用户登录直接发起 Pass OIDC，需要认证时在主站门户完成；回调后由故事站后端建立独立业务会话。管理员权限通过独立的 IAM `tc_story` 流程获得，不由 Pass 登录继承。

---

## Tech Stack

- React 19
- TypeScript
- Vite
- React Router DOM
- CSS Modules
- md-editor-rt

---

## Development

安装依赖：

```bash
pnpm install
```

启动开发服务器：

```bash
pnpm dev
```

构建项目：

```bash
pnpm build
```

预览生产构建：

```bash
pnpm preview
```

---

## Project Structure

```text
src/
├── components/     # Reusable UI components
├── context/        # Theme system and global contexts
├── layouts/        # Root layout
├── pages/          # Route pages
├── router/         # React Router config
├── styles/         # Shared styles
└── assets/         # Static assets
```

---

## Theme System

项目支持：

- Light mode
- Dark mode

主题通过 CSS Variables 实现，颜色对比度由两套主题令牌保证。

详细规范见：

- DESIGN.md

---

## Accessibility

TransCircle 优先考虑可访问性：

- Keyboard navigation
- Focus-visible styles
- ARIA support
- Reduced motion support
- Light/dark token contrast

---

## License

This project is part of the TransCircle Project.
