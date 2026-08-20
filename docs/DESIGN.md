# TransCircle Web — Design System

The single source of truth for the visual language and component vocabulary of the
TransCircle web app. Style: **modern minimalist, rounded, cool-toned**. The two brand
colours are drawn from the trans flag and each carries a _semantic role_ rather than
being decoration. Fully themed (light / dark; the `story/` microsite additionally
ships a high-contrast theme).

## 0. Direction (2026-08 redesign)

### Ink carries action; the flag colours stay pastel

The trans flag is a **pastel** flag. `#5BCEFA` and `#F5A9B8` both live at the light end
of the lightness range. An interface accent has to sit on white and carry text and
buttons, so it has to be _dark_ — and darkening the flag's sky blue produces navy, while
darkening its pink produces magenta. Neither is a flag colour any more. Two attempts at
"a blue for this site" both failed for the same reason: what shipped was an arbitrary
blue with no rationale behind it, and an arbitrary hue in an interface reads as _odd_
rather than as branding.

So the roles are split by what each colour can actually do:

| Role        | Token           | Value                            | Notes                                                                                                               |
| ----------- | --------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Action      | `--accent-ink`  | `#1b1e26` light / `#eceef2` dark | Every link, button, focus ring, checked state, active tab. It is not a hue, so it cannot be the _wrong_ hue.        |
| Identity    | `--accent-pink` | `#9e3557` light / `#efa3b7` dark | The avatar chip on `--soft-pink`, and the "this is you" badge — a bounded surface where a pastel reads as a pastel. |
| Information | `--soft-info-*` | blue family                      | Info alerts and the blue status badge only. A soft blue alert is a universal convention, not the theme's colour.    |

Filled buttons are ink on white in light, and near-white on ink in dark. Links are ink
with an underline, which is more accessible than a coloured link anyway — the underline
means colour is never the only signal.

**Pink marks a person through their avatar, never by tinting their name.** Coloured text
in a UI reads as _state_ — a link, an error, a warning — and a person's name has no
state; at the depth the light theme needs for contrast it simply read as red. Names take
`--text-main` and separate from surrounding meta by weight alone.

### Not Material Design 3

The palette was rebuilt once already because it had drifted onto Google's system
language. The tells, and what replaced each:

| Material 3 pattern           | What it looked like here                                                                                    | Now                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Tonal containers             | tags as `--soft-info-bg` fill + same-hue deep text — literally `primary-container` / `on-primary-container` | outlined chips: transparent fill, hairline border, blue text          |
| Fully-round buttons          | `--radius-pill: 999px` on every button and badge                                                            | `6px`, matching the control radius                                    |
| 12 / 16 / 28 radius ramp     | cards at 14px                                                                                               | cards `10px`, controls `6px`                                          |
| Mid-tone high-chroma primary | `#17658f` — hue 201, saturation 72%, lightness 32%, squarely in the range a Material seed generates         | `#1a4e7a` — a printing-ink blue: hue 207.5, deeper and less chromatic |

Material 3 is a language for consumer product UI. This is a story archive; it should
read as something you read, not something you operate. Filled tonal chips and pill
buttons are the two patterns that most strongly say "app", so both are gone.

**Light and dark are the same colour, not two colours.** The accent is hue 207.5 in
light and 205.2 in dark — 2.3° apart, so only lightness flips between themes. Contrast
ratios were tuned to land in the same band on both sides too (blue on a card reads
8.70:1 in light and 9.03:1 in dark), which is what keeps an element's visual weight
constant when a reader switches themes.

### Neutrals

- **Light ground is a white nudged toward the brand** (`#fffcfd`) — not a grey, and
  not a warm cream. Both of those are inherited template defaults.
- **Dark ground is an indigo-based deep ink** (`#0a0c14`) — it reads as _deliberately
  coloured deep_, not as neutral charcoal.
- Ink carries the same indigo undertone (`--text-main: #0d0e14`), so the palette's
  character sits in the type colour rather than in a tinted background.
- **No warm hues anywhere in the neutral ramp.** Amber survives only as a semantic
  warning colour.

### Shape, type, motion

- **Rounded:** cards `--radius-lg: 14px`, controls `--radius-control: 8px`, badges
  `--radius-pill`. Hairline borders plus a single low-spread shadow — never a coloured
  glow, never a multi-layer diffusion.
- **Type:** system stacks only (external fonts are prohibited). Hierarchy comes from a
  wide size ramp — meta `0.8rem` to body `1rem` to list title `1.5rem` to article title
  `--fs-display` — not from decoration.
- **Spacing:** strict 4px scale, `--sp-1` through `--sp-10`.
- **Motion:** quiet. State changes only, 150/200ms, everything guarded by
  `prefers-reduced-motion`. No entrance animations, no scroll-triggered reveals.

### Anti-generic rules (binding — check every change against this list)

1. **No gradients anywhere.** Not on backgrounds, buttons, avatar fallbacks, borders,
   or progress bars. Avatar fallbacks are flat `--soft-pink` + `--accent-pink`.
2. **No `rounded card + 4px coloured left border`** as a default card style — the
   single most template-looking pattern in circulation. Reserve `border-left` for
   genuine semantic emphasis (`Surface` `.accent`). Emphasis is otherwise carried by
   size, weight, and whitespace.
3. **No emoji as decoration or section markers.** Status is a coloured dot plus text,
   which also satisfies "never signal by colour alone".
4. **No inherited default neutrals** — not warm cream (`#f4f1ea` family), not slate
   grey (`#f8fafc` family). See "Neutrals" above.
5. **No hand-drawn SVG people, scenes, or concepts.** Use the existing line-icon set,
   or an honest placeholder.
6. **No coloured glows or multi-layer diffusion shadows.** Light separates with
   hairlines, dark separates with surface lightness steps.
7. **No special or novelty typefaces.** System stack only; hierarchy from scale.

### Two voices, two vocabularies

`src/pages/Story.module.css` (public reading) and `src/pages/Page.module.css` (admin
tooling) are deliberately **separate**. They previously shared one file, which is why a
place for personal stories looked like a ticket queue. Public surfaces are roomier with
larger titles; admin surfaces are denser and more utilitarian.

### Token contract

Token _names_ are frozen (27+ CSS modules reference them); a redesign changes values
and may add tokens, but never removes or repurposes one. The dark theme is declared
twice (`prefers-color-scheme` fallback + `[data-theme='dark']`) — **always edit both
blocks in the same change.**

> If you are about to hardcode a colour, a radius, a shadow, a spacing value, a button,
> an input, a select, a checkbox, a confirm dialog, or a status screen — stop. It
> already exists here. Reach for a token or a primitive instead.

---

## 1. Tokens (`src/styles/index.css`)

All color, elevation, radius, and layout values come from CSS custom properties.
Never hardcode hex/rgba in component CSS — use a token so all three themes stay correct.

### Color (per theme: `:root` light, `[data-theme=dark]`)

- Surfaces: `--bg-color`, `--surface-card`, `--nav-bg`, `--divider-color`, `--overlay-bg`
- Text: `--text-main`, `--text-secondary`, `--text-muted`, `--text-body`
- Brand: `--accent-blue` (**the system speaks** — links, buttons, focus, tags, tabs,
  admin controls), `--accent-pink` (**a person speaks** — author bylines/avatars,
  comment attribution), `--soft-pink` (identity surfaces: avatar backgrounds),
  `--primary-pink` (decorative tint only, never carries text)
- Interaction: `--hover-bg`, `--hover-bg-mix`, `--cta-bg`, `--cta-color`,
  `--cta-hover`, `--cta-hover-mix`
- Status: `--error-color`, `--error-border`, `--success-color`,
  `--soft-success-bg` / `--soft-success-border` / `--soft-success-text`,
  and the matching `--soft-error-*` / `--soft-info-*` / `--soft-amber-*` sets
- Elevation source: `--shadow-color`, `--shadow-color-hover`

### Scales (theme-invariant, `:root`)

- Radius: `--radius-xs: 4px` (inline chips), `--radius-control` / `--radius-sm: 8px`
  (inputs, select, small controls), `--radius-md: 10px` (rows, popovers, alerts),
  `--radius-lg: 14px` (cards), `--radius-pill: 999px` (badges, toggles).
- Spacing: `--sp-1: 4px` through `--sp-10: 64px`, a strict 4px scale. Do not write raw px.
- Borders: `--divider-color` is a hairline for decorative separation only; form-control
  outlines use `--border-strong`, tuned to clear the 3:1 non-text contrast floor
  (WCAG 1.4.11).
- Elevation: `--shadow-card`, `--shadow-card-hover`, `--shadow-pop` (resolved lazily
  against the active theme's `--shadow-color`). **Never** write `rgba(0,0,0,…)` shadows.
- Layout rails (fluid — pages fill the viewport up to these caps):
  `--width-content: 1200px` is the `.mainContent` rail and the only horizontal cap the
  story feed needs — the feed fills it rather than setting a narrower cap of its own.
  `--width-reading: 48rem` (`.pageNarrow` and the article page — a comfortable measure
  for long-form Chinese at roughly 48 characters per line). `--width-form: 26rem`
  (focused auth/status card).
- The feed is **always one entry per row**. A multi-column grid leaves an empty cell
  whenever the item count is not a multiple of the column count, and with a handful of
  stories that reads as a rendering bug rather than a layout.
- A card fills the rail, but the text inside it does not: `.entryTitle` and
  `.entrySummary` are capped at `--width-reading`. A 1100px line of Chinese cannot be
  read — the eye loses the line on the return sweep — and the space this frees on the
  right is where the tags sit, so the row uses its width without stretching prose
  across it.
- `.mainContent`, `Navbar .container` and `LicenseFooter .bar` share one `clamp()`
  padding expression so their left edges line up. Its low end is `0.75rem`: on a phone
  every pixel of horizontal padding is taken out of the text.

---

## 2. Type scale

Sizes come from tokens — never hardcode a `rem` value. The ramp is deliberately wide;
hierarchy is carried by size, not by adding decoration.

| Token           | Value                                  | Role                                |
| --------------- | -------------------------------------- | ----------------------------------- |
| `--fs-micro`    | `0.72rem`                              | tags, timestamps, fine print        |
| `--fs-meta`     | `0.8rem`                               | bylines, meta rows, counts          |
| `--fs-sm`       | `0.875rem`                             | UI controls, admin body             |
| `--fs-body`     | `1rem`                                 | article + comment body              |
| `--fs-subtitle` | `1.125rem`                             | deks, section titles, dialog titles |
| `--fs-title`    | `1.5rem`                               | story titles in the feed            |
| `--fs-display`  | `clamp(1.75rem, 1.3rem + 2vw, 2.5rem)` | article title                       |

Weights: `--fw-body: 400`, `--fw-title: 600`, `--fw-label: 600`, `--fw-display: 700`.
Line height: `--lh-body: 1.85` for running text, `--lh-tight: 1.2` for display.

Use `<PageHeader>` for admin page/section headings. Motion tokens: `--dur-fast: 150ms`
/ `--dur-base: 200ms`, `--ease-standard` / `--ease-emphasized` — reference these
instead of hardcoded `0.15s ease` values.

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
- **ThemeToggle** — two-way light/dark segmented control; `variant='card'|'plain'`.
  (No LanguageToggle: the app ships zh-CN only.)
- **PageHeader** — unified title/description/actions/eyebrow header.
- **CenteredCard** — vertically-centered Card shell (auth/status pages).
- **StatusScreen** — shared loading/success/error/info result screen.

### Date formatting

Use `formatTs(ts, locale?)` / `useFormatTs()` from `@/utils/datetime` (locale-aware via
`Intl.DateTimeFormat`). Never hardcode a locale or render raw UTC ISO strings.

---

## 4. Layout vocabulary — two separate files

**Public reading — `src/pages/Story.module.css`.** The story feed and the article page.
Rounded cards, author avatar + byline in pink, `--fs-title` story titles, tags as soft
blue chips. The article page drops the card shell entirely (an article is the subject of
its page, not one item among many) and sandwiches the author between two hairlines.

**Admin tooling — `src/pages/Page.module.css`.** Denser page-level classes: `.page`,
`.stickyHead`, `.toolbar`, `.list` + `.rowBtn`/`.rowStatic` (+ `.rowMain`/`.rowTitle`/
`.rowMeta`/`.rowRight`), `.contentBlock`, `.detailHead`/`.detailTitle`/`.metaRow`,
`.stack`/`.stackSm`, `.actions`, `.loadMoreWrap`, `.history*`.

**Page landmark rule:** a route component renders a `.page` **`<div>`** (or a
`<CenteredCard>`), **never its own `<main>`** — `RootLayout` (customer) and `AdminShell`
(admin) own the single `<main>`. _Exception:_ the router `errorElement`
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

### Text fields stay native elements, but none of their native _appearance_ does

`<input>` and `<textarea>` are kept as real form elements: Chinese input relies on IME
composition, and only native elements give correct candidate popups, caret placement,
and mobile keyboards. A `contenteditable` replacement would break Chinese entry. What
gets removed is every piece of browser-supplied _chrome_, in `Field.module.css`:

- `appearance: none` (kills iOS rounding / inset shadow and Windows inset borders)
- `:-webkit-autofill` overridden via a 100px inset box-shadow — Chrome's autofill
  paints its own background and ignores `background-color`
- `::-webkit-search-*` decorations removed; the clear button is ours
- `::-webkit-{inner,outer}-spin-button` removed
- `::placeholder` opacity reset (Firefox dims it by default)

Visuals: a filled surface (`--surface-input`) plus a 1px `--border-strong` outline, so
the field is identifiable from its fill rather than needing a heavy border. Focus swaps
the fill to `--surface-card` and adds the blue ring. On coarse pointers the font size
goes to `--fs-body` (16px) — iOS Safari zooms the whole page when focusing anything
smaller.

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
- All user-facing text via `t()`; new keys are added to `zh-CN` only (the web
  frontend ships zh-CN exclusively; contrast is guaranteed by the two light/dark
  token sets, there is no `[data-theme=contrast]` variant).
