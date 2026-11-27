# server/doctor.ts

**Role:** `masthead doctor`. It runs a fixed list of checks of the set-up and returns one `Check` per line, with a fix where it has one. It changes nothing. Every probe of the system comes in through `DoctorDeps`, so the checks are tested without a real system (`test/doctor.test.ts`). [server/main.ts](Source-Main.md#doctorcommandp) fills in the real dependencies, prints the result and exits. The person's view is on [Command-line launcher](Command-Line-Launcher.md#doctor).

> Checked against the 0.2.0 source on branch `next` (2026-11-27). The behaviour described here is read from the code, not verified by running.

## Types

| Name | What |
|---|---|
| `Check` | `{ name, ok, warn?, detail, fix? }`. `warn` means "ok, but worth a look". |
| `DoctorFs` | `stat(path)` (`{ isDirectory, mode }`, or null when missing; `mode` is only read off Windows) and `writable(path)`. |
| `DoctorDeps` | `platform`, `nodeVersion`, `findClaude()`, `paths: { configDir, dataDir, secretFile }`, `fs`, `port`, `probe(port)` (`'free' \| 'ours' \| 'other'`), `service?` (a `ServiceManager` or null), `sdkBinary()`, `awakeTool?()` (`{ cmd, found }`). |
| `MIN_NODE` | `22`. |
| `systemDoctorFs` | The real `DoctorFs`: `statSync` and `accessSync(path, W_OK)`, both turning errors into null / false. |

## The checks, in order

`doctor(deps)` returns them in this order.

| # | Name | OK | WARN (ok, with `warn`) | FAIL | Fix |
|---|---|---|---|---|---|
| 1 | `Node.js` | major version ≥ 22: `v<version>` | | `v<version> is too old` | `Install Node.js 22 or newer.` |
| 2 | `Claude Code` | `<version> at <path>` | | no path: the error or `not found`; a path but an error or no version: `<path>: <error or 'its version could not be read'>`; `findClaude()` threw: its message | not found: install Claude Code and sign in by running `claude` once; version unreadable: ``Check that `<path> --version` works.`` |
| 3 | `Config folder` | the path | does not exist yet (made on first start) | not a folder; not writable | `Move <dir> out of the way.` / `Make <dir> writable by your user.` |
| 4 | `Data folder` | as for the config folder | as above | as above | as above |
| 5 | `Secret` | `<file> (mode 600)`; on Windows `(private through its folder's ACL; not checked)` | does not exist yet | it is a folder; (not Windows) group or others have any permission bit (`mode & 0o077`) | `Remove <file>; a new secret is made on the next start.` / `chmod 600 '<file>'` |
| 6 | `Port <n>` | `free`; `served by this Masthead` | | `in use by another program`; probe threw: `could not be checked: …` (also has `warn`) | `Stop that program, or use another port: masthead --port <n>.` |
| 7 | `Service` | the service's own `detail` while running | no service manager on this platform (``none on <platform>; run Masthead with: masthead``); not installed (`not installed (<kind>)`, fix `masthead service install`); installed with state unknown | installed but not running (fix `masthead service install`); status threw: `could not be checked: …` (also has `warn`) | see the cells |
| 8 | `SDK private binary` | `not installed (Masthead runs your own Claude Code)` | `<dir> holds an unused private copy of Claude Code` | | `Reinstall without it: npm i -g --omit=optional @luxorium/masthead` |
| 9 | `Keep awake` (only when `awakeTool` is given) | `<cmd> holds off idle sleep while agents work` | no tool on this platform; tool not on `PATH` (the computer may sleep while agents work) | | Linux only: `Install systemd (systemd-inhibit), or keep the computer awake yourself` |

Notes:

- The port probe in `main.ts`: `free` when `/api/health` does not answer as Masthead; `ours` when it does and the server proves it knows this data folder's secret (`serverProves()`, [server/cli.ts](Source-Cli.md#serverprovesbase-port-secret-fetchfn)); otherwise `other`. A Masthead started with another data folder therefore shows as `in use by another program`.
- The secret's mode check reads only the permission bits; owner rights are not checked. On Windows nothing is checked: the file is private through the ACL of the person's profile folder ([Security model](Security-Model.md#files-on-disk)).
- `sdkBinaryPackage(platform, arch, resolve)` resolves `@anthropic-ai/claude-agent-sdk` and then, from it, `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` or its `-musl` variant, returning the package folder or null. Masthead never runs that copy; it runs the person's own `claude`. The check is a warning only.
- `awakeTool` in `main.ts` uses `awakeCommand(process.platform, process.pid)` and `onPath()` ([Keep awake](Source-Service.md#keep-awake-awakets)).

## Output and exit code

- `formatChecks(checks)`: one line `[<mark>] <name>: <detail>` per check, where the mark is `FAIL` when not ok, `WARN` when ok with `warn`, else ` OK `. A failing or warning check with a `fix` gets a second line, `       fix: <fix>`.
- `--json` (in `main.ts`): `JSON.stringify(checks, null, 2)`, the `Check` objects as they are.
- `doctorExitCode(checks)`: 0 when every check has `ok` true, warnings included; else 1. The same with or without `--json`.

## Related pages

[Command-line launcher](Command-Line-Launcher.md#doctor) · [server/main.ts](Source-Main.md#doctorcommandp) · [server/paths.ts](Source-Paths.md) · [server/service](Source-Service.md) · [Security model](Security-Model.md) · [Platforms](Platforms.md) · [Tests](Source-Tests.md)
