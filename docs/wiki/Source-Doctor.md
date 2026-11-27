# server/doctor.ts

**Role:** `masthead doctor`. It runs a fixed list of checks of the set-up and returns one `Check` per line, with a fix where it has one. It changes nothing. Every probe of the system comes in through `DoctorDeps`, so the checks are tested without a real system (`test/doctor.test.ts`). [server/main.ts](Source-Main.md#doctorcommandp) fills in the real dependencies, prints the result and exits. The person's view is on [Command-line launcher](Command-Line-Launcher.md#doctor).

> Checked against the 0.2.0 source on branch `next` (2026-11-27). The behaviour described here is read from the code, not verified by running.

## Types

| Name | What |
|---|---|
| `Check` | `{ name, ok, warn?, detail, fix? }`. `warn` means "ok, but worth a look". |
| `DoctorFs` | `stat(path)` (`{ isDirectory, mode }`, or null when missing; `mode` is only read off Windows) and `writable(path)`. |
| `DoctorDeps` | `platform`, `nodeVersion`, `findClaude()`, `paths: { configDir, dataDir, secretFile }`, `fs`, `port`, `probe(port)` (`'free' \| 'ours' \| 'other'`), `service?` (a `ServiceManager` or null), `sdkBinary()`, `awakeTool?()` (`{ cmd, found }`), `isPrivate?(file)` (Windows: whether only the current user can reach the file, read with icacls; `isPrivate()` in `server/transport/auth.ts`), `serviceUsage?()` (Linux: the running service's `{ memoryBytes, children }` or null, `serviceUsage()` in `server/service/usage.ts`), `totalMemory?` (`os.totalmem()`), `tmp?()` (Linux: `{ path, fstype, size, free }` of `/tmp` or null, `tmpInfo()` in `usage.ts`). `main.ts` passes `serviceUsage` and `tmp` only on Linux (`main.ts:172-173`). |
| `MIN_NODE` | `22`. |
| `MEMORY_WARN_SHARE` | `0.5`: the service using half the RAM or more is a warning. |
| `TMP_SMALL_BYTES`, `TMP_FREE_SHARE` | 2 GiB and `0.2`: a tmpfs `/tmp` smaller than 2 GiB, or with less than a fifth of it free, is a warning. |
| `formatBytes(n)` | `<n> GB` with one decimal from 1 GiB up, else whole `MB` (binary units). |
| `systemDoctorFs` | The real `DoctorFs`: `statSync` and `accessSync(path, W_OK)`, both turning errors into null / false. |

## The checks, in order

`doctor(deps)` returns them in this order.

| # | Name | OK | WARN (ok, with `warn`) | FAIL | Fix |
|---|---|---|---|---|---|
| 1 | `Node.js` | major version ≥ 22: `v<version>` | | `v<version> is too old` | `Install Node.js 22 or newer.` |
| 2 | `Claude Code` | `<version> at <path>` | | no path: the error or `not found`; a path but an error or no version: `<path>: <error or 'its version could not be read'>`; `findClaude()` threw: its message | not found: install Claude Code and sign in by running `claude` once; version unreadable: ``Check that `<path> --version` works.`` |
| 3 | `Config folder` | the path | does not exist yet (made on first start) | not a folder; not writable | `Move <dir> out of the way.` / `Make <dir> writable by your user.` |
| 4 | `Data folder` | as for the config folder | as above | as above | as above |
| 5 | `Secret` | `<file> (mode 600)`; on Windows `<file> (only you have access)`, read from the ACL by `isPrivate()` (icacls) | does not exist yet; on Windows without an ACL probe `(permissions not checked)` | it is a folder; group or others have any permission bit (`mode & 0o077`); on Windows the ACL has another entry, an inherited one, or cannot be read | `Remove <file>; a new secret is made on the next start.` / `Restart Masthead: a secret others could read is replaced with a new one (sign in again with masthead).` / Windows: `Delete <file> and restart Masthead; a new private secret is made.` |
| 6 | `Port <n>` | `free`; `served by this Masthead` | | `in use by another program`; probe threw: `could not be checked: …` (also has `warn`) | `Stop that program, or use another port: masthead --port <n>.` |
| 7 | `Service` | the service's own `detail` while running | no service manager on this platform (``none on <platform>; run Masthead with: masthead``); not installed (`not installed (<kind>)`, fix `masthead service install`); installed with state unknown; installed and running but the service file is outdated (`ServiceStatus.outdated`, systemd only: `OOMPolicy` is not `continue`, or no `ExecStopPost=` line with `masthead-last-stop`), detail `<detail>; <outdated>` with fix `masthead service install (or run scripts/install.sh again if you installed with it)` | installed but not running (fix `masthead service install`); status threw: `could not be checked: …` (also has `warn`) | see the cells; on Windows every command is written `masthead.cmd` (`mastheadCommand()` in `server/paths.ts`), because stock PowerShell refuses npm's `masthead.ps1` |
| 8 | `Service memory` (only with `serviceUsage` and `totalMemory`, and when the service is running and systemd accounts its memory; a probe that throws drops the line) | `<used> of <total> RAM, <n> child process(es) (agents' tools and browsers)` (the child part left out when they cannot be counted) | used ≥ half the RAM: the detail plus `: high; if memory runs out, the system kills processes and agents' work can be lost` | | `Close conversations you no longer need and ask agents to close browsers they have finished with; everything in the service stops when Masthead restarts.` |
| 9 | `Temporary folder` (only with `tmp`, and only when `/tmp` is a `tmpfs` of known size) | `/tmp is in memory (tmpfs): <free> free of <size>` | smaller than 2 GiB (`: small`) or less than 20 % free (`: nearly full`, which wins when both) | | ``Masthead's agents use their own scratch folders on disk; other programs still use /tmp. Remove what you no longer need from /tmp, or make it larger (systemctl edit tmp.mount, Options=size=...).`` |
| 10 | `SDK private binary` | `not installed (Masthead runs your own Claude Code)` | `<dir> holds an unused private copy of Claude Code` | | `Reinstall without it: npm i -g --os=none --cpu=none <release tarball URL>`, the URL from `releaseTarball(VERSION)`: `https://github.com/Luxorium/masthead/releases/download/v<version>/luxorium-masthead-<version>.tgz` (npm ignores `--omit=optional` for a global install) |
| 11 | `Keep awake` (only when `awakeTool` is given) | `<cmd> holds off idle sleep while agents work` | no tool on this platform; tool not on `PATH` (the computer may sleep while agents work) | | Linux only: `Install systemd (systemd-inhibit), or keep the computer awake yourself` |

Notes:

- The port probe in `main.ts`: `free` when `/api/health` does not answer as Masthead; `ours` when it does and the server proves it knows this data folder's secret (`serverProves()`, [server/cli.ts](Source-Cli.md#serverprovesbase-port-secret-fetchfn)); otherwise `other`. A Masthead started with another data folder therefore shows as `in use by another program`.
- The secret's mode check reads only the permission bits; owner rights are not checked. On Windows the mode is not read; the ACL is read instead through `isPrivate` (`main.ts` passes `isPrivate()` from `server/transport/auth.ts`). Without `isPrivate` the check is a warning, `(permissions not checked)` ([Security model](Security-Model.md#files-on-disk)).
- `sdkBinaryPackage(platform, arch, resolve)` resolves `@anthropic-ai/claude-agent-sdk` and then, from it, `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` or its `-musl` variant, returning the package folder or null. Masthead never runs that copy; it runs the person's own `claude`. The check is a warning only.
- Lines 8 and 9 (new in 0.2.1, `doctor.ts:188-226`) are left out rather than shown as OK when they do not apply, so on macOS and Windows, and on a Linux without a running service or with `/tmp` on disk, the list is two lines shorter. Neither ever fails. Scratch folders: [server/service](Source-Service.md#scratchts).
- `awakeTool` in `main.ts` uses `awakeCommand(process.platform, process.pid)` and `onPath()` ([Keep awake](Source-Service.md#keep-awake-awakets)).

## Output and exit code

- `formatChecks(checks)`: one line `[<mark>] <name>: <detail>` per check, where the mark is `FAIL` when not ok, `WARN` when ok with `warn`, else ` OK `. A failing or warning check with a `fix` gets a second line, `       fix: <fix>`.
- `--json` (in `main.ts`): `JSON.stringify(checks, null, 2)`, the `Check` objects as they are.
- `doctorExitCode(checks)`: 0 when every check has `ok` true, warnings included; else 1. The same with or without `--json`.

## Related pages

[Command-line launcher](Command-Line-Launcher.md#doctor) · [server/main.ts](Source-Main.md#doctorcommandp) · [server/paths.ts](Source-Paths.md) · [server/service](Source-Service.md) · [Security model](Security-Model.md) · [Platforms](Platforms.md) · [Tests](Source-Tests.md)
