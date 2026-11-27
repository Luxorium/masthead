# Styles and web build files (app.css, favicon, Vite and Svelte config)

This page covers the global stylesheet `web/src/app.css`, the layout grid in `web/src/App.svelte`, the tab icon and the three config files that build the page. The page shell (`web/index.html`) and the entry script (`web/src/main.ts`) are described in [Web front end](Source-Web-Front-End.md#the-page-shell-indexhtml). `main.ts` imports `app.css` and the highlight.js theme `github-dark`. That theme is dark in both schemes because code blocks always sit on a dark background (`--code-bg`, below). This page describes version 0.1.4.

## `web/src/app.css`

`app.css` is loaded once for the whole page. Components add their own scoped `<style>` blocks; this file holds what they share: colour tokens, element resets, buttons, tier badges, status dots and Markdown styles.

### Light and dark

Design tokens are CSS custom properties on `:root`. The light values are the default. A `@media (prefers-color-scheme: dark)` block replaces the colours and the shadow; `--radius` and the three font stacks are the same in both. The page follows the system setting; there is no toggle. `index.html` also sets `<meta name="color-scheme" content="light dark">`, so native controls and scrollbars follow the scheme.

| Token | Light | Dark | Used for (files that read it) |
|---|---|---|---|
| `--bg` | `#f7f8fa` | `#0f1217` | Page background (`body`); text colour on dark buttons and toasts. App, Sidebar, Composer, FolderPicker, PermissionCard, TeamPanel. |
| `--panel` | `#eef0f4` | `#0a0c10` | Side columns, segmented control, Markdown table headers. App, Sidebar. |
| `--raised` | `#ffffff` | `#181c24` | Cards, menus, inputs, `.btn`. Most components. |
| `--border` | `#dfe2e8` | `#232832` | Thin dividers and table cells. Most components. |
| `--border-strong` | `#c5cad3` | `#353c49` | Button and input borders, blockquote bar. Most components. |
| `--text` | `#14171c` | `#e7eaf0` | Body text; background of `.btn.primary` and the toast. Most components. |
| `--muted` | `#5d6470` | `#9aa2b1` | Secondary text, `.muted`, `.btn.ghost`. Most components. |
| `--faint` | `#8b92a0` | `#6a7282` | Least important text; idle and queued dots. Most components. |
| `--accent` | `#3157d5` | `#8ea6ff` | Links, focus outline, running dot, unread count, selection tint. Most components. |
| `--accent-soft` | `#e6ebfb` | `#1a2240` | Banner background. App, PermissionCard. |
| `--ok` | `#1f7a4d` | `#5fc892` | Only `.dot.done` in `app.css`; no component reads it. |
| `--warn` | `#a06a00` | `#e5b454` | `.dot.waiting`. Transcript, TeamPanel. |
| `--bad` | `#c0322b` | `#ff8a80` | Errors, `.btn.danger`, `.dot.failed`. Most components. |
| `--user-bubble` | `#e6e9ef` | `#1d222c` | Background of the person's messages. Transcript. |
| `--code-bg` | `#12151b` | `#07090c` | Code blocks; dark in both schemes. PermissionCard and `.md .code-block`. |
| `--code-text` | `#e3e7ee` | `#e6e9f0` | Text in code blocks and in PermissionCard's command box. |
| `--code-faint` | `#7c8494` | `#808899` | The language label of a code block. |
| `--code-muted` | `#b3bac7` | `#b8bfcc` | The Copy button's text. |
| `--tier-lead` | `#a8720a` | `#e9b949` | Lead tier colour (see below). |
| `--tier-opus` | `#6d4bc4` | `#b39cf5` | Opus tier colour. |
| `--tier-sonnet` | `#2463c9` | `#7fb0ff` | Sonnet tier colour. |
| `--tier-haiku` | `#12806e` | `#5fd0b8` | Haiku tier colour. |
| `--radius` | `8px` | (same) | Card corners. TeamMap, Transcript, TeamPanel. |
| `--shadow` | two soft grey layers at 7% | two black layers at 40% and 35% | Floating things: menus, toast, cards, fixed side columns on narrow screens. |
| `--font` | Inter, then system sans fonts | (same) | Body text (`body`). |
| `--serif` | Source Serif 4, then other serifs | (same) | Headings such as the signed-out title. App, Transcript, Sidebar. |
| `--mono` | `ui-monospace`, then JetBrains Mono and others | (same) | `.mono`, inline code, code labels. PermissionCard, Transcript. |

No font files are bundled, so Inter and Source Serif 4 are used only if installed; otherwise the next font in the list is used.

### Tier colours

The four `--tier-*` tokens are not read directly by components. Instead `.tier-lead`, `.tier-opus`, `.tier-sonnet` and `.tier-haiku` each set one local variable, `--tier`, to the matching colour. Anything inside such an element can then use `var(--tier)`.

- `.tier-badge` is a small pill: text in `--tier`, background `--tier` mixed to 14% with transparent, 11px semibold. TeamPanel and TeamMap render it as `class="tier-badge tier-{tier}"` next to each agent and in the tier settings.
- TeamMap also uses `--tier` for the 3px top border of each agent card and a 55% mix for its hover border.

### Status dots

`.dot` is an 8px circle, `--faint` by default. The modifier is the agent's status (`AgentStatus` in `shared/protocol.ts`), set by TeamPanel and TeamMap as `class="dot {status}"`:

- `.running`: `--accent`, with the `pulse` animation (opacity drops to 0.35 halfway through a 1.4s loop). Turned off under `prefers-reduced-motion: reduce`.
- `.waiting`: `--warn`.
- `.queued`: hollow ring (transparent fill, 2px inset `--faint` shadow).
- `.done`: `--ok`.
- `.failed`: `--bad`.

Sidebar also uses `.dot running` for a busy conversation and `.dot done` / `.dot failed` for the connection state.

### Buttons

- `button` is reset: no border, background or padding, pointer cursor, inherited font and colour. Disabled buttons get a default cursor and 50% opacity.
- `.btn`: inline flex, 6×12px padding, `--border-strong` border, 8px corners, `--raised` background, 13.5px medium text. Hover darkens the border to `--muted`.
- `.btn.primary`: filled with `--text`, text in `--bg` (so dark on light, light on dark); 88% opacity on hover.
- `.btn.danger`: text in `--bad`.
- `.btn.ghost`: no border or fill, `--muted` text; on hover a 7% `--text` tint and full `--text` colour.

### Global resets and helpers

- `* { box-sizing: border-box }`.
- `html`, `body` and `#app` are full height with no margin, so the grid can fill the window.
- `body`: `--bg` background, `--text` colour, 15px font with 1.55 line height, antialiased.
- `input`, `select`, `textarea` and `button` inherit font and colour.
- `.muted` sets `--muted` colour; `.mono` sets `--mono` at 0.9em.

### Focus and selection

- `:focus-visible` draws a 2px `--accent` outline with a 2px offset and 6px rounded corners. It shows on keyboard focus only.
- `::selection` is `--accent` at 30% over transparent.

There are no scrollbar styles; scrollbars follow the browser and the `color-scheme` meta.

### Markdown and code blocks

`.md` wraps HTML made by `web/src/lib/markdown.ts` ([Web front end](Source-Web-Front-End.md)).

- Long words break anywhere. The first and last child lose their outer margin.
- Paragraphs, lists, quotes, tables and code blocks get 0.7em vertical margin. Headings `h1`–`h4` are 1.35, 1.2, 1.06 and 1em, weight 650.
- Links are `--accent`. Inline `code` is `--mono` at 0.88em on an 8% `--text` tint.
- Blockquotes have a 3px `--border-strong` left bar and `--muted` text. Tables scroll sideways when too wide; cells have `--border` lines and headers use `--panel`. `hr` is a 1px `--border` line. Images are capped at full width.

Code blocks come from `markdown.ts` as `div.code-block` holding an optional `span.code-lang`, a `button.code-copy` ("Copy") and `pre > code.hljs`.

- `.code-block`: `--code-bg`, 9px corners, clips its content. `pre` has 14×16px padding and scrolls sideways.
- Code text is `--code-text`, 13px. The code tokens are light on dark in both schemes (since 0.1.4 they are tokens rather than fixed colours); with the dark `--code-bg` and the `github-dark` highlight theme they keep code blocks dark in light mode too (not checked in a browser).
- `.code-lang`: 11px mono label in `--code-faint`, top left. When it is present, `pre` gets 28px top padding so the label does not overlap the code.
- `.code-copy`: top right, `--code-muted` text on 8% white. It is invisible until the block is hovered or the button has keyboard focus.

## Layout regions (`web/src/App.svelte`)

The grid lives in App.svelte's scoped `<style>`, not in `app.css`. The root is `div.shell`:

- `.shell` is a grid with three columns: sidebar `264px`, main `minmax(0, 1fr)`, team panel `316px`, full height.
- App adds `class:no-sidebar` and `class:no-panel` when either side is hidden. `.no-sidebar` gives `1fr 316px`, `.no-panel` gives `264px 1fr`, both give one column.
- `main` is a flex column: a 48px header, then optional banner and breadcrumbs, the transcript, and a `.dock` for the composer whose `.column` is at most 768px wide and centred.
- `.toast` is fixed above the dock, centred, in `--text` with `--bg` text.
- At `max-width: 900px` the grid is always one column. Both `aside` elements (Sidebar and TeamPanel) become `position: fixed` overlays at full height with `--shadow`; the one with class `right` sits on the right edge (not checked in a browser).

## `web/public/favicon.svg`

A 32×32 rounded square (6px corners) in `#14171c`, the light `--text` colour. On it are three horizontal bars in `#f7f8fa` (the light `--bg`), getting shorter (18, 12.5 and 7.5 units) and fainter (full, 82%, 62%), like lines of a headline. Under them is a thin 1-unit line in `#8ea6ff`, the dark `--accent`. Vite copies `public/` into the build unchanged. The icon is the same in both schemes.

## `vite.config.ts`

From the page's side: `root: 'web'` makes `web/index.html` the entry, and `vite build` writes to `dist/web`. The Vite dev server (`npm run dev:web`, which runs `vite`) listens on port 7718 and proxies `/ws` (WebSocket) and `/api` to the Masthead server on `127.0.0.1:7717`, so a page with hot reload talks to a real server. Full detail: [Build configuration](Source-Build-Config.md#viteconfigts).

## `svelte.config.js`

One line: `preprocess: vitePreprocess()`, which lets `<script lang="ts">` in `.svelte` files hold TypeScript. See [Build configuration](Source-Build-Config.md#svelteconfigjs).

## `tsconfig.web.json`

Type-checks only (`noEmit`); Vite builds. ES2022 target, `Bundler` module resolution, DOM libraries, `strict`, and the `svelte` and `vite/client` types. It includes `web/src/**/*.ts`, `web/src/**/*.svelte` and `shared/**/*.ts`. `shared/` is included because the page imports it, for example `web/src/lib/tools.ts` re-exports from `shared/toolline.ts`, and the protocol types come from there too. See [Build configuration](Source-Build-Config.md#tsconfigwebjson).

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web components](Source-Web-Components.md) · [Build configuration](Source-Build-Config.md)
