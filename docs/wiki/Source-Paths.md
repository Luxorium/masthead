# server/paths.ts

**Role:** where Masthead keeps its settings and data on each platform, and the fixed paths and port built from them. It has no side effects beyond reading `process.platform`, `process.env` and the home folder once, when the module loads. Every other module that needs a folder imports it from here.

> Checked against the 0.2.0 source on branch `next` (2026-11-27). The behaviour described here is read from the code, not verified by running. The macOS and Windows folders were not verified on those systems.

## appDirs(platform, env, home)

Returns `{ config, data }`: the settings folder and the data folder. Paths are joined with Windows rules on `win32` and POSIX rules elsewhere, so the function can be tested for any platform from any platform (`test/platform.test.ts`).

### Platform defaults

| Platform | `config` | `data` |
|---|---|---|
| Linux and anything not macOS or Windows | `~/.config/masthead` | `~/.local/share/masthead` |
| macOS (`darwin`) | `~/Library/Application Support/Masthead` | the same folder |
| Windows (`win32`) | `%APPDATA%\Masthead` (else `~\AppData\Roaming\Masthead`) | `%LOCALAPPDATA%\Masthead` (else `~\AppData\Local\Masthead`) |

The code comment explains the choice: Linux keeps the XDG folders it always had; macOS and Windows use their native places, and since no Masthead install existed there before 0.2.0, nothing has to move.

### Override order

On **every** platform, each folder is chosen in this order (the first that is set wins):

| Order | `config` | `data` |
|---|---|---|
| 1 | `MASTHEAD_CONFIG_DIR` (used as it is) | `MASTHEAD_DATA_DIR` (used as it is) |
| 2 | `$XDG_CONFIG_HOME/masthead` | `$XDG_DATA_HOME/masthead` |
| 3 | the platform default above | the platform default above |

An empty variable counts as not set. So `XDG_CONFIG_HOME` also moves the settings on macOS and Windows, and a `MASTHEAD_*_DIR` value is not given a `masthead` subfolder. Relative values are not rejected here.

## mastheadCommand(platform = process.platform)

The command a person should type: `masthead.cmd` on `win32`, else `masthead`. Stock Windows PowerShell refuses npm's `masthead.ps1` ("running scripts is disabled"); `masthead.cmd` works in PowerShell and Command Prompt alike. Used in the hints printed by `main.ts`, `cli.ts` and `doctor.ts`.

## Constants

| Name | Value |
|---|---|
| `DEFAULT_PORT` | `7717`. The port when neither `--port` nor `MASTHEAD_PORT` is given ([server/cli.ts](Source-Cli.md#parseportargs-env)). |
| `AppDirs` (type) | `{ config: string; data: string }`, what `appDirs()` returns. |
| `HOME` | `os.homedir()`. |
| `CONFIG_DIR` | `appDirs(process.platform, process.env, HOME).config`. |
| `DATA_DIR` | `appDirs(...).data`. |
| `SETTINGS_FILE` | `<CONFIG_DIR>/settings.json` ([Configuration and settings](Configuration-and-Settings.md)). |
| `CONVERSATIONS_DIR` | `<DATA_DIR>/conversations` ([Storage on disk](Storage-on-Disk.md)). |
| `SECRET_FILE` | `<DATA_DIR>/secret`, the local server's secret. Only a browser signed in with it, or a program that can read the file, may drive Masthead ([Security model](Security-Model.md#the-local-secret)). |

The constants are computed once when the module loads. Changing an environment variable later in the same process does not move them.

## Who uses it

- [server/main.ts](Source-Main.md): `DATA_DIR` (the remote-access folder `<DATA_DIR>/remote`, sign-in files, messages), `SECRET_FILE`, `CONFIG_DIR` (for `doctor`), `DEFAULT_PORT`, `mastheadCommand`.
- [server/cli.ts](Source-Cli.md): `DEFAULT_PORT`, `mastheadCommand`.
- [server/doctor.ts](Source-Doctor.md): `mastheadCommand`; it gets the folders from `main.ts` and checks they exist and are writable.
- [server/service](Source-Service.md): `DEFAULT_PORT` (all three service kinds), to decide whether to write `MASTHEAD_PORT` or `--port`; `common.ts` also calls `appDirs()` in `dataDirNote()` to show which data folder an installed service uses.
- [server/settings/settings.ts](Source-Settings.md) and [server/app/app.ts](Source-App.md): `HOME`, `SETTINGS_FILE`.
- `server/storage/store.ts`: `CONVERSATIONS_DIR`. `server/transport/auth.ts`: `SECRET_FILE`. `server/backends/claude/env.ts`: `HOME`.
- `server/transport/remote.ts`: `appDirs(platform, {}, home)` and `HOME`, to name the remote socket `remote.sock` for the default data folder and `remote-<hash>.sock` otherwise.

A service started at login must look in the same folders as the `masthead` command. On Linux and macOS `masthead service install` passes `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `MASTHEAD_CONFIG_DIR` and `MASTHEAD_DATA_DIR` on to the service when set (`DIR_VARS` in `server/service/common.ts`); on Windows the scheduled task carries none of them, and `install` says which ones would be lost ([server/service](Source-Service.md#commonts)).

## Related pages

[server/main.ts](Source-Main.md) · [server/cli.ts](Source-Cli.md) · [server/service](Source-Service.md) · [server/doctor.ts](Source-Doctor.md) · [Storage on disk](Storage-on-Disk.md) · [Configuration and settings](Configuration-and-Settings.md) · [Security model](Security-Model.md) · [Platforms](Platforms.md)
