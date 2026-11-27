# Configuration and settings

There are two ways to configure Masthead:

- **Settings**: the person changes these in the page's settings and team panels. They are saved to `settings.json`.
- **Environment variables**: read when the program starts.

Command-line options (`--port`, `--no-browser` and the rest) belong to the launcher. They are documented on [Command-line launcher](Command-Line-Launcher.md) and [Building, testing and installing](Building-Testing-Installing.md).

Settings types: `Settings` in `shared/protocol.ts`. Validation and defaults: `server/settings/settings.ts`. Folders: `server/paths.ts`.

## Where the settings file is

`settings.json` in the config folder (`SETTINGS_FILE`):

| Platform | Default path |
|---|---|
| Linux and others | `~/.config/masthead/settings.json` (or `$XDG_CONFIG_HOME/masthead/settings.json`) |
| macOS | `~/Library/Application Support/Masthead/settings.json` |
| Windows | `%APPDATA%\Masthead\settings.json` |

`MASTHEAD_CONFIG_DIR` overrides the folder on every platform. The file is format version 2. A 0.1.x file is backed up to `settings.json.v1.bak` once and migrated; see [Team profiles and settings](Team-Profiles-and-Settings.md#migration-from-01x). If the file cannot be read or parsed, the defaults apply, and the file is overwritten at the next change.

## Every setting

| Field | Type / range | Default | Meaning |
|---|---|---|---|
| `profiles` | list of team profiles | the built-in `claude` profile (plus `codex` once Codex is detected) | The teams: each tier's backend, model, effort ceiling, `max`, lean switch, label and colour. The source of truth for tiers. See [Team profiles and settings](Team-Profiles-and-Settings.md). |
| `defaultProfile` | an existing profile id | `claude` | The team a new conversation uses unless the person picks another. |
| `tiers.<lead\|opus\|sonnet\|haiku>` | `{model, effort, max}` | from the `claude` profile | Compatibility view of the `claude` profile. Changing it changes the profile. |
| `permissionMode` | `inherit` / `default` / `acceptEdits` / `auto` / `bypassPermissions` | `inherit` | Permission mode for every agent. `inherit` leaves it to the person's own CLI settings. Claude Code receives it as its permission mode (`bypassPermissions` also sets `allowDangerouslySkipPermissions`). Codex maps it to an approval policy and sandbox (`permissions()` in `server/backends/codex/index.ts`). See [Permissions and questions](Permissions-and-Questions.md). |
| `autoEffort` | boolean | `true` | Agents start at low effort and raise it with tools when the work needs it: the lead by itself, the others with approval. Off: every agent runs at its tier's effort. See [Thinking effort](Thinking-Effort.md). |
| `leanSubagents` | boolean | `true` | Compatibility view: the `claude` profile's Sonnet and Haiku tiers skip the person's own MCP servers. |
| `leanOpus` | boolean | `true` | Compatibility view: the Opus tier skips them too. |
| `collapseReports` | boolean | `false` | Reports from agents are shown folded shut in a transcript until the person opens them. Display only. |
| `keepAwake` | boolean | `true` | Keep the computer from sleeping while any conversation has agents working (`App.keepAwake()`). Applies at once. |
| `maxRunMinutes` | integer 0–1440 | `0` (no limit) | The longest a sub-agent may stay live on one piece of work. |
| `defaultCwd` | absolute path for this system | the home folder | The folder a new conversation starts in. It is updated automatically when a conversation is started in a different folder. |
| `version` | `2` | `2` | Settings format. Not changeable. |

An **MCP server** (Model Context Protocol) is an add-on that gives an agent extra tools. Masthead provides its own one, `masthead`, which holds the team tools. A "lean" agent gets only that one.

The page sends changes as `{t:'settings', settings: <patch>}`. The server merges the patch over the current settings with `sanitizeSettings()`, the one place settings are checked: a malformed field keeps its current value. A built-in profile is reset with `{t:'reset_profile', id}`. The full validation table and the list of when each change takes effect are on [Team profiles and settings](Team-Profiles-and-Settings.md#validation-in-one-place).

## Environment variables

### Folders (`server/paths.ts`)

| Variable | Effect |
|---|---|
| `MASTHEAD_CONFIG_DIR` | The config folder (settings), used exactly as given. Wins over everything else. |
| `MASTHEAD_DATA_DIR` | The data folder (conversations, the secret, remote access), used exactly as given. Wins over everything else. |
| `XDG_CONFIG_HOME` | When set, the config folder is `$XDG_CONFIG_HOME/masthead`, on every platform. |
| `XDG_DATA_HOME` | When set, the data folder is `$XDG_DATA_HOME/masthead`, on every platform. |
| `APPDATA`, `LOCALAPPDATA` | Windows only: the base of the config and data folders. |

`masthead stop` reads the local secret from the data folder, so the data-folder variables must match the ones the server was started with. Main prints: "There is no local secret (…) for this data folder, so the Masthead on port N cannot be stopped from here. Use the data folder it was started with (MASTHEAD_DATA_DIR or XDG_DATA_HOME)."

### Server (`server/main.ts`)

| Variable | Effect |
|---|---|
| `MASTHEAD_PORT` | The port when no `--port` is given (parsed in `server/cli.ts`); the default is 7717. See [Command-line launcher](Command-Line-Launcher.md). |
| `MASTHEAD_DEV` | `1` adds the Vite development page (`http://localhost:<port>` and `http://127.0.0.1:<port>`) to the accepted origins (`extraOrigins`), and prints its sign-in address. See [Security model](Security-Model.md). |
| `MASTHEAD_DEV_WEB_PORT` | The port of that Vite page; the default is 7718. An invalid value stops the server with "Invalid MASTHEAD_DEV_WEB_PORT…". |

### Backends (documented on their own pages)

| Variable | Page |
|---|---|
| `MASTHEAD_CLAUDE`: path to the `claude` program, tried before `PATH` | [Claude backend](Source-Backend-Claude.md) |
| `MASTHEAD_CODEX`: path to the `codex` program, tried before `PATH` | [Codex backend](Source-Backend-Codex.md) |
| `MASTHEAD_BACKEND=fake` with `MASTHEAD_ALLOW_FAKE=1` (and `MASTHEAD_FAKE_STEP_MS`): the scripted test backend, for tests only | [Fake backend](Source-Backend-Fake.md) |

`PATH` is searched for both CLIs. The environment the agents themselves receive is described on [Claude backend](Source-Backend-Claude.md).

Not verified by running: this page was written from the code.

## Related pages

[Team profiles and settings](Team-Profiles-and-Settings.md) · [Settings code](Source-Settings.md) · [Storage on disk](Storage-on-Disk.md) · [Command-line launcher](Command-Line-Launcher.md) · [Building, testing and installing](Building-Testing-Installing.md)
