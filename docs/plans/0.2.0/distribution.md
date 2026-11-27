# 0.2.0: distribution: prepackaged, on Linux, macOS and Windows

Written 2026-11-27 by delta (Opus), from the `next` branch at 0.1.4 (`478601f`). This is a research and design note: nothing was changed in the code, nothing was published or registered, and no install script was run.

How it was done:
- A read-only audit of every tracked source file for Linux and POSIX assumptions (61 findings). The table is Appendix A.
- Web research with page fetches (quotes and URLs in section 7 and Appendix B).
- Read-only lookups (`npm view`, `npm pack --dry-run`).
- A question to echo about the fake backend planned in `backends.md` §8.

Where something was inferred and not fetched or run, the text says so.

The person set two requirements for 0.2.0, and they come first:
1. **Prepackaged.** No clone, no build.
2. **Windows and macOS supported natively** wherever the backend CLIs allow it.

---

## 0. The answer in brief

- **Platforms for 0.2.0:**
  - Linux: x64 and arm64.
  - macOS 13+: Apple Silicon and Intel.
  - Windows 10 1809+ and 11: x64 natively, not WSL. Windows arm64 is best-effort.
  - WSL keeps working as Linux.
  - Both backend CLIs run natively on all three (section 1.1). Nothing forces "WSL only".
- **Packages for 0.2.0:**
  - An **npm package with a prebuilt `dist/`**, which is the one artefact everything else builds on.
  - Thin wrappers around it: a **Homebrew tap formula**, an **AUR package** and a **Scoop manifest**.
  - A `masthead service install` command that sets up auto-start per platform: systemd user unit, launchd LaunchAgent, or a Windows Task Scheduler logon task.
  - These all need Node 22+, which Homebrew, Scoop and AUR install for the person.
- **Not in 0.2.0:**
  - A **download-and-run installer with Node inside** (Node SEA or a bundled runtime) waits for 0.3.0. It needs signing on macOS ($99 a year plus notarisation) and on Windows (about $120 a year with Azure Artifact Signing if eligible, else an OV certificate).
  - It also raises an **open legal question**: it would redistribute Anthropic's proprietary Agent SDK. The SDK's licence file says "© Anthropic PBC. All rights reserved."
- **The name:** `masthead` on npm is taken. Publish as **`@luxorium/masthead`** (currently free) and keep the command name `masthead`.
- **The blocker to raise first is the terms:**
  - Anthropic's Agent SDK page says third-party developers may not "offer claude.ai login … for their products, including agents built on the Claude Agent SDK" without approval.
  - Its legal page allows "an end user signing in to the unmodified Claude Code binary with their own Claude subscription".
  - Masthead sits between the two. **Ask Anthropic before a wide launch** (section 7).

---

## 1. Platform support

### 1.1 Facts that decide it

| Fact | Source |
|---|---|
| Claude Code runs natively on "macOS 13.0+, Windows 10 1809+ or Windows Server 2019+"; "You can run Claude Code natively on Windows or inside WSL." Git for Windows is "optional"; without it Claude Code "runs shell commands via the PowerShell tool". | https://code.claude.com/docs/en/setup (fetched 2026-11-27) |
| The native Windows binary is `%USERPROFILE%\.local\bin\claude.exe`, signed by "Anthropic, PBC". The macOS and Linux launcher is `~/.local/bin/claude`. Installs: `install.ps1`, `install.cmd`, `winget install Anthropic.ClaudeCode`, `brew install --cask claude-code`, and npm (`@anthropic-ai/claude-code`, which "installs the same native binary"). | same page |
| Codex CLI: native Windows with a Windows sandbox, "instead of requiring WSL or a virtual machine"; not labelled experimental. Installers for all three OSes; `@openai/codex` on npm; `@openai/codex-sdk`; `codex exec --json`. | https://learn.chatgpt.com/docs/windows/windows-sandbox, https://github.com/openai/codex (fetched) |
| The Agent SDK never searches PATH. Without `pathToClaudeCodeExecutable` it loads its own optional package `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, which holds a private `claude` binary (384 MB on linux-x64 here). With a path, it runs `.js/.mjs/.ts` through node and anything else with `child_process.spawn` **without a shell**, so a Windows `.cmd` shim cannot be used. | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` and `package.json` 0.3.332 (Appendix A §I) |

Conclusion: native Windows and macOS are possible for the Claude backend today. For Codex they are possible once `backends.md` lands.

### 1.2 What must change, by platform

Appendix A lists all 61 places with file and line. The ones that block each platform:

**Both macOS and Windows:**
- **No browser opens.** `server/cli.ts:155` only knows `xdg-open` and `gio`. Use `open <file>` on macOS and `explorer.exe <file>` on Windows (A14).
- **No auto-start.** Only systemd exists (`server/main.ts:52-55,129,185`, `scripts/install.sh`). Add launchd and Task Scheduler backends behind one `ServiceManager` interface (A16, A36, A43).
- **Data folders.** `server/config.ts:19-20` uses XDG paths everywhere. Add `appDirs(platform, env)`:
  - macOS: `~/Library/Application Support/Masthead`.
  - Windows: `%APPDATA%\Masthead` for config and `%LOCALAPPDATA%\Masthead` for data.
  - Linux: XDG, as today.
  - An explicit `XDG_*`, `MASTHEAD_CONFIG_DIR` or `MASTHEAD_DATA_DIR` still wins on every platform (A1).
  - Decision D5: macOS could keep XDG instead, which is what many CLI tools do.
- **Claude Code discovery.** `server/config.ts:187-188` needs per-platform candidates:
  - macOS: `/opt/homebrew/bin` and `~/.npm-global/bin`, because a launchd job's PATH is only `/usr/bin:/bin:/usr/sbin:/sbin`.
  - Windows: `%USERPROFILE%\.local\bin\claude.exe` and `%APPDATA%\npm`.
  - Keep one list shared by `doctor` and the service installer (A9, A38).

**Windows only (code bugs today):**
- **Claude Code reported missing.** `server/config.ts:187` finds npm's extension-less `sh` shim named `claude`. Try PATHEXT and prefer `.exe`. Resolve a `.cmd` shim to its package's JS entry, because the SDK spawns without a shell (A8, A10, A31).
- **The default folder never saves.** `server/config.ts:74` tests `defaultCwd.startsWith('/')`, which rejects every `C:\…`. Use `path.isAbsolute` (A2).
- **The launcher crashes.** `server/cli.ts:171` and `server/main.ts:68` delete the sign-in file with `sh -c 'sleep 60; rm …'`, and `detach` has no `'error'` handler, so the launcher crashes as soon as an opener exists. Use a detached `process.execPath -e "setTimeout(()=>fs.rmSync(…),60000)"` with `windowsHide` (A15, A18).
- **Opener lookup always fails.** `server/main.ts:59` uses `sh -c 'command -v'`. Search PATH and PATHEXT in JavaScript (A17).
- **No clean shutdown.** `server/main.ts:108`: SIGTERM never arrives on Windows, and closing the console sends SIGHUP, which is not handled. Handle `SIGHUP` and `SIGBREAK`. Stop through `/api/shutdown`, which already exists (A20). Child `claude.exe` processes are not in a job object and can outlive the server (A32; consider `taskkill /T` after `close()`).
- **Saves and deletes fail when files are held.** `server/config.ts:87-92` and `server/store.ts:101`: renaming over a file, or removing one, fails with EPERM or EBUSY while antivirus or the indexer holds it. Add retries with backoff (`rmSync`'s `maxRetries`, a small wrapper for rename) (A3, A29).
- **The secret file:**
  - `server/config.ts:137,142,145`: modes mean nothing on NTFS, so the `& 0o077` check is always true and `chmod` does nothing. Privacy then rests on the ACL of `%LOCALAPPDATA%`, which is per-user by default.
  - Recommendation: on Windows, skip the mode check; once, at directory creation, run `icacls <dir> /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`; `doctor` reports the ACL.
  - `linkSync` fails on FAT, exFAT and some SMB or OneDrive folders. Fall back to `openSync(file, 'wx')` (A4–A7).
- **Folder picker.** `server/app.ts:378,391`: `~\` is not expanded, and other drives cannot be reached. Show a list of drive letters above `X:\`. Also `web/src/lib/FolderPicker.svelte:40,46` and `store.svelte.ts:550` (A24, A25, A33–A35).
- **Asset caching.** `server/http.ts:213`: `normalize` turns `/assets/` into `\assets\`, so hashed assets are served `no-cache`. That affects speed only. Decide from the URL path with `path.posix` (A27).
- **Console windows** flash for the detached server and the openers. Add `windowsHide: true` (A19).
- **Scripts.** `scripts/*.sh` cannot run. They are replaced by the Node commands in section 3.

**macOS only:** the opener, launchd and discovery (above). Also `$TMPDIR`, which is per-user and 0700, is a better place for the sign-in file than the data folder (A12).

### 1.3 What cannot be tested from this Linux machine

- **Can run here:**
  - Pure functions given an injected `platform`, `env` or `exists`, using `path.win32` and `path.posix`: `appDirs`, the candidate lists, PATHEXT lookup, `isAbsolute`, `~` expansion, PATH cleaning.
  - The shape of the service files: the plist and Task Scheduler XML can be generated and checked against fixtures.
- **Needs a macOS runner:**
  - `launchctl bootstrap`/`bootout`/`print` (does it actually start at login?);
  - `open` with a file URL;
  - discovery of Claude Code installed by Homebrew;
  - Gatekeeper behaviour for anything downloaded.
- **Needs a Windows runner:**
  - the PATHEXT and `.exe`/`.cmd` resolution against real npm and native installs;
  - `explorer.exe` opening;
  - Task Scheduler create, run and delete;
  - SIGHUP/SIGBREAK shutdown;
  - EBUSY retries;
  - `icacls`;
  - `linkSync` fallback;
  - drive listing;
  - npm's `.cmd` shim for `masthead` itself.
  - Tests that assume POSIX need `skip` or per-platform expectations: `test/app.test.ts:300-311`, `test/launcher.test.ts:63-95,121-141,227-229`, `test/ui.e2e.mjs:20-22,43` (A51–A61).
- **Needs a real account on each OS (not CI):** a live run against signed-in Claude Code. CI has no account. Section 4 uses echo's fake backend.

---

## 2. Packaging: prepackaged, so no clone and no build

### 2.1 npm package (the base for everything)

`npm pack --dry-run --json` today gives 118 files, 494 KB packed. That includes `docs/plans`, tests, `AGENTS.md` and `CLAUDE.md`, plus whatever `dist/` was last built locally (`dist/` is git-ignored, so a clean checkout has none and `bin` would point at nothing). `"private": true` blocks publishing.

`package.json` changes:
```jsonc
{
  "name": "@luxorium/masthead",          // decision D1
  // "private": true removed
  "bin": { "masthead": "dist/server/main.js" },
  "files": ["dist/", "README.md", "LICENSE", "CHANGELOG.md"],
  "engines": { "node": ">=22" },
  "os": ["linux", "darwin", "win32"],
  "scripts": { "prepack": "npm run build", ... },
  "repository": "github:Luxorium/masthead", "homepage": "...", "bugs": "...", "keywords": [...]
}
```
`publishConfig.access: "public"` is needed for a scoped package.

**The private Claude Code binary.** `@anthropic-ai/claude-agent-sdk` has optional dependencies, one per platform, each holding a private native Claude Code binary (384 MB on linux-x64 here). `install.sh` passes `--omit=optional` for exactly this reason (`scripts/install.sh:85`, comment line 84). A plain `npm i -g @luxorium/masthead` would download it. Masthead never uses it, because it always passes `pathToClaudeCodeExecutable`. But it contradicts the spirit of the `AGENTS.md` rule ("Do not … bundle a private copy of Claude Code") and costs users hundreds of MB. Options:

| Option | Effect | Verdict |
|---|---|---|
| A. Depend on the SDK as now; the README says `npm i -g --omit=optional @luxorium/masthead`; `doctor` warns if the platform package is present and says how to remove it | Works everywhere, no legal question; users who skip the flag get the download | **Recommended for 0.2.0** |
| B. Bundle the SDK's JavaScript into `dist/` with esbuild and drop the dependency | No binary is ever pulled, but it redistributes Anthropic's proprietary code (`LICENSE.md`: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements") | Only with Anthropic's written permission (decision D3) |
| C. `overrides` or `.npmrc` | Not honoured for a dependency of a globally installed package (npm applies overrides only at the root project) | Does not work |

Homebrew, AUR and Scoop control the install command, so they always pass `--omit=optional`.

**`npx @luxorium/masthead`** works for a try-out. It downloads into the npx cache and asks "Ok to proceed?". A service must not point into the npx cache, so `service install` refuses to run from an npx path and says to `npm i -g` first. npx behaviour was inferred, not tested.

### 2.2 `masthead` commands that replace `install.sh`

`install.sh` does five jobs: build, copy, write a wrapper, write a systemd unit, write a desktop entry. With a package the first three disappear. The rest become subcommands that work the same from any install (npm, Homebrew, AUR, Scoop):

| Command | Linux | macOS | Windows |
|---|---|---|---|
| `masthead service install [--port N] [--force]` | `~/.config/systemd/user/masthead.service` (today's template, `ExecStart=<process.execPath> <main.js> serve`, PATH from the current shell cleaned as `scripts/path.sh` does), then `systemctl --user enable --now` | `~/Library/LaunchAgents/io.github.luxorium.masthead.plist` (`RunAtLoad`, `KeepAlive.SuccessfulExit=false`, `EnvironmentVariables.PATH` including `/opt/homebrew/bin`, logs to `~/Library/Logs/Masthead/`), then `launchctl bootstrap gui/$UID` | A per-user Task Scheduler task `Masthead` with a logon trigger, limited rights and no admin (`schtasks /Create /SC ONLOGON /RL LIMITED /TN Masthead /TR …`, or XML via `/XML` for "restart on failure"), running `node.exe main.js serve` hidden. Fallback: a shortcut in the Startup folder |
| `masthead service uninstall` | `disable --now`, remove the unit | `launchctl bootout`, remove the plist | `schtasks /Delete /TN Masthead /F` |
| `masthead service status` | `systemctl --user show` (already parsed by `unitPortFrom`) | `launchctl print gui/$UID/<label>` | `schtasks /Query /TN Masthead /FO LIST /V` |
| Launcher entry | `~/.local/share/applications/masthead.desktop` with an absolute `Exec` (today's quoting) | Optional, later: a tiny `.app` that runs `masthead` (needs signing, so later) | A Start-menu `.lnk`, created through PowerShell `WScript.Shell` |

- **Busy check:** `service install` and `update` first ask `/api/health` for `busy`, as `install.sh:48-68` does now, and refuse to restart while agents work unless `--force`.
- **Hidden window (Windows):** the window must not flash. Run through `conhost.exe --headless node.exe …` (Windows 11) or a one-line `.vbs`/PowerShell `-WindowStyle Hidden` launcher. Unverified: needs a Windows runner.
- **`unitServes(p)` becomes `service.serves(p)`**, so `open` and `stop` stay port-correct on every platform.
- **`scripts/install.sh` stays** as a developer path ("install from a checkout"). It then just runs `npm pack` and `npm i -g --omit=optional <tgz>` followed by `masthead service install`.

**`masthead doctor`** prints one line per check, with the fix:
- Node version;
- each backend: found where, version, signed in (through the SDK's `accountInfo()` as in `backends.md` §7, never reading token files);
- the data and config folders and their modes or ACL;
- the secret present and private;
- the port free, or served by our proven instance (the 0.1.4 `/api/proof`);
- the service installed, running and on which port;
- whether the private SDK binary package is present (option A);
- whether PATH as the service sees it contains the backend.

Exit code 0 means all good, 1 means problems. `doctor --json` gives the same for bug reports.

**Update:** `masthead update` is not needed. Updating is `npm i -g @luxorium/masthead` (or `brew upgrade`, `pacman`, `scoop update`) followed by `masthead service restart`, which does the busy check. `doctor` and the page show "version X available" only if the person turns on an update check. That would be the only network call Masthead makes besides the backends; default off (section 6).

### 2.3 Package managers (wrappers around the npm tarball)

- **Homebrew tap** `Luxorium/homebrew-tap`, formula `masthead.rb`:
  ```ruby
  class Masthead < Formula
    desc "Local web app that runs a tiered team of AI agents through your own CLI"
    homepage "https://github.com/Luxorium/masthead"
    url "https://registry.npmjs.org/@luxorium/masthead/-/masthead-0.2.0.tgz"
    sha256 "…"
    license "MIT"
    depends_on "node"
    def install
      system "npm", "install", *std_npm_args, "--omit=optional"
      bin.install_symlink libexec.glob("bin/*")
    end
    service do
      run [opt_bin/"masthead", "serve"]
      keep_alive successful_exit: false
    end
    test { assert_match version.to_s, shell_output("#{bin}/masthead --version") }
  end
  ```
  `brew services start masthead` then replaces `service install` on macOS for brew users. The `std_npm_args` convention was not re-verified in this research. homebrew-core comes later: it wants notability, and the docs say self-submitted, little-known projects are rejected (https://docs.brew.sh/Acceptable-Formulae).
- **AUR** `masthead` (`arch=any`, `depends=(nodejs)`, `makedepends=(npm)`):
  ```bash
  pkgname=masthead; pkgver=0.2.0; pkgrel=1; arch=(any); license=(MIT)
  depends=(nodejs); makedepends=(npm)
  source=("https://registry.npmjs.org/@luxorium/masthead/-/masthead-$pkgver.tgz")
  noextract=("masthead-$pkgver.tgz")
  package() {
    npm install -g --omit=optional --prefix "$pkgdir/usr" "$srcdir/masthead-$pkgver.tgz"
    install -Dm644 "$pkgdir/usr/lib/node_modules/@luxorium/masthead/LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
  }
  ```
  The Arch Node.js packaging guidelines could not be fetched (bot protection), so this follows the commonly used pattern and must be checked against the wiki before submitting.
- **Scoop** (Windows, no admin): a manifest in our own bucket with `depends: nodejs-lts`, `url` pointing at the npm tarball, and an `installer.script` that runs `npm install --omit=optional` into the app folder plus a `bin` shim. **winget** wants an installer (MSI, MSIX, zip or portable exe). It fits the 0.3.0 self-contained build better than an npm wrapper.
- **Container image: not offered.** Masthead's job is to run the person's own signed-in CLI on the person's own folders. A container would have to mount the home folder, the CLI's credential store and every working folder, and would run the agents' commands inside the image instead of on the person's machine. That is a poor fit, and it is easy to get wrong in a way that exposes credentials. If people ask, document a Dockerfile as an example only.

### 2.4 Download-and-run installer (designed for 0.3.0, not 0.2.0)

What it would take for someone with no Node:

| Approach | Notes |
|---|---|
| **Node SEA** (single executable) | "Stability 1.1 Active development"; `--build-sea` only since Node 25.5.0; the VFS for assets only since v26.9.0 ("Early development"); `.node` addons cannot load from the VFS; one entry script, so the server must be bundled with esbuild, **including the proprietary SDK** (redistribution, D3). The page's assets go through `sea.getAsset`. https://nodejs.org/api/single-executable-applications.html (fetched) |
| **Bundled runtime** (official Node binary plus `dist/` plus production `node_modules` in a folder, packaged as `.pkg`/`.dmg`, MSI or MSIX, and AppImage or `.tar.zst`) | Simpler and robust; Node is MIT; the same SDK redistribution question unless the installer fetches the SDK from npm on first run, which needs network at install and an npm client inside |
| bun `--compile`, deno compile, yao-pkg | Not evaluated in depth; same redistribution question; adds a second runtime to support |

Signing, which is unavoidable for downloads:
- **macOS:** a Developer ID certificate plus notarisation (Apple Developer Program, "$99 annual membership", https://developer.apple.com/programs/). Since macOS 15, an un-notarised download needs System Settings → Privacy & Security → "Open Anyway"; Control-click no longer bypasses it (secondary source).
- **Windows:**
  - Without Authenticode, SmartScreen shows "Windows protected your PC".
  - Since 2024, an EV certificate no longer gives instant reputation, so OV and EV build reputation the same way over downloads (search results, Microsoft Q&A; not fetched).
  - Azure Artifact Signing costs "$9.99/month" (Basic). Eligibility is limited: organisations in the US, Canada, EU or UK; individuals only in the US or Canada (search results; to be checked).
  - An OV certificate from a CA was not priced here (commonly a few hundred USD a year).
- **Packages installed through npm, Homebrew, Scoop or AUR are not quarantined**, so they need none of this. That is the main reason they come first.

Auto-start for the self-contained build uses the same `service install` code, run by the installer's post-install step.

---

## 3. Configuration for many users

**Today:** `settings.json` (written by the page), environment variables (`MASTHEAD_PORT`, `MASTHEAD_CLAUDE`, `MASTHEAD_DEV`, `MASTHEAD_DEV_WEB_PORT`, `XDG_*`), and `--port`/`--no-browser`. `core.md` §5 already designs `SettingsV2` (versioned, with `backends.<id>.path`). Do not add a second settings file.

**Precedence, highest first.** One function, `serverOptions(argv, env, settings)`, used by `main.ts` and `doctor`:
1. CLI flag (`--port`, `--data-dir`, `--config-dir`, `--no-browser`, `--claude <path>`).
2. Environment variable (`MASTHEAD_PORT`, `MASTHEAD_DATA_DIR`, `MASTHEAD_CONFIG_DIR`, `MASTHEAD_CLAUDE`, `MASTHEAD_CODEX`, `XDG_*`).
3. `settings.json` (`backends.<id>.path`; port is not stored there, because the service must know it before the server reads settings).
4. Platform default (`appDirs`, 7717).

**Format:** JSON, as now, kept by the page. Editing by hand is allowed; invalid fields fall back per field, as `sanitizeSettings` does. Document every key on one wiki page (Configuration-and-Settings already exists).

**First run:**
- `masthead` with no backend found or not signed in prints the `doctor` lines for that backend and the install command for this OS:
  - `irm https://claude.ai/install.ps1 | iex` / `winget install Anthropic.ClaudeCode`;
  - `brew install --cask claude-code`;
  - `curl -fsSL https://claude.ai/install.sh | bash`;
  - then `claude` to sign in.
- The page already greys out an unavailable backend (`backends.md` §7). Add a "Check again" button and a short, non-technical "Getting started" panel that says the same.

**Ports and several instances:**
- Default 7717. A second instance needs its own data folder and port: `masthead --data-dir D --port 7720`.
- The service manages one instance (the default). `service install --port N` changes the service's port, writing `MASTHEAD_PORT` into the unit, plist or task. `unitPortFrom` already reads that on Linux.
- The 0.1.4 proof (`/api/proof`, bound to the port) keeps `open` and `stop` from talking to the wrong instance.

---

## 4. CI and release

**`ci.yml`** runs on push and PR: a matrix of `ubuntu-latest`, `macos-latest` and `windows-latest` × Node 22 and 24.
1. `npm ci --omit=optional`. CI never needs the private binary, and skipping it saves about 400 MB per job.
2. `npm run check`, `npm test`, `npm run build`.
3. `npm pack`, then `npm i -g ./luxorium-masthead-*.tgz --omit=optional`, then `masthead --version` and `masthead doctor --json` (expect "no backend" in CI).
4. Smoke test: `MASTHEAD_FAKE_BACKEND=1 masthead serve --port 0`… with a temporary data folder, then `/api/health` and `/api/proof`, then stop through `/api/shutdown` with the key.
5. `test/ui.e2e.mjs` with Playwright's own Chromium (`npx playwright install chromium`), against that server, with the fake backend.
6. On macOS and Windows only: generate the service files and validate them (`plutil -lint`; `schtasks /Create … /XML` then `/Delete`). A real logon start cannot be tested on hosted runners.

**Fake backend (from echo, 2026-11-27):**
- `server/backends/fake/` is an in-process backend, registered only when `MASTHEAD_FAKE_BACKEND=1`. It is written in Node and TypeScript, with no shell, so it is portable to Windows.
- It is scripted by markers in the message text: `[[tool:spawn_agent {...}]]`, `[[background 2s]]`, `[[limit 60s]]`, `[[ask]]`.
- **It does not exist yet.** It comes after `backends.md` migration steps 1–4 (about 3.5 days) plus about 1 day for the fake itself.
- Until then, CI runs check, unit tests, build, pack, install and the health/proof smoke test, which need no backend. The browser test joins when the fake lands.

**`release.yml`** runs on a tag `v*`:
1. Check that the tag equals `package.json` `version` and that `CHANGELOG.md` has a `## <version>` section.
2. Build and test on Linux.
3. `npm publish` with **npm trusted publishing**: no token, needs `permissions: id-token: write`, npm CLI ≥ 11.5.1 and Node ≥ 22.14.0 on the runner. Provenance is generated by default for GitHub Actions, but not for private repositories (https://docs.npmjs.com/trusted-publishers, fetched). The first publish must happen within 2 days of setting up the trusted publisher.
4. Create the GitHub Release with the CHANGELOG section as its notes, and the tarball and SHA256 attached.
5. Open PRs that bump the tap formula, the Scoop manifest and the AUR `PKGBUILD` (AUR is pushed over SSH with a deploy key, or bumped by hand).

**One place for the version:** `package.json`.
- The server reads it at build time: `tsc` cannot inline it, so either import `package.json` with `{ type: 'json' }`, or have a `prebuild` script write `shared/version.ts`.
- The page gets it through Vite `define`.
- A unit test asserts `VERSION === package.json.version`, so they can never drift. They did drift during 0.1.4.

---

## 5. Project hygiene for a public project

| Item | Recommendation |
|---|---|
| `SECURITY.md` | GitHub private vulnerability reporting (enable it in repository settings) plus an email; what counts (the local server, the secret, the proof, the sign-in file); expected response time; supported versions = latest minor |
| `CONTRIBUTING.md` | Build and test commands (from `AGENTS.md`), "never run against an installed copy on 7717", style, how to run the fake backend, DCO or no CLA (decision D7) |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1, with a contact address |
| Issue templates | Bug (asks for `masthead doctor --json`, OS, backend version), feature request, question → Discussions |
| README | Restructure: one paragraph of what it is; screenshot or GIF; **Quick start per platform** (Windows, macOS, Linux, each three commands: install the backend CLI, `npm i -g --omit=optional @luxorium/masthead` or `brew install luxorium/tap/masthead`, `masthead`); requirements; security in short; "not affiliated with Anthropic or OpenAI"; links into the wiki |
| Docs | Keep `docs/wiki/` as the developer reference; add a short `docs/guide/` for non-developers (install, first conversation, approvals, stopping, costs). A docs site (GitHub Pages from those Markdown files) is optional; it is cheap with a static generator, but not needed for 0.2.0 |
| Licence headers | Not needed: MIT is declared in `LICENSE` and `package.json`. Add SPDX `// SPDX-License-Identifier: MIT` only if the person wants it (cosmetic) |
| Name and trademark | **Nobody has checked the name.** Known so far: npm `masthead` is taken (a 2022 "Masthead Component", 1.0.0); a US trademark "MASTHEAD" (reg. 7220078, classes 35/36, business and financial services); a data company "Masthead Data" with a GitHub org `masthead-data`; "masthead" is also a common UI term. A real check means: a USPTO and EUIPO search in classes 9 and 42 (software, SaaS); a common-law search (product names, app stores, GitHub, domains); and ideally a lawyer's clearance opinion. The cost of a later rename grows with every package-manager listing (decision D2) |
| Branding | Do not put "Claude", "Claude Code", "Codex", "GPT" or vendor logos in the name, icon or title (Anthropic legal page; OpenAI brand page: "we do not permit our GPT brand to be used in app, product, developer or company names") |

---

## 6. Telemetry

**None.** Masthead makes no network calls of its own. The backends talk to their vendors. The only optional call would be a release check against the GitHub API or the npm registry, **off by default** and stated in the README. Crash reports go through issues with `doctor --json`, attached by the person.

---

## 7. Vendor terms (the main open risk)

Anthropic (fetched 2026-11-27):
- Agent SDK overview, https://code.claude.com/docs/en/agent-sdk/overview: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."*
- Legal and compliance, https://code.claude.com/docs/en/legal-and-compliance: *"Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription…"* and *"Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."*
- Support, https://support.claude.com/en/articles/15036540 (June 15, 2026): *"For now, nothing has changed: Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription limits."*
- Consumer Terms (October 8, 2025): forbid access "through automated or non-human means, whether through a bot, script, or otherwise" except with an API key or where explicitly permitted.

Reading: Masthead never handles credentials. The person installs the **unmodified** `claude` and signs in through Anthropic's own flow, and their usage counts against their own plan. That matches the legal page's carve-out. But Masthead is "a product … built on the Claude Agent SDK" that runs on the person's subscription sign-in, which the SDK page says needs prior approval. Whether a local open-source app that drives the user's own logged-in CLI counts as "offering claude.ai login" is **not answered** anywhere fetched. Press coverage (February 2026, "bans subscription OAuth in third-party apps"; later "reinstates … with a catch") shows the policy has moved before.

**Recommendation (decision D4): ask Anthropic in writing before a wide launch**, describing Masthead exactly. Meanwhile:
- document API key, Bedrock, Vertex and Foundry as supported sign-ins;
- keep "never touches credentials";
- say "not affiliated with or endorsed by Anthropic";
- avoid "Claude" in the name.

OpenAI: no clause found about third-party apps driving Codex with a ChatGPT sign-in. The Terms of Use forbid circumventing rate limits and "automatically or programmatically extract data or Output" (fetched summary; wording to be checked). The brand rules forbid model names and "GPT" in product names. The Usage Policies and Services Agreement were not read. The same recommendation applies before shipping the Codex backend.

---

## 8. What widens the audience most per unit of work

| Rank | Item | Gain | Work | In 0.2.0? |
|---|---|---|---|---|
| 1 | Native Windows | Probably the largest group of potential users; the CLIs already run there | Medium (section 1.2: about 15 code changes plus a Windows CI runner) | **Yes** |
| 2 | One-step install without a clone (npm, plus brew, AUR and Scoop wrappers) | Everyone; removes "clone and build" | Small to medium | **Yes** |
| 3 | Auto-start per platform (`service install`) | Makes it feel like an app | Medium | **Yes** |
| 4 | macOS | Large developer share | Small once 1 and 3 exist (opener, launchd, paths) | **Yes** |
| 5 | Works with an API key or cloud providers as well as a subscription | Removes the terms risk for cautious users and opens it to Team, Enterprise, Bedrock and Vertex setups; Claude Code already supports these | Small: Masthead passes the environment through already (`agentEnv`); `doctor` and docs must show it | **Yes (docs and doctor)** |
| 6 | Docs for non-developers (guide, first-run panel) | Widens beyond CLI users | Small | **Yes** |
| 7 | Second backend (Codex) | A new user group | Large (`backends.md`) | Planned separately, not a distribution item |
| 8 | No-Node download (SEA or bundled runtime) | Users without Node | Large, plus signing cost and the D3 legal question | **No: 0.3.0** |
| 9 | Accessibility (keyboard paths, screen-reader labels, contrast) | Users with disabilities; also general quality | Medium, needs an audit | Audit in 0.2.0, fixes as found |
| 10 | Translations | Non-English users | Medium (string extraction), then ongoing | **No**; prepare by keeping strings in one place |
| 11 | Container image | Few; poor fit | Small | **No** |

---

## 9. Exact file changes for 0.2.0 (distribution only)

- `package.json`: as in section 2.1; plus `"bin"` kept and `prepack`.
- New `server/platform.ts`: `appDirs()`, `findBackendBinary()` (PATHEXT, `.exe` first, `.cmd`→JS), `openFile()` (`xdg-open`/`gio`/`open`/`explorer.exe`), `isAbsoluteHere()`, `retryFs()`. Unit-tested here with injected `platform`.
- New `server/service/`: `index.ts` (interface: install, uninstall, status, serves(port), restart), `systemd.ts`, `launchd.ts`, `taskscheduler.ts`, `templates/`.
- `server/cli.ts`: `parseCommand` learns `service`, `doctor`, `--data-dir`, `--config-dir`, `--claude`; `openSignedIn` uses `openFile()` and a node-based delayed delete.
- `server/main.ts`:
  - `unitServes` becomes `service.serves`;
  - add the `doctor` and `service` commands;
  - handle `SIGHUP` and `SIGBREAK`;
  - add `windowsHide`;
  - an `'error'` handler in `detach`;
  - name the real data folder in messages (A22).
- `server/config.ts`: `appDirs`; `isAbsolute`; a secret ACL on Windows and a `linkSync` fallback; retries in `writeFileAtomic`.
- `server/store.ts`: `rmSync` retries.
- `server/app.ts`, `web/src/lib/FolderPicker.svelte`, `web/src/lib/store.svelte.ts`: Windows `~\`, drive list, path shortening.
- `server/http.ts:213`: decide assets from the URL path.
- `scripts/install.sh`, `scripts/uninstall.sh`, `scripts/path.sh`: shrink to a developer wrapper (pack, global install, `masthead service install`); `clean_path` moves to TypeScript.
- `packaging/`: keep the `.desktop` template; add the plist and Task Scheduler templates; generate PNG, ICNS and ICO from the SVG at build time.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/ISSUE_TEMPLATE/*`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`.
- `README.md` restructure; `docs/guide/`; wiki pages for the service and doctor commands.
- Tests: platform skips and per-platform expectations (A51–A61); new tests for `platform.ts` and the service templates; `VERSION === package.json`.
- Separate repositories: `Luxorium/homebrew-tap`, a Scoop bucket, AUR `masthead`.

## 10. Order of work

1. **Decisions D1–D4** (name, scope ownership, private binary, Anthropic question). The ask to Anthropic can run in parallel and gates only the public announcement.
2. `package.json` and pack hygiene, plus `ci.yml` on all three OSes with check, unit, build, pack and install-smoke steps. CI on Windows and macOS from day one surfaces the A-list.
3. `server/platform.ts` and the Windows and macOS bug fixes (opener, discovery, `isAbsolute`, the delete without `sh`, signals, retries, secret ACL), with platform test skips. Done when CI is green on all three.
4. `masthead service` (systemd port first, then launchd, then Task Scheduler) and `masthead doctor`.
5. The README quick starts, `docs/guide/`, the hygiene files, `release.yml` with trusted publishing.
6. First publish (`0.2.0-beta.N` under the `next` dist-tag), then the tap, Scoop and AUR.
7. The browser test in CI once echo's fake backend exists (after `backends.md` steps 1–4).
8. 0.3.0: the self-contained signed installers (if D3 and D6 allow).

## 11. Decisions for the person

- **D1. npm name.** `masthead` is taken. Options:
  - `@luxorium/masthead`: free today; the npm org "luxorium" must be created or owned; not checked.
  - `masthead-app` or `masthead-ai`: both free today.
  - Recommendation: `@luxorium/masthead`; the command stays `masthead`.
- **D2. Name clearance.** Do a trademark check (section 5) before listing in Homebrew, AUR and Scoop, or accept the rename risk.
- **D3. The private Claude Code binary.** Option A (`--omit=optional` in the docs, `doctor` warns) for 0.2.0? And will you ask Anthropic for permission to redistribute the SDK, which the self-contained installers of 0.3.0 need?
- **D4. Ask Anthropic (and later OpenAI)** whether a local app that drives the user's own signed-in CLI through the SDK is allowed with subscription sign-in. Launch publicly before or after the answer?
- **D5. macOS folders:** native `~/Library/Application Support/Masthead` (recommended) or XDG as on Linux? On Windows, `%APPDATA%`/`%LOCALAPPDATA%` (recommended).
- **D6. Signing budget for 0.3.0:** Apple Developer Program ($99 a year); Windows signing (Azure Artifact Signing, about $120 a year if eligible, or an OV certificate). Or ship unsigned with clear instructions?
- **D7. Contributions:** DCO sign-off or nothing; code of conduct contact address; security contact address.
- **D8. Minimum versions:** Node 22 (recommended, matches Claude Code's npm package); macOS 13+ and Windows 10 1809+ (matching Claude Code).

---

## Appendix A. Platform audit (61 findings)

The full table, file-relative lines at 0.1.4, as written by the audit agent and spot-checked. The tags are M (macOS), W (Windows), L (testable on Linux), CI-M/CI-W (needs a runner).

Most important, in order:
1. A8: `server/config.ts:187`: Windows sh shim, so Claude Code is reported missing.
2. A2: `server/config.ts:74`: `startsWith('/')` rejects every `C:\` folder.
3. A14: `server/cli.ts:155`: no opener on macOS or Windows.
4. A15/A18: `server/cli.ts:171` and `server/main.ts:68`: the `sh` delete, plus a missing `'error'` handler, crash the launcher on Windows.
5. A16/A36/A43: no launchd or Task Scheduler.
6. A3/A29: rename and `rm` EBUSY on Windows.
7. A4–A7: modes and hard links on NTFS and FAT.
8. A20: no SIGTERM on Windows; SIGHUP and SIGBREAK not handled.
9. A9: discovery misses `/opt/homebrew/bin` and `%USERPROFILE%\.local\bin\claude.exe`.
10. A24/A25: `~\` not expanded; no way to reach other drives.

| # | file:line | Platforms | Change | Test |
|---|---|---|---|---|
| 1 | server/config.ts:19-20 | M W | `appDirs()` native folders, XDG overrides kept | L |
| 2 | server/config.ts:74 | W | `path.isAbsolute` | L |
| 3 | server/config.ts:87-92 | W | retry rename on EPERM/EBUSY/EACCES | CI-W |
| 4 | server/config.ts:88,134,142; cli.ts:89-90,104; store.ts:42,69,76-79 | W | modes are ignored; set an ACL on the data folder once | CI-W |
| 5 | server/config.ts:137 | W | skip the `0o077` check on win32 | L/CI-W |
| 6 | server/config.ts:145 | W | `linkSync` fallback to `openSync('wx')` | CI-W |
| 7 | server/config.ts:144 | W | rename retry | CI-W |
| 8 | server/config.ts:187 | W | PATHEXT, `.exe` first, `.cmd`→JS entry | L+CI-W |
| 9 | server/config.ts:188 | M W | per-platform candidates | L+CI |
| 10 | server/config.ts:194 | W | as 8, plus `windowsHide` | CI-W |
| 11 | server/config.ts:206-213 | W | case-insensitive env keys | L |
| 12 | server/cli.ts:70-73 | M W | `os.tmpdir()` on mac; `isAbsolute` | L |
| 13 | server/cli.ts:88-106 | W | ACL (as 4) | CI-W |
| 14 | server/cli.ts:155 | M W | `open` / `explorer.exe` | L+CI |
| 15 | server/cli.ts:171 | W | delayed delete with node, not `sh` | L |
| 16 | server/main.ts:52-55 | M W | service abstraction | CI |
| 17 | server/main.ts:59 | W | PATH lookup in JS | L |
| 18 | server/main.ts:63,68 | W | `windowsHide`, `'error'` handler | CI-W |
| 19 | server/main.ts:131-134 | W | `windowsHide`; a real service | CI-W |
| 20 | server/main.ts:108-109 | W | SIGHUP, SIGBREAK | CI-W |
| 21 | server/main.ts:129,185 | M W | via the service abstraction | CI |
| 22 | server/main.ts:48,189,198 | M W | name the real data folder | L |
| 23 | server/main.ts:1 | W | none (npm makes shims) | n/a |
| 24 | server/app.ts:378,391 | W | `~\` expansion | L |
| 25 | server/app.ts:391-392 | W | drive list above `X:\` | L+CI-W |
| 26 | server/app.ts:395 | M W | optional: hide well-known folders | n/a |
| 27 | server/http.ts:213 | W | assets from the URL path | CI-W |
| 28 | server/http.ts:206-212 | W | add `%5c`, `C:`, UNC, `::$DATA` tests | CI-W |
| 29 | server/store.ts:101 | W | `rmSync` `maxRetries` | CI-W |
| 30 | server/store.ts:26 | — | none | n/a |
| 31 | server/agent.ts:425 | W | `.exe` or JS path only (as 8) | CI-W |
| 32 | server/agent.ts:914-920 | W | `taskkill /T` after `close()` | CI-W |
| 33 | web/src/lib/store.svelte.ts:550 | W | `\` after home | L |
| 34 | web/src/lib/FolderPicker.svelte:46 | W | server returns child paths | L |
| 35 | web/src/lib/FolderPicker.svelte:40 | W | drive list | CI-W |
| 36 | scripts/install.sh | M W | Node `service install` | CI |
| 37 | scripts/install.sh:20-24 | M W | native folders | CI |
| 38 | scripts/install.sh:31-36 | M | shared candidate list | L |
| 39 | scripts/install.sh:82 | M | `fs.cpSync` | CI-M |
| 40 | scripts/install.sh:85 | — | keep `--omit=optional` | — |
| 41 | scripts/install.sh:113-117 | W | `.cmd` shim (npm does it) | CI-W |
| 42 | scripts/install.sh:121-125 | M W | PATH with `path.delimiter`; plist PATH | L |
| 43 | scripts/install.sh:131-145 | M W | plist and Task Scheduler templates | CI |
| 44 | scripts/install.sh:158-165 | M W | `launchctl` / `schtasks` | CI |
| 45 | scripts/path.sh:7-16 | W | in TypeScript | L |
| 46 | scripts/uninstall.sh | M W | Node `service uninstall` | CI |
| 47 | packaging/masthead.desktop | M W | per-platform launcher | CI |
| 48 | packaging/masthead.svg | M W | generate ICNS/ICO | L |
| 49 | package.json:19 | W | confirm `node --test` globbing | CI-W |
| 50 | package.json:23-30 | M W | the private-binary decision (D3) | L |
| 51 | test/app.test.ts:300-311 | W | skip mode asserts | CI-W |
| 52 | test/launcher.test.ts:63-65 | W | expectations via `join` | L/CI-W |
| 53 | test/launcher.test.ts:72-73,92-95 | W | skip mode asserts | CI-W |
| 54 | test/launcher.test.ts:121,138,141 | M W | parametrize the opener | L |
| 55 | test/launcher.test.ts:227-229 | W | drop with `path.sh` | CI-W |
| 56 | test/app.test.ts:116-117 | W | drive case | CI-W |
| 57 | test/unit.test.ts:123,134; app.test.ts:154,162 | W | `C:\x` accepted, `\x` rejected | L |
| 58 | test/http.test.ts:217-225 | W | backslash traversal cases | CI-W |
| 59 | test/ui.e2e.mjs:20-22,43 | M W | `appDirs`; Playwright Chromium | CI |
| 60 | test/live.e2e.ts:175 | W | ask the SDK for the session path | CI-W |
| 61 | test/agent.test.ts:88,91; unit.test.ts:163 | — | none (mocked) | — |

Also noted: `sdk.d.ts:2105-2131`. Leaving `mcpServersDelivery` unset with a custom `pathToClaudeCodeExecutable` emits a DeprecationWarning (`CLAUDE_SDK_MCP_SERVERS_ARGV_DEPRECATED`). This is not platform-specific, but it applies to Masthead today.

## Appendix B. Sources

Fetched 2026-11-27 unless marked:
- code.claude.com/docs/en/setup
- code.claude.com/docs/en/agent-sdk/overview
- code.claude.com/docs/en/legal-and-compliance
- support.claude.com/en/articles/15036540
- learn.chatgpt.com/docs/windows/windows-sandbox, /docs/codex-sdk, /docs/non-interactive-mode, /docs/app-server, /codex/auth
- github.com/openai/codex
- openai.com/policies/terms-of-use (effective 2026-01-01)
- openai.com/brand
- nodejs.org/api/single-executable-applications.html
- developer.apple.com/programs and /support/developer-id
- docs.brew.sh/Acceptable-Formulae
- docs.npmjs.com/trusted-publishers (last edited 2026-10-06)
- the winget installer schema and Scoop manifest docs

Search results only, not fetched: Microsoft SmartScreen and EV changes; Azure Artifact Signing pricing and eligibility; the trademark record at markinton.com; press coverage at winbuzzer.com and venturebeat.com.

Not fetched: the Arch Node.js packaging guidelines (blocked); OpenAI Usage Policies and Services Agreement.

Commands run (read-only):
- `npm view masthead …`: 1.0.0, "Masthead Component", modified 2022-06-19.
- `npm view @luxorium/masthead`, `masthead-ai`, `masthead-app`, `mastheadjs`: all E404.
- `npm pack --dry-run --json`: 118 files, 494,383 B.
- `du` of `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64`: 384 MB.
