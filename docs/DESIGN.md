# TransCircle Web — Design System

The single source of truth for the visual language and component vocabulary of the
TransCircle web app. Both the customer-facing pages and the admin area share this
system so the product feels like one coherent whole. Style: **modern, minimalist,
soft-pink**, accessible, responsive, and fully themed (light / dark / high-contrast).

> If you are about to hardcode a color, a radius, a shadow, a button, an input, a
> select, a checkbox, a confirm dialog, or a status screen — stop. It already exists
> here. Reach for a token or a primitive instead.

---

## 1. Tokens (`src/styles/index.css`)

All color, elevation, radius, and layout values come from CSS custom properties.
Never hardcode hex/rgba in component CSS — use a token so all three themes stay correct.

### Color (per theme: `:root` light, `[data-theme=dark]`, `[data-theme=contrast]`)
- Surfaces: `--bg-color`, `--surface-card`, `--nav-bg`, `--divider-color`, `--overlay-bg`
- Text: `--text-main`, `--text-secondary`, `--text-muted`, `--text-body`
- Brand: `--accent-pink` (primary actions), `--primary-pink` (borders/focus), `--soft-pink`
- Interaction: `--hover-bg`, `--hover-bg-mix`, `--cta-hover`, `--cta-hover-mix`
- Status: `--error-color`, `--error-border`, `--success-color`,
  `--soft-success-bg` / `--soft-success-border` / `--soft-success-text`
- Elevation source: `--shadow-color`, `--shadow-color-hover`

### Scales (theme-invariant, `:root`)
- Radius: `--radius-sm: 10px` (inputs, select, small controls), `--radius-md: 12px`
  (rows, popovers, alerts), `--radius-lg: 14px` (cards), `--radius-pill: 999px`
  (buttons, chips, badges, toggles).
- Elevation: `--shadow-card`, `--shadow-card-hover`, `--shadow-pop` (resolved lazily
  against the active theme's `--shadow-color`). **Never** write `rgba(0,0,0,…)` shadows.
- Layout rails (fluid — pages fill the viewport up to these caps): `--width-content: 1280px`
  (wide browse/list pages — the default `.mainContent` rail), `--width-reading: 60rem`
  (`.pageNarrow` — comfortable measure for long-form reading + single-column forms),
  `--width-form: 26rem` (focused auth/status card). `.mainContent` uses `clamp()` padding so
  spacing scales with screen width instead of fixed breakpoints.

---

## 2. Type scale

Use `<PageHeader>` for page/section headings — do not hardcode heading sizes.
- Page title: `1.6rem / 700`, `letter-spacing: -0.02em` (mobile `1.4rem`).
- Section title: `1.15rem / 700`.
- Body: `0.9rem`; description/meta: `0.85–0.95rem` `--text-muted`; eyebrow/section label:
  `0.68rem` uppercase, `letter-spacing: 0.1em`, `--text-muted`.

---

## 3. Component kit

Import everything from **`@/components/ui`** (it re-exports the admin kit + adds the
shared controls). Admin pages may keep importing from `@/components/admin`.

### Existing primitives (`src/components/admin/*`)
- **AdminButton** (alias `Button`) — variants `primary | secondary | ghost | danger`,
  sizes `sm | md`, `fullWidth`, `loading` (built-in spinner), `iconLeft`. Pill radius.
- **TextField / TextArea / SearchField** — `label`, `hint`, `invalid`; 1.5px border,
  `--radius-sm`, pink focus ring; spreads native props + forwards ref.
- **Card / SectionLabel / Toolbar / DescriptionList / VoteProgress** — surfaces (Card =
  `--radius-lg` + `--shadow-card`).
- **Spinner / Alert (`error|success|info`) / EmptyState** — feedback.
- **StatusBadge** (dot + label, `tone`) / **Pill** — status & lightweight markers.
- **Tabs** — WAI-ARIA tablist (roving tabindex + Arrow/Home/End); pass `panelId` when one
  panel is shared.
- **Modal / ConfirmDialog / ReasonPromptDialog** — portal + focus trap + scroll lock +
  Escape. `ConfirmDialog` replaces `window.confirm`.

### New custom controls (`src/components/ui/*`) — replace browser-native widgets
- **Select** — custom listbox (`combobox` + `listbox` + `aria-activedescendant`,
  keyboard + typeahead). Replaces native `<select>`.
- **Checkbox** — drawn box over a hidden native input (keeps native keyboard).
- **RadioGroup** — labeled radio rows (`radiogroup` + roving tabindex).
- **TagInput** — controlled chip editor (Pill-style chips, accessible remove).
- **LanguageToggle** — segmented zh-CN/zh-TW control (mirrors ThemeToggle); `variant='card'|'plain'`.
- **ThemeToggle** — three-way theme segmented control; `variant='card'|'plain'`.
- **PageHeader** — unified title/description/actions/eyebrow header.
- **CenteredCard** — vertically-centered Card shell (auth/status pages).
- **StatusScreen** — shared loading/success/error/info result screen.

### Date formatting
Use `formatTs(ts, locale?)` / `useFormatTs()` from `@/utils/datetime` (locale-aware via
`Intl.DateTimeFormat`). Never hardcode a locale or render raw UTC ISO strings.

---

## 4. Layout vocabulary (`src/pages/Page.module.css`)

Shared page-level classes for both admin and customer list/detail pages: `.page`,
`.stickyHead`, `.toolbar`, `.list` + `.rowBtn`/`.rowStatic` (+ `.rowMain`/`.rowTitle`/
`.rowMeta`/`.rowRight`), `.contentBlock`, `.detailHead`/`.detailTitle`/`.metaRow`,
`.stack`/`.stackSm`, `.actions`, `.loadMoreWrap`, `.history*`.

**Page landmark rule:** a route component renders a `.page` **`<div>`** (or a
`<CenteredCard>`), **never its own `<main>`** — `RootLayout` (customer) and `AdminShell`
(admin) own the single `<main>`. *Exception:* the router `errorElement`
(`ErrorBoundaryPage`) renders outside RootLayout and supplies its own `<main>`
(via `<CenteredCard as="main">`).

Auth, status, OAuth, and error pages use the **centered-card** treatment
(`<CenteredCard>` / `<StatusScreen>`).

---

## 5. Native-control policy

No browser-native interactive controls in app UI. Replace with the kit:
`<select>` → **Select**; checkbox/radio → **Checkbox** / **RadioGroup**;
`window.confirm`/`alert` → **ConfirmDialog**; native `required` validation bubbles →
`noValidate` on the form + inline field errors / **Alert**; file input → hidden input
behind an **AdminButton**; hand-rolled overlays → **Modal**; hand-rolled toasts → **Alert**.

---

## 6. Responsive & touch

- Breakpoints: ≤1200px (site nav drawer), ≤1024px (admin drawer / tablet),
  ≤768px (mobile compact), ≤640px (small / single-column).
- No horizontal page scroll at any width; controls must wrap, never overlap. Flex rows
  carrying actions use `flex-wrap: wrap` and gaps.
- Touch targets ≥40px, enlarged via `@media (pointer: coarse)`.

---

## 7. Accessibility & theming contract

- Real `:focus-visible` rings (global default in `index.css`; primitives add their own).
- Every animation/transition guarded by `@media (prefers-reduced-motion: reduce)`.
- ARIA comes from the primitives (roles, `aria-*`, live regions). Status is never
  conveyed by color alone (StatusBadge pairs a dot with text).
- Every interactive primitive carries `[data-theme=contrast]` overrides
  (intentional `#000`/`#fff`/`#ffaa00` for guaranteed AAA contrast).
- All user-facing text via `t()`; new keys added to **both** `zh-CN` and `zh-TW`.
