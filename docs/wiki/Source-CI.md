# CI (continuous integration)

Files: `.github/workflows/ci.yml`, `scripts/ci-e2e.mjs`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml` and `config.yml`. This page says what CI runs, on which systems, and what a green run does and does not prove. It was read from the files on branch `next` on 2026-11-27. No CI run was watched for this page. `node scripts/ci-e2e.mjs` was not run either.

## When it runs

`ci.yml` (workflow name `ci`) runs on every push to `main` or `next` and on every pull request.

- `permissions: contents: read`: the jobs can read the code and nothing else.
- `concurrency: ci-<ref>` with `cancel-in-progress`: a new push to the same branch cancels the run still going for it.
- No Claude account, no secrets. Nothing in CI starts Claude Code.

There is no release workflow yet. Publishing is planned in `docs/plans/0.2.0/distribution.md` §4 (`release.yml`).

## Job `test`: check, tests, build and a pack-and-install

Six jobs: a matrix of `ubuntu-latest`, `macos-latest` and `windows-latest`, each with Node 22 and Node 24. `fail-fast: false`, so one failure does not cancel the others. Each job is named `<os> / Node <n>`.

| Step | What it does |
|---|---|
| `actions/checkout@v4` | Gets the code. |
| `actions/setup-node@v4` | Installs Node 22 or 24, with npm's download cache (keyed on `package-lock.json`). |
| `npm ci` | A plain install of everything in the lock file. See below. |
| `npm run check` | Type-checks the server and the page. |
| `npm test` | The unit tests (`test/*.test.ts`). |
| `npm run test:web` | The page's tests in happy-dom and jsdom (Vitest). |
| `npm run build` | Builds `dist/`. |
| Pack and install the package | In bash (Git Bash on Windows): `npm pack --pack-destination "$RUNNER_TEMP"`, then `npm install -g --omit=optional "$RUNNER_TEMP"/*.tgz`, then `masthead --version`. |

### Why a plain `npm ci`

The build tools need their optional platform packages: esbuild and rolldown keep their native parts there (see [Build configuration](Source-Build-Config.md#optional-packages)). `npm ci --omit=optional` would leave them out and the build would fail. The Agent SDK's private Claude Code binary comes along with a plain install. Masthead never runs it.

### The pack-and-install smoke test

This is the user's way of installing, done for real on each system:
- `npm pack` runs `prepack` (a build) and makes the tarball from the `files` list.
- `npm install -g --omit=optional` installs that tarball as a user would, without the SDK's binary.
- `masthead --version` runs the installed command. On Windows that goes through npm's `masthead.cmd` shim.

It proves the tarball is complete enough to start and print its version. It does not start the server.

## Job `browser`: the real page on the fake backend

Three jobs, one per system, Node 24 only, `fail-fast: false`. The job has no `needs:`, so it runs **independently of the `test` jobs**: a unit failure on one system does not hide the browser results on the others.

| Step | What it does |
|---|---|
| checkout, setup-node (24, npm cache) | As above. |
| `npm ci`, `npm run build` | The page and server to test. |
| Cache Playwright's Chromium | `actions/cache@v4` on `.playwright-browsers`, key `playwright-<runner os>-<hash of package-lock.json>`. `PLAYWRIGHT_BROWSERS_PATH` points there for the whole job. A new `playwright-core` version changes the lock file, so it gets a fresh browser. |
| Install Chromium | `npx playwright-core install --with-deps chromium` on Linux (it also installs the system libraries Chromium needs), `npx playwright-core install chromium` elsewhere. When the cache hit, this finds the browser already there. |
| Browser test on the fake backend | `node scripts/ci-e2e.mjs e2e-shots`. |
| Keep the screenshots | `actions/upload-artifact@v4`, `if: always()` (also after a failure), artifact `e2e-shots-<os>`, folder `e2e-shots`. No files is not an error. |

The comment at the top of `ci.yml` still says the browser test "joins once the fake backend exists". The `browser` job below it already runs it, so that comment is out of date.

## `scripts/ci-e2e.mjs` step by step

Plain Node with no shell, so it runs the same on all three systems. It needs a build and Playwright's Chromium. Usage: `node scripts/ci-e2e.mjs [screenshot folder]` (default `<temp>/masthead-e2e-shots`).

1. Makes the screenshot folder, and a fresh temporary folder with `data`, `config` and `work` inside. The test checks the empty first load, so every run starts clean.
2. Writes `config/settings.json`: `permissionMode: "default"` (so the fake's approval request shows a card), `defaultCwd` = the `work` folder, and tier limits Opus 3, Sonnet 2, Haiku 2.
3. Asks the system for a free port on `127.0.0.1` (`listen(0)`). If it ever gets 7717, it asks again: the installed Masthead's port is never used.
4. Builds the environment: the current one plus `MASTHEAD_BACKEND=fake`, `MASTHEAD_ALLOW_FAKE=1`, `MASTHEAD_DATA_DIR` and `MASTHEAD_CONFIG_DIR`. It removes `XDG_DATA_HOME` and `XDG_CONFIG_HOME`, so nothing points back at real folders. The fake backend runs only when both fake variables are set (`server/backends/registry.ts`, [Fake backend](Source-Backend-Fake.md)).
5. Starts `node dist/server/main.js serve --port <port>` with that environment (`windowsHide`, its output shown).
6. Polls `/api/health` every 250 ms until it answers with `name: "masthead"`. It gives up after 30 s, or at once if the server exits.
7. Runs `node test/ui.e2e.mjs <base url> <shots>` with the same environment plus `MASTHEAD_E2E_BACKEND=fake`. That tells the test the server answers scripted phrases, not a model: it builds the team one tool call per message and skips the checks that need a model's own writing. The test finds the key through `MASTHEAD_DATA_DIR/secret`.
8. Whatever happened, stops the server as `masthead stop` does: reads `data/secret` and posts to `/api/shutdown` with the headers `x-masthead: 1` and `x-masthead-key: <secret>`. If the server is still running 3 s later, it kills it.
9. Prints `browser test passed`, or `browser test failed (<code>); screenshots in <folder>`, and exits with the test's code.

The temporary folder is not deleted.

## Issue templates

| File | What it does |
|---|---|
| `bug_report.yml` | "Bug report", label `bug`. Required: what happened and what was expected, the Masthead version (`masthead --version`), the operating system. Optional: steps, Claude Code version (`claude --version`), output or logs. The logs field warns: never paste the `secret` file or a sign-in address. |
| `feature_request.yml` | "Feature request", label `enhancement`. Required: what you are trying to do. Optional: what would help. |
| `config.yml` | Turns off blank issues. Links "Report a security problem" to GitHub's private security advisory form, pointing at `SECURITY.md`. |

## What CI proves and what it cannot

A green run shows, on Linux, macOS and Windows:
- the code type-checks, and the unit tests and web tests pass (Node 22 and 24);
- the build works, the packed tarball installs with `--omit=optional`, and the installed `masthead` command starts;
- the built page works in Chromium against a real server on the fake backend (Node 24), including the accessibility checks in `test/ui.e2e.mjs`.

It cannot show:
- anything with a **real Claude Code**: CI has no account, and the fake backend stands in for it;
- **finding Claude Code** where real installers put it (only the unit tests' fake file systems);
- the **service** starting at login (systemd, launchd, Task Scheduler). Hosted runners have no logged-in desktop, and the unit tests check only the generated files and commands;
- the **browser opening signed in**, the **secret's ACL** on Windows, **keep-awake**, and stopping a real process tree on Windows;
- **remote access** over Tailscale, or a real **usage limit**;
- other browsers than Chromium.

Those are on the release checklist, `docs/plans/0.2.0/release-checklist.md`. Per system: [Platforms](Platforms.md#what-ci-proves-and-what-needs-a-real-machine).

## Related pages

[Building, testing and installing](Building-Testing-Installing.md) · [Platforms](Platforms.md) · [Build configuration](Source-Build-Config.md) · [Tests](Source-Tests.md) · [Fake backend](Source-Backend-Fake.md)
