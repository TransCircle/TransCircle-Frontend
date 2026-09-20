# TransCircle-Frontend — 设计落地说明

> **本文件不是设计规范源。**
>
> 唯一视觉规范源是仓库外的全局文档
> **`TransCircle/docs/DESIGN.md` —— 「TransCircle 设计系统 v3.0 / Spectrum·光谱」**。
>
> 一切色值、圆角、字阶、间距、阴影、动效时长、层级都以该文档 §2 为准；
> 要改值，先改那份文档，再同步三仓的 token 文件。本文件只记录**本仓特有的落地方式**。

本文件此前自称 single source of truth —— v3.0 之后该说法已不成立：
三仓（TransCircle / TransCircle-Frontend / blog）共用一套规范，各自只维护 token 文件。
旧版中与全局规范冲突的一切数值与组件描述均已作废，以全局文档为准。

---

## 1. 本仓的规范锚点

| 项                               | 位置                         |
| -------------------------------- | ---------------------------- |
| token 文件（全局规范的本仓落地） | `src/styles/index.css`       |
| 字体资产（latin 子集 woff2）     | `public/fonts/`              |
| 字体 preload                     | `index.html` `<head>`        |
| 公共阅读侧词表                   | `src/pages/Story.module.css` |
| 后台工具侧词表                   | `src/pages/Page.module.css`  |

暗色主题在 `src/styles/index.css` 里走**双通道**声明：
`[data-theme='dark']`（JS 控制）+ `@media (prefers-color-scheme: dark)`（无 JS 回退）。
**两处必须逐条同步**；漏改一处会造成「系统暗色下正常、手动切换后错乱」这类
只在一条路径上复现的问题。

全局规范指定了值但没给名字的几个量，本仓统一命名（见 `index.css` 的「落地补充」段）：
`--on-pink`（粉面上的墨字 `#210A16`）、`--pink-600-hover`、`--ring-pink` / `--ring-error`
（焦点环，含 `color-mix` 不可用时的硬编码回退）、`--btn-h` / `--control-h` / `--page-x`。

中文不使用 webfont，标题使用 `--font-sans` 并保持自然字距；
Nunito Brand 仅用于 TransCircle 品牌词，Space Grotesk 用于数字与 eyebrow 标签。

---

## 2. 两套词表分治（本仓最重要的结构决定）

公共阅读侧与后台工具侧**刻意不共用样式**。此前两侧共用一套，
结果是「讲人的故事的地方长得跟工单队列一模一样」。

|          | 公共侧 `Story.module.css`                       | 后台侧 `Page.module.css`                          |
| -------- | ----------------------------------------------- | ------------------------------------------------- |
| 正文基准 | 16px（`--fs-body`），**不得下调**               | 允许 14px（`--fs-sm`）密度基准（全局 §5.8）       |
| 卡片     | `--r-md` + hover 浮起 3px + 描边染 `--pink-300` | 行式列表，hover 铺 `--surface-2`                  |
| 粉色含义 | 强调与身份                                      | **仅表示「选中/激活」**；只读面一律 `--surface-2` |
| 诉求     | 可读、留白、有呼吸                              | 一屏看到尽量多条目                                |

改动任一侧时不要顺手把类抽到另一侧复用——这两套词表的分歧是设计意图，不是重复。

---

## 3. 故事流结构（公共侧）

首页 `Home.tsx` + `Story.module.css`：

- **卡片网格** `.feed` = `repeat(auto-fill, minmax(320px, 1fr))`；≤640px 回落单列
  （320px 下限在小屏会溢出）。
- **特色卡** `.entryFeatured` / `.featuredLink`：横跨整行，`--r-lg`，顶部一条 3px
  旗帜条纹（`.flagStripe`，**三个实色 `<span>`，禁止渐变**，白段靠 inset 描边在亮底显形）。
  只在「非搜索 + 第 1 页」出现；优先取第一条置顶稿，无置顶时取信息流头条。
- **卡片三段结构**：元信息行（署名 + 时间 + 标签 chip）/ 标题（2 行截断）/ 摘要（2 行截断）。
- **滚动 reveal**：`useReveal` hook + 全局 `.reveal` / `.is-visible`（定义在 `index.css`），
  交错延迟由各元素的 `--i` 决定。

阅读页 `PublicContributionDetail.tsx` 复用同一词表的 `.reading` / `.article` / `.prose` 段，
外加 `useReadingProgress` 驱动的顶部进度条（`.progressTrack` / `.progressBar`，
固定在顶栏下方 2px，`scaleX` 随滚动，不走 React state）。

### 旗帜条纹的配额

全局 §1.5 规定旗帜条纹**每屏至多一处**。本仓当前的分配：

1. 顶栏当前项的 24×3px 迷你指示条（`Navbar.module.css` `.flagStripe`）——全局 §3.1 单列的场景；
2. 首页特色卡顶部的整条（`Story.module.css` `.flagStripe`）。

页脚顶部虽也是 §3.1 允许的位置，**本仓刻意不放**，否则首页同屏会出现三处。
新增任何条纹前先数一遍这张表。

---

## 4. 页面 landmark 规则（不随视觉改版变动）

路由组件渲染 `.page` **`<div>`**（或 `<CenteredCard>`），**绝不自己渲染 `<main>`** ——
`RootLayout`（公共侧）与 `AdminShell`（后台）各自持有唯一的 `<main>`。

_例外：_ 路由 `errorElement`（`ErrorBoundaryPage`）渲染在 RootLayout 之外，
需自带 `<main>`（通过 `<CenteredCard as="main">`）。

认证、状态、OAuth、错误页统一用居中卡（`<CenteredCard>` / `<StatusScreen>`），
v3.0 起该卡为玻璃面板 + `--r-lg`（属全局 §1.4 允许的「悬浮卡」场景，带实色回退）。

---

## 5. 原生控件政策（本仓保留的硬约束）

文本输入**必须**保持原生 `<input>` / `<textarea>`：中文依赖输入法组字（composition），
只有原生表单元素才有完整 IME 支持；换成 `contenteditable` 自绘会破坏拼音候选、
光标定位与移动端键盘。

做法是保留原生元素、把原生**外观**全部关掉，见 `Field.module.css`：

- `appearance: none`（去掉 iOS 圆角/内阴影与 Windows 凹陷边框）
- `:-webkit-autofill` 用 100px `inset` 阴影盖掉——Chrome 自动填充自绘背景，忽略 `background-color`
- `::-webkit-search-*` 装饰移除，清除按钮自绘
- `::-webkit-{inner,outer}-spin-button` 移除
- `::placeholder` 透明度重置（Firefox 默认压暗）

粗指针下输入字号抬到 16px —— iOS Safari 对更小的输入框会在聚焦时缩放整页。

其余控件（Select / Checkbox / RadioGroup / TagInput）在 `src/components/ui/` 自绘；
不要再造第二套，也不要退回原生 `<select>` 或 `window.confirm()`。

---

## 6. 动效与降级

- 全局降级在 `index.css` 末尾，用 `!important` 压过一切组件声明；
  组件内无需再写 `prefers-reduced-motion` 块。
- `.reveal` 默认 `opacity: 0`，因此**每一条降级路径都必须把它恢复可见**：
  减少动画偏好（CSS 侧）与无 `IntersectionObserver`（`useReveal` 内）两条都已覆盖。
  新增基于 reveal 的效果时不要漏掉——漏掉的表现是整页空白。
- 主题切换用 View Transition + `clip-path` 圆形扩散（`ThemeToggle.tsx`）；
  过渡期间 `<html>` 挂 `.theme-switching`，使 `::view-transition-*` 覆盖只作用于本次切换，
  不影响 `@view-transition` 的页面导航淡入。不支持该 API 或偏好减少动画时直接切换。

---

## 7. 改动前的自查

- [ ] 新值来自全局 v3.0 §2，没有自创色值/圆角/时长
- [ ] 没有任何 `linear/radial/conic-gradient` 填充
- [ ] 粉色做文字只用了 `--pink-700` 或 `--blue-600`
- [ ] 玻璃只用在浮动层，且带 `@supports` 实色回退
- [ ] 暗色双通道两处都改了
- [ ] 触控目标 ≥44px，`focus-visible` 可见
- [ ] 同屏旗帜条纹没有超过 §3 的配额
- [ ] 状态不靠颜色单独传达（点/图标 + 文字）
- [ ] 文案全部走 `t()`，未新增或改动 i18n 键
