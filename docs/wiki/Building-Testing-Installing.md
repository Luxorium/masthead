# Building, testing and installing

This page explains how Masthead 0.1.1 is built, checked, tested and installed. It draws on `package.json`, the two tsconfig files, `vite.config.ts`, `svelte.config.js`, `test/`, `scripts/` and `AGENTS.md`. Each part has its own detailed page: [Build configuration](Source-Build-Config.md), [Tests](Source-Tests.md), and [Installing](Source-Install-Scripts.md).

## Requirements

- **Linux.**
- **Node.js 22 or newer** (`engines` in `package.json`; `install.sh` checks it).
- **Claude Code**, installed and signed in. Masthead finds it at start-up (see [Configuration and settings](Configuration-and-Settings.md)); it is not an npm dependency.
- For the browser test only: Chromium.

## npm scripts

| Script | Runs | Purpose |
|---|---|---|
| `npm run build` | `build:server`, then `build:web` | Full build into `dist/`. |
| `npm run build:server` | `tsc -p tsconfig.server.json` | Compiles `server/` and `shared/` into `dist/server/` and `dist/shared/`. |
| `npm run build:web` | `vite build` | Bundles the Svelte page from `web/` into `dist/web/`. |
| `npm run dev:web` | `vite` | Development server for the page on port 7718, with hot reload. It forwards `/ws` and `/api` to the Masthead server on 7717. |
| `npm run check` | `tsc … --noEmit` and `svelte-check` | Type-checks the server and the page without writing files. |
| `npm test` | `node --import tsx --test test/*.test.ts` | The unit tests (six files, no Claude Code needed). |
| `npm run test:live` | `node --disable-warning=… --import tsx test/live.e2e.ts` | The live end-to-end run against the real Claude Code (spends usage). |
| `npm start` | `node --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED dist/server/main.js serve` | Runs the built server in the terminal. |

The browser test has no npm script. Run it as `node test/ui.e2e.mjs <url> <screenshot folder>` against a separate test server (see below); it refuses port 7717.

## Output layout

```text
dist/
  server/   compiled server (main.js is the `masthead` command)
  shared/   compiled shared/protocol.js and shared/toolline.js
  web/      built page: index.html, favicon.svg, and hashed files under assets/
```

`dist/` is ignored by git (`.gitignore`). The server looks for the page in `../web` next to `dist/server/`, which is `dist/web`.

## The check before calling a change done

`AGENTS.md` asks for these steps:

1. `npm run check && npm test && npm run build`, always.
2. `npm run test:live` for anything touching agents, messaging, limits or effort. It uses real usage, with Haiku for every tier.
3. `test/ui.e2e.mjs` for page changes, against a test server with its own `XDG_CONFIG_HOME` and `XDG_DATA_HOME`.
4. Update this wiki when behaviour changes.

## Development set-up

```mermaid
flowchart LR
  B["Browser<br/>http://localhost:7718"] --> V["Vite dev server :7718<br/>(npm run dev:web)"]
  V -- "/ws, /api forwarded" --> M["Masthead server :7717<br/>MASTHEAD_DEV=1 npm start"]
```

`README.md` describes this arrangement. `MASTHEAD_DEV=1` makes the server accept the Vite server's Host and Origin; the secret is still required. The server prints the dev page's address with `?key=<secret>`; the page keeps the key in its own storage and sends it when it opens the socket. See [Security model](Security-Model.md).

## Testing without touching real data

Several pieces of the code can be pointed elsewhere for testing:

- `App` accepts `store`, `claude`, `settings` and `settingsFile` options.
- `Store` accepts a root folder.
- `Scheduler` takes its limits as a function.

The unit tests use temp folders and free ports picked by the system. The live test passes its own store and settings file. The browser test runs against a server with separate XDG folders. Details: [Tests](Source-Tests.md).

### A test server with its own folders

```sh
npm run build
export XDG_CONFIG_HOME=$(mktemp -d) XDG_DATA_HOME=$(mktemp -d)
npm start -- --port 7799 &            # its own settings, conversations and secret
node test/ui.e2e.mjs http://127.0.0.1:7799 /tmp/shots   # finds the key in $XDG_DATA_HOME/masthead/secret
node dist/server/main.js stop --port 7799               # same XDG_DATA_HOME, so it has the secret
```

Put cheap models in `$XDG_CONFIG_HOME/masthead/settings.json` first, because the browser test sends real messages. On any port other than the service's (7717), `masthead` and `masthead stop` deal with that copy over HTTP and never touch the systemd unit.

## Installing

`scripts/install.sh [--force]` builds, checks whether agents are working before it restarts anything, installs a staged copy into `~/.local/lib/masthead` by swapping it in, writes the `masthead` command, a systemd user unit and a desktop entry, and restarts the service. `scripts/uninstall.sh` stops any running copy, removes them and keeps the data. Details: [Installing](Source-Install-Scripts.md).

## Related pages

[Build configuration](Source-Build-Config.md) · [Tests](Source-Tests.md) · [Installing](Source-Install-Scripts.md) · [Command-line launcher](Command-Line-Launcher.md) · [Project documents](Project-Documents.md)
