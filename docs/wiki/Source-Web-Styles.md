# Styles and web build files (app.css, tiers.ts, favicon, Vite and Svelte config)

The page's global styles, tier colours, icon and build files in Masthead 0.2.0. Each component also has its own scoped `<style>`; those are described with the component where they matter. Nothing on this page was checked in a browser; it is read from the code.

## `web/src/app.css`

Imported once by `main.ts`. It holds the colour tokens, the tier palette, a few shared classes, accessibility rules and the Markdown styles. The look is ink and paper: near-black text on a pale background, a serif for a few headings (`--serif`), and one cobalt accent.

### Light and dark

Tokens on `:root` (light): `--bg`, `--panel`, `--raised`, `--border`, `--border-strong`, `--text`, `--muted`, `--faint`, `--accent` (`#3157d5`), `--accent-soft`, `--ok`, `--warn`, `--bad`, `--user-bubble`, the code-block colours `--code-bg`, `--code-text`, `--code-faint`, `--code-muted`, plus `--radius`, `--shadow`, and the fonts `--font` (Inter, then system fonts), `--serif` (Source Serif 4, then others) and `--mono`. No font files are bundled; the names are used if installed.

Dark colours apply in two cases:

- `:root[data-theme='dark']`: the person chose Dark in Settings > Appearance (`ui.setTheme`).
- `@media (prefers-color-scheme: dark)` on `:root:not([data-theme='light'])`: the system is dark and the person did not choose Light.

The same dark values are written out in both blocks. `data-theme` also sets `color-scheme`, so form controls and scroll bars follow.

Code blocks stay dark in both schemes, to suit highlight.js's `github-dark` theme that `main.ts` imports.

`--faint` (`#697080`) is, per its comment, the lightest grey that passes WCAG AA for small text on `--bg` (4.6:1).

### Tier colours

Tier colours are data in 0.2.0: a team profile gives each level a colour **slot** from the shared `PALETTE` (`amber`, `violet`, `blue`, `teal`, `rose`, `green`, `slate`, `orange`), and the page owns what each slot looks like. `app.css` defines `--pal-<slot>` in light and dark, each, per its comment, at least 4.5:1 on the page background so names stay readable. The class `pal-<slot>` sets `--tier` for everything inside it; `.tier-badge` (a small pill with the model name) and the level boxes use `--tier`.

The older `--tier-lead`, `--tier-opus`, `--tier-sonnet`, `--tier-haiku` variables and `.tier-*` classes stay for 0.1.x agents whose tier ids are the Claude names.

### Tier colours (`tiers.ts`)

`web/src/lib/tiers.ts` maps an agent's tier to its look. An agent's `tier` is a tier id; its label, model and colour come from the profile in the settings. Nothing here knows Claude's model names.

- `tierSpec(settings, tier)`: the `TierSpec` for a tier id (`findTier` from `shared/protocol.ts`), or undefined.
- `tierClass(settings, tier)`: `pal-<colour>` from the profile. If the profile is gone, 0.1.x ids fall back to fixed colours (lead amber, opus violet, sonnet blue, haiku teal); anything else, or a colour not in `PALETTE`, is `pal-slate`.
- `profileById(settings, id)`: that profile, else the built-in Claude profile, else the first.

Used by `TeamPanel`, `TeamMap`, `TierControls` and `Composer`. Tested in `web/test/tiers.test.ts`.

### Status dots

`.dot` is an 8 px circle in `--faint`. `.running` is the accent and pulses (1.4 s); `.waiting` is `--warn`; `.queued` is an empty ring; `.done` is `--ok`; `.failed` is `--bad`. With reduced motion the pulse is off.

### Buttons

`.btn` is the shared button: inline-flex, 6×12 px padding, `--border-strong` border, 8 px radius, `--raised` background, 13.5 px medium text. `.primary` is ink on paper (`--text` background); `.danger` has `--bad` text; `.ghost` has no border or background until hovered. Disabled buttons are at half opacity.

### Global resets and helpers

`box-sizing: border-box` everywhere; `html`, `body` and `#app` fill the height, and `#app` uses `100dvh` so a phone's on-screen keyboard does not cover the message box. Body text is 15 px / 1.55. Form controls inherit the font and colour; buttons have no border or background by default. Helpers: `.muted`, `.mono`, `.sr-only` (text for screen readers only), `.skip` (the skip link, off screen until focused).

### Focus and selection

`:focus-visible` draws a 2 px accent outline 2 px outside, with a 6 px radius. Selected text uses the accent at 30%.

### Touch and motion

- `@media (pointer: coarse)`: `.btn` is at least 44 px high, and inputs, selects and textareas use 16 px text so iOS does not zoom (the selectors start with `:root` to win over the `font: inherit` rule). Most components add their own 44 px rules.
- `@media (prefers-reduced-motion: reduce)`: animations and transitions take 0.01 ms and run once, and smooth scrolling is off.

### Markdown and code blocks

Rules under `.md` style rendered Markdown ([Rendering Markdown safely](Source-Web-Front-End.md#rendering-markdown-safely-markdownts)):

- Paragraphs, lists, quotes, tables and code blocks have 0.7 em margins; the first and last child have none. Headings are 650 weight, 1.35 em down to 1 em.
- Inline `code` is mono on a faint tint. Links use the accent.
- `.code-block`: `--code-bg`, 9 px radius; `pre` scrolls sideways.
- `.code-lang`: an 11 px mono label at top left; when present, `pre` gets 28 px top padding.
- `.code-copy`: top right, hidden until the block is hovered or the button has keyboard focus. On touch screens it is always shown and 32 px high.
- Tables are `display: block` and scroll sideways on narrow screens instead of squeezing words.
- Quotes have a left rule; `img` is at most the column's width; `.md` breaks long words anywhere.

## Layout regions (`web/src/App.svelte`)

The grid lives in App.svelte's scoped `<style>` and script, not in `app.css`. `div.shell` is a grid whose `grid-template-columns` the script sets: `264px` for the chat list when open and not narrow, `minmax(0, 1fr)` for `main`, and `340px` for the team panel when open on a wide screen. `main` is a flex column: a 48 px header (56 px on a phone), banners, breadcrumbs, the transcript, and the `.dock` whose `.column` is at most 768 px wide and centred. The dock pads itself with `env(safe-area-inset-bottom)`. The toast is fixed above the dock.

Drawers: on narrow screens `aside.left`, and below 1280 px `aside.right`, become `position: fixed` at full height, at most 88vw, with `--shadow`, over a 35% black backdrop. Details per width are on [Layout per width](Source-Web-Front-End.md#layout-per-width).

## `web/public/favicon.svg`

A 32×32 rounded square (6 px corners) in `#14171c`, the light `--text` colour. On it are three bars in `#f7f8fa` (the light `--bg`), getting shorter and fainter, like lines of a headline, and a thin line under them in `#8ea6ff`, the dark `--accent`. Vite copies `public/` into the build unchanged. The icon is the same in both schemes.

## `vite.config.ts`

From the page's side: `root: 'web'` makes `web/index.html` the entry, and `vite build` writes to `dist/web` (target ES2022). The dev server (`npm run dev:web`) listens on `MASTHEAD_DEV_WEB_PORT` (default 7718, `strictPort`) and proxies `/ws` and `/api` to the Masthead server on `127.0.0.1:MASTHEAD_PORT` (default 7717). Set both to run beside an installed Masthead. A port outside 1024–65535 stops with a clear error. `/blob` is not proxied, so pictures do not work in the dev server. Full detail: [Build configuration](Source-Build-Config.md#viteconfigts).

## `svelte.config.js`

One line: `preprocess: vitePreprocess()`, which lets `<script lang="ts">` hold TypeScript. The page tests load the same file ([Page tests](Source-Web-Tests.md#vitestconfigts-and-setupts)). See [Build configuration](Source-Build-Config.md#svelteconfigjs).

## `tsconfig.web.json`

Type-checks only (`noEmit`); Vite builds. ES2022 target, `Bundler` resolution, DOM libraries, `strict`, and the `svelte` and `vite/client` types. It includes `web/src/**/*.ts`, `web/src/**/*.svelte` and `shared/**/*.ts`, because the page imports the shared protocol and tool-line code. `npm run check` runs `svelte-check` with it. See [Build configuration](Source-Build-Config.md#tsconfigwebjson).

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web components](Source-Web-Components.md) · [Build configuration](Source-Build-Config.md) · [Team profiles and settings](Team-Profiles-and-Settings.md)
