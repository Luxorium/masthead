# Platforms: Linux, macOS and Windows

From 0.2.0 Masthead runs natively on Linux, macOS (13 or newer) and Windows (10 1809 or newer, and 11), not through WSL. WSL counts as Linux. This page lists every place where the code does something different per system. It was read from the code on branch `next` on 2026-11-27. Only Linux was run here: the macOS and Windows behaviour below is **not verified by running**. The plan behind it is `docs/plans/0.2.0/distribution.md`.

Most of these functions take the platform, environment or file checks as arguments. The unit tests (`test/platform.test.ts`, `test/service.test.ts`, `test/launcher.test.ts`, `test/awake.test.ts`) call them with `win32`, `darwin` and `linux` on any machine.

## At a glance

| | Linux | macOS | Windows |
|---|---|---|---|
| Settings folder | `~/.config/masthead` | `~/Library/Application Support/Masthead` | `%APPDATA%\Masthead` |
| Data folder (conversations, secret) | `~/.local/share/masthead` | same folder as settings | `%LOCALAPPDATA%\Masthead` |
| Sign-in file folder | `$XDG_RUNTIME_DIR/masthead`, else `<data>/open` | `$TMPDIR/masthead`, else `<data>/open` | `<data>\open` |
| Opens the browser with | `xdg-open`, else `gio open` | `open` | `explorer.exe` |
| Secret kept private by | file mode 0600 | file mode 0600 | `icacls` by the user's SID, checked |
| Background service | systemd user unit | launchd agent | Task Scheduler logon task |
| Keep-awake | `systemd-inhibit` | `caffeinate` | PowerShell + `SetThreadExecutionState` |
| Stop signals handled | SIGINT, SIGTERM, SIGHUP | SIGINT, SIGTERM, SIGHUP | the same plus SIGBREAK (SIGTERM never arrives) |
| Busy-file retries | no | no | yes |
| Folder picker | `/` is the top | `/` is the top | a list of drives above `C:\` |

## Folders

`appDirs(platform, env, home)` in `server/paths.ts` decides where settings and data live.

| System | `config` | `data` |
|---|---|---|
| Linux (and anything not macOS or Windows) | `~/.config/masthead` | `~/.local/share/masthead` |
| macOS | `~/Library/Application Support/Masthead` | the same folder |
| Windows | `%APPDATA%\Masthead` (else `~\AppData\Roaming\Masthead`) | `%LOCALAPPDATA%\Masthead` (else `~\AppData\Local\Masthead`) |

On every system, overrides win in this order, last one strongest:
1. `XDG_CONFIG_HOME` / `XDG_DATA_HOME` (then `<value>/masthead`);
2. `MASTHEAD_CONFIG_DIR` / `MASTHEAD_DATA_DIR` (used as they are).

Linux keeps the folders 0.1.x used. macOS and Windows had no earlier install, so nothing moves. Files in them: `settings.json` in config; `conversations/` and `secret` in data. Details: [Storage on disk](Storage-on-Disk.md), [server/paths.ts](Source-Paths.md).

## Finding Claude Code

`server/backends/claude/env.ts`. The Agent SDK never searches `PATH` itself and starts the program **without a shell**, so Masthead finds the program and hands the SDK an exact path.

`claudeCandidates()` lists, in order:
1. `MASTHEAD_CLAUDE`, if set.
2. `claude` in every absolute folder on `PATH`.
3. The installers' places, because a service's `PATH` is often short (launchd's is only `/usr/bin:/bin:/usr/sbin:/sbin`):
   - Linux and macOS: `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, `~/.bun/bin`; macOS also `/opt/homebrew/bin`; then `/usr/local/bin`, `/usr/bin`.
   - Windows: `%USERPROFILE%\.local\bin` (the native installer's `claude.exe`) and `%APPDATA%\npm` (npm's shims).

On Windows, environment names are matched without regard to case, `PATH` is split on `;`, and each name is tried with `.exe` first, then the other `PATHEXT` extensions (default `.COM;.EXE;.BAT;.CMD`).

`locateClaude()` takes the first candidate that exists and can be started without a shell:
- Linux and macOS: any file that exists.
- Windows: `.exe`, `.js`, `.cjs` or `.mjs` as they are.
- Windows `.cmd` or `.bat` (npm's shims): Node refuses to start these without a shell. `resolveShim()` reads the shim and finds the real target it names relative to itself (`"%dp0%\node_modules\…\claude.exe"` or a `.js` file). That target is used if it exists.
- Windows, anything else (npm's extension-less `sh` shim, `.ps1`): skipped.

`findClaude()` then runs `<path> --version` (a `.js` target through this Node) with a 15 s time-out and `windowsHide`. Details: [Claude backend](Source-Backend-Claude.md).

## Opening the browser signed in

`server/cli.ts`. `masthead` (the launcher) opens the page through a private sign-in file, so the key is never on a command line. See [Command-line launcher](Command-Line-Launcher.md) and [Security model](Security-Model.md).

- **Opener** (`openersFor`): Linux tries `xdg-open`, then `gio` (run as `gio open <file>`); macOS uses `open`; Windows uses `explorer.exe`.
- **Finding it** (`onPath`): `PATH` is searched in JavaScript, not through `sh -c 'command -v'` (Windows has no `sh`). On Windows a name without an extension is tried with each `PATHEXT` extension.
- **Success**: the opener exits 0, or is still running after 3 s. `explorer.exe` exits with 1 even when it worked, so there only "could not start" counts as failure.
- **Sign-in file folder** (`signInDir`): `$XDG_RUNTIME_DIR/masthead` when that is set and absolute (not on Windows); on macOS `$TMPDIR/masthead` (per user, 0700); else `<data>/open`. On Windows that is `%LOCALAPPDATA%\Masthead\open`. The folder is made 0700 and the file 0600 (on Windows the modes do nothing; the folder's privacy comes from `%LOCALAPPDATA%`).
- **Removal**: a minute later, by a detached `node -e "setTimeout(… rmSync …)"` (`removeLaterArgs`). No shell, so it works on Windows. Files older than 2 minutes are removed on the next run.
- All children are started with `windowsHide: true`, so no console window flashes on Windows.

## The secret's privacy

`makePrivate()` in `server/transport/auth.ts`:
- **Linux and macOS**: if the file's mode lets the group or others in (`mode & 0o077`), it is set to 0600.
- **Windows**: modes mean nothing on NTFS. The current user's SID is read with `whoami /user` (a SID cannot be faked through environment variables). The data folder is made private first (`makeDirPrivate`: `icacls <dir> /inheritance:r /grant:r *<SID>:(OI)(CI)F`), so a file created inside it is private from the moment it exists; the file then gets `*<SID>:F` as well. Every `icacls` result is checked: if it fails, `loadSecret()` throws and Masthead does not start. `isPrivate()` reads the ACL back (`icacls <file>`: exactly one entry, not inherited, no group such as Everyone or Users); `masthead doctor` uses it.
- On every platform a secret that others could read is **replaced**, not tightened: it may already have been read. The sign-in file's folder is made private the same way before the file is written (`writeSignInFile`).

`loadSecret()` creates the secret once, atomically, with a hard link. File systems without hard links (FAT, exFAT, some network and synced folders: codes `EPERM`, `ENOTSUP`, `EXDEV`, `EINVAL`, `ENOSYS`) fall back to an exclusive create (`flag: 'wx'`). Details: [Transport auth](Source-Transport-Auth.md).

## Background service

`server/service/`. `serviceFor(platform)` in `index.ts` gives one `ServiceManager` per system (`install`, `uninstall`, `status`, `serves(port)`), used by `masthead service install|uninstall|status [--port N] [--force]` in `server/main.ts`. Everything touching the system goes through injected `Deps`, so the tests check the files and commands without running them. Other systems get `null`: "Masthead has no background service for <platform>; run `masthead serve` instead."

| | Linux: `systemd.ts` | macOS: `launchd.ts` | Windows: `taskscheduler.ts` |
|---|---|---|---|
| File | `$XDG_CONFIG_HOME/systemd/user/masthead.service` (default `~/.config/…`) | `~/Library/LaunchAgents/io.github.luxorium.masthead.plist` | XML written to a temp file, then imported as task `Masthead` |
| Runs | `node --disable-warning=… main.js serve` | the same | `conhost.exe --headless node.exe --disable-warning=… main.js serve [--port N]` (no visible window) |
| Environment | `PATH` (Node's and Claude's folders first, the current `PATH`, `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, cleaned), `MASTHEAD_CLAUDE`, `XDG_*` if set, `MASTHEAD_PORT` if not 7717 | the same, with `/opt/homebrew/bin`, `/usr/sbin`, `/sbin` added | none: a task cannot set variables. It inherits the person's logon environment. The port goes on the command line |
| Restart | `Restart=on-failure`, after 2 s | `KeepAlive` with `SuccessfulExit=false` (restart only after a crash) | `RestartOnFailure` every minute, 3 times |
| Install | `systemctl --user daemon-reload`, `enable`, `restart` (fails if systemd user services are not available) | `launchctl bootout` (ignored if not loaded), then `bootstrap gui/<uid> <plist>` | `schtasks /End`, `/Create /XML <file> /F` (UTF-16 with BOM), `/Run` |
| Status | `systemctl --user show` (`LoadState`, `ActiveState`, `Environment`) | `launchctl print gui/<uid>/<label>` (`state =`, `MASTHEAD_PORT =>`) | `schtasks /Query /FO LIST /V` (`Status:`, `Task To Run:`; English field names only) |
| Logs | the journal | `~/Library/Logs/Masthead/masthead.log` | none |
| Rights | user unit, no root | per-user agent, no root | `LeastPrivilege`, `InteractiveToken`, no admin |

On Windows `install` warns when `MASTHEAD_CLAUDE`, `XDG_CONFIG_HOME` or `XDG_DATA_HOME` is set in the shell, because the task will not see them ("Set them with `setx`…"). It does not warn about `MASTHEAD_DATA_DIR` or `MASTHEAD_CONFIG_DIR`, which the task also does not see (read from the code).

`install` first asks `/api/health` on the port; if agents are working it refuses unless `--force`. `status` exits 3 when not installed.

The launcher's `start`/`stop` use `systemctl` only on Linux, and only when the unit serves that port (`unitServes()` in `server/main.ts`). On macOS and Windows the launcher starts a detached copy itself and stops any copy through `/api/shutdown`. launchd and Task Scheduler do not restart a server that exits cleanly.

`launchd.ts` and `taskscheduler.ts` each say at the top that they are unverified without a real Mac or Windows machine. `scripts/install.sh` still writes its own systemd unit on Linux (see [Installing](Source-Install-Scripts.md)).

## Keep-awake

`server/service/awake.ts`. While any agent works, Masthead holds off **idle** sleep only: the lid, the power button and an explicit Sleep still work, and the screen may still turn off. The hold is a child process that ends by itself when the server ends, even after a crash.

| System | Command | Ends when |
|---|---|---|
| Linux | `systemd-inhibit --what=idle --who=Masthead --why="Agents are working" --mode=block cat` | its stdin closes |
| macOS | `caffeinate -i -w <server pid>` | the server process is gone |
| Windows | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command …`: `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)`, then wait on stdin | its stdin closes |

The hold is released 5 s after the last agent stops (`RELEASE_AFTER_MS`), so short gaps do not flap it. If the tool is missing or exits, Masthead carries on and `masthead doctor` reports it. Other systems: "Keeping the computer awake is not supported on <platform>."

## Signals and stopping

- `server/main.ts` handles `SIGINT`, `SIGTERM` and `SIGHUP` everywhere, and `SIGBREAK` on Windows. Windows never sends SIGTERM: closing the console window gives SIGHUP, Ctrl+Break gives SIGBREAK. The reliable stop on every system is `masthead stop`, which posts to `/api/shutdown`.
- Stopping an agent stops the commands it started (`server/backends/proctree.ts`). Linux and macOS: the CLI gets its own process group; a stop sends SIGTERM to the group, then SIGKILL after 3 s. Windows: `taskkill /T /F /PID <pid>` ends the whole tree. The file says it is verified on Linux only.

## Windows file retries

`renameRetry()` in `server/storage/atomic.ts` (and a copy in `server/transport/auth.ts`). On Windows, antivirus or the search indexer may briefly hold a file, and a rename then fails with `EPERM`, `EBUSY` or `EACCES`. It retries up to ten times, waiting 20, 40, … 180 ms (about a second in all). On other systems, or with any other error, it throws at once. `writeFileAtomic()`, the blob store and the remote-device registry use it. Deleting a conversation uses `rmSync` with `maxRetries: 5, retryDelay: 100` (`server/storage/store.ts`).

## Folder picker drives

`server/app/app.ts`:
- `DRIVES` is `'drives:'`, a name no folder can have. On Windows the parent of a drive root (`C:\`) is `DRIVES`, and listing `DRIVES` gives the drive roots that exist, `A:\` to `Z:\` (`windowsDrives()`). So another drive can be reached. Elsewhere `/` has no parent.
- `expandHome()` expands a leading `~`. On Windows `~\` works as well as `~/`.
- Saved folders are checked with `path.isAbsolute` (`absoluteFolder()` in `server/settings/settings.ts`), so `C:\…` is accepted.

## What CI proves and what needs a real machine

CI is described on [CI](Source-CI.md). The real-machine checks are in `docs/plans/0.2.0/release-checklist.md`, each to be dated and signed off before 0.2.0 is tagged.

| Area | Linux | macOS | Windows | Real machine only (checklist §) |
|---|---|---|---|---|
| Type check, unit and web tests | CI | CI | CI | – |
| Build, pack, install with `--os=none --cpu=none`, `masthead --version` | CI | CI | CI | – |
| The page in Chromium on the fake backend | CI | CI | CI | Other browsers (§1) |
| Folder and candidate logic (pure functions) | CI | CI | CI | – |
| Browser opens signed in, sign-in file removed | unit tests only | unit tests only | unit tests only | §1 (macOS, Windows) |
| Service starts at login, no console window | file contents only | file contents only | file contents only | §2 (all three) |
| Claude Code found per install method | fake file systems | fake file systems | fake file systems | §3 (Windows; macOS Homebrew) |
| Stopping leaves no child processes | unit tests | unit tests | unit tests | §4 (Windows) |
| Remote access over Tailscale | – | – | – | §5 |
| A real usage limit | – | – | – | §6 |
| Upgrade from 0.1.4 with real data | – | – | – | §7 (Linux) |
| Secret readable only by the owner | unit tests | unit tests | `icacls` call only | §8 (Windows) |
| Keep-awake | unit tests | unit tests | unit tests | §9 (all three) |
| Anything with a real Claude Code | – | – | – | all (CI has no account) |

## Related pages

[CI](Source-CI.md) · [Building, testing and installing](Building-Testing-Installing.md) · [Installing](Source-Install-Scripts.md) · [Command-line launcher](Command-Line-Launcher.md) · [Storage on disk](Storage-on-Disk.md) · [Security model](Security-Model.md) · [Claude backend](Source-Backend-Claude.md) · [server/paths.ts](Source-Paths.md)
