# TransCircle Web

TransCircle Web 是 TransCircle 项目的前端应用仓库。

该仓库代码目前尚未部署，请在本地进行测试。

该仓库用于承载：

- 故事投稿页
- 审核后台
- 后续社区功能页面

主导航站（Landing Page）位于独立仓库中，本仓库专注于 Web App 功能开发。

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
- High contrast mode

主题通过 CSS Variables 实现。

详细规范见：

- DESIGN.md

---

## Accessibility

TransCircle 优先考虑可访问性：

- Keyboard navigation
- Focus-visible styles
- ARIA support
- Reduced motion support
- High contrast mode

---

## License

This project is part of the TransCircle Project.
