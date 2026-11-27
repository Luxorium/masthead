# Build configuration

Files: `package.json`, `package-lock.json`, `tsconfig.server.json`, `tsconfig.web.json`, `vite.config.ts`, `svelte.config.js`, `web/vitest.config.ts`, `.gitignore`. How to use them is on [Building, testing and installing](Building-Testing-Installing.md). This page explains what each file says, as read on branch `next` on 2026-11-27 (version 0.1.4, on the way to 0.2.0).

## `package.json`

### Name, publishing and the package

| Field | Value | Why |
|---|---|---|
| `name` | `@luxorium/masthead` | A **placeholder**. The person has not yet decided the name (gate 3 in `docs/plans/0.2.0/PLAN.md`). The `//` note says so. |
| `version` | `0.1.4` | The one version for the package. |
| `private` | `true` | Stays until the name is decided, so nothing can be published by accident. npm refuses to publish a private package. |
| `type` | `module` | Every `.js` file is an ES module (`import`/`export`). |
| `bin` | `masthead` → `dist/server/main.js` | The `masthead` command. `server/main.ts` starts with `#!/usr/bin/env node`, so npm can link it on Linux and macOS and make a `.cmd` shim on Windows. |
| `files` | `dist/` without `dist/server/backends/codex/protocol/` and `dist/server/backends/codex/testing/`, plus `README.md`, `LICENSE`, `CHANGELOG.md` | Only these go into the tarball (npm adds `package.json` itself). The Codex protocol files are imported for their types only (empty at run time) and the Codex fake is for tests only. No sources, tests or plans. |
| `engines` | `node >=22` | Node 22 or newer. |
| `os` | `linux`, `darwin`, `win32` | npm refuses to install on any other system. |
| `publishConfig` | `access: public`, `provenance: true` | A scoped package is private on npm unless `access` is public. Provenance links the package to the CI run that built it. |
| `license`, `homepage`, `repository`, `bugs`, `keywords` | MIT, the GitHub project | Shown on the npm page. |

`npm pack --dry-run` on 2026-11-27, after the clean build and the Codex exclusions, gave `luxorium-masthead-0.1.4.tgz`: 57 files, 289.9 kB packed. Apart from `dist/` it held only `CHANGELOG.md`, `LICENSE`, `README.md` and `package.json`. (The count grows with the code.)

### Optional packages

`package.json` has a `//` field (npm ignores it) with three notes: the name is a placeholder, `private` stays until then, and **users install with `--omit=optional`**.

The reason: `@anthropic-ai/claude-agent-sdk` has one optional dependency per platform, for example `@anthropic-ai/claude-agent-sdk-linux-x64`. Each holds a private Claude Code binary. Masthead never runs it, because it always runs the person's own `claude` (see [Platforms](Platforms.md#finding-claude-code)). `--omit=optional` skips it. `masthead doctor` says when that package is present (`sdkBinaryPackage()` in `server/doctor.ts`).

**A development install must not use `--omit=optional`.** The build tools also use optional packages for their native parts. `package-lock.json` lists, for example, `@esbuild/linux-x64` (esbuild) and `@rolldown/binding-linux-x64-gnu` (rolldown, which Vite 8 uses). Without them `vite build` and `vitest` cannot run. So a checkout uses a plain `npm ci`, and the SDK's binary comes along. It is never run. CI does the same (see [CI](Source-CI.md#why-a-plain-npm-ci)).

The two places that use `--omit=optional` are installs that need no build: the installed copy in `scripts/install.sh` (`npm ci --omit=dev --omit=optional`) and `npm install -g --omit=optional <tarball>`.

### Scripts

| Script | Runs |
|---|---|
| `build` | `build:server`, then `build:web` |
| `build:server` | `tsc -p tsconfig.server.json` |
| `build:web` | `vite build` |
| `dev:web` | `vite` (the page with hot reload) |
| `check` | `tsc -p tsconfig.server.json --noEmit && svelte-check --tsconfig ./tsconfig.web.json` |
| `test` | `node --import tsx --test test/*.test.ts` |
| `test:web` | `vitest run --config web/vitest.config.ts` |
| `test:live` | `node --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED --import tsx test/live.e2e.ts` |
| `start` | `node --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED dist/server/main.js serve` |
| `prepack` | `npm run build` |

`build` starts with `clean` (deletes `dist/` with a one-line Node script, so it works on Windows too): files of moved or deleted sources can no longer linger in `dist/` and ship. `prepack` runs before `npm pack` and `npm publish`, so the tarball always holds a fresh `dist/`. A clean checkout has no `dist/` (it is git-ignored), and without `prepack` the `bin` would point at nothing. What each script is for: [Building, testing and installing](Building-Testing-Installing.md#npm-scripts).

### Dependencies

Runtime:

| Package | Used for |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | Starting and driving Claude Code ([Claude backend](Source-Backend-Claude.md)). |
| `ws` | The WebSocket server ([server/transport/http.ts](Source-Http.md)). |
| `zod` | Input schemas for the team tools ([Core tools](Source-Core-Tools.md)). |
| `marked`, `dompurify`, `highlight.js` | The page only: Markdown, HTML cleaning and code highlighting. Vite bundles them into `dist/web`. |

Development:

| Package | Used for |
|---|---|
| `typescript`, `tsx`, `@types/node`, `@types/ws` | Compiling, and running the `.ts` tests directly. |
| `svelte`, `svelte-check`, `vite`, `@sveltejs/vite-plugin-svelte` | The page: build, dev server, type check. |
| `vitest`, `@testing-library/svelte`, `happy-dom` | The web tests (`npm run test:web`). |
| `jsdom` | A fuller simulated DOM for three web tests (`markdown`, `draft`, `transcript`), chosen per file with `// @vitest-environment jsdom`: DOMPurify does not clean properly under happy-dom. |
| `playwright-core`, `axe-core` | The browser test `test/ui.e2e.mjs`: driving Chromium, and accessibility checks in the page. |

## `package-lock.json`

Generated by npm. It pins exact versions, including the optional platform packages named above. CI keys its npm cache and its Playwright cache on it. `scripts/install.sh` compares it to decide whether to reinstall. Its top `name` and `os` match `package.json`.

## `tsconfig.server.json`

Compiles `server/**/*.ts` and `shared/**/*.ts` to `dist/`, keeping the folder structure (`rootDir: "."`). Target ES2023, Node's module system (`NodeNext`). That is why server imports end in `.js` even though the files are `.ts`. `strict` and `noUncheckedIndexedAccess` are on: indexing an array or map gives a possibly-undefined value, which explains the `!` and `??` in the code. `resolveJsonModule` is on. No declarations, no source maps.

## `tsconfig.web.json`

Type-checks `web/src/**/*.ts`, `web/src/**/*.svelte` and `shared/**/*.ts` for the browser (DOM libraries, `Bundler` module resolution, `verbatimModuleSyntax`, `isolatedModules`). `noEmit`: Vite builds, this file is only for `svelte-check`. It does not include `web/test/`; the web tests are type-checked only as far as Vitest compiles them.

## `vite.config.ts`

- `root: 'web'`: the page's source is in `web/`, with `web/index.html` as the entry.
- The Svelte plugin, pointed at `../svelte.config.js` (relative to `web/`).
- Build output `../dist/web`, emptied on each build, target ES2022.
- Dev server: port `MASTHEAD_DEV_WEB_PORT` (default 7718), `strictPort` (stops instead of picking another port). It forwards `/ws` (as WebSocket) and `/api` to `127.0.0.1:MASTHEAD_PORT` (default 7717).
- `envPort(name, fallback)` reads those two variables. Empty or unset gives the default. Anything but a whole number from 1024 to 65535 throws `Invalid <name>: <value> (use a number from 1024 to 65535).`, so Vite stops at once instead of serving on a wrong port.

## `svelte.config.js`

Uses Vite's preprocessor (`vitePreprocess()`) so `.svelte` files can contain TypeScript. Used by both the build and the web tests.

## `web/vitest.config.ts`

The web tests' set-up:
- The same Svelte plugin and `svelte.config.js`, compiled in dev mode (`compilerOptions: { dev: true }`).
- `root: 'web'`, tests are `web/test/**/*.test.ts`, set-up file `web/test/setup.ts`.
- `environment: 'happy-dom'`: a simulated DOM, no real browser. A test file can choose `jsdom` instead with a `// @vitest-environment jsdom` first line.
- `resolve.conditions: ['browser']`: packages load their browser builds (Svelte otherwise loads its server build under Node).

Its comment says what it covers: pure helpers, the store driven by fake server messages, and components rendered into happy-dom. The real page in a real browser is `test/ui.e2e.mjs`.

## `.gitignore`

Ignores `node_modules/`, `dist/`, `*.log`, `e2e-shots/` (the browser test's screenshots) and `.playwright-browsers/` (the Chromium that CI caches).

## Related pages

[Building, testing and installing](Building-Testing-Installing.md) · [CI](Source-CI.md) · [Platforms](Platforms.md) · [Installing](Source-Install-Scripts.md) · [Tests](Source-Tests.md) · [Web front end](Source-Web-Front-End.md)
