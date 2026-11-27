# server/config.ts

**Role:** fixed paths, the default and validated settings, safe file writing, finding Claude Code, and the environment given to Claude Code processes. It has no classes; everything in it is a constant or a function. The view for people using Masthead is [Configuration and settings](Configuration-and-Settings.md).

## Constants

| Name | Value |
|---|---|
| `DEFAULT_PORT` | `7717` |
| `HOME` | the home folder (`os.homedir()`) |
| `CONFIG_DIR` | `$XDG_CONFIG_HOME/masthead`, default `~/.config/masthead` |
| `DATA_DIR` | `$XDG_DATA_HOME/masthead`, default `~/.local/share/masthead`. `main.ts` also passes it to `signInDir()` ([server/cli.ts](Source-Cli.md#signindirenv-datadir)): sign-in files go in `DATA_DIR/open` when `XDG_RUNTIME_DIR` is not set. |
| `SETTINGS_FILE` | `CONFIG_DIR/settings.json` |
| `CONVERSATIONS_DIR` | `DATA_DIR/conversations` |
| `SECRET_FILE` | `DATA_DIR/secret`, the local secret (see `loadSecret()`) |
| `SESSION_VARS` (private) | the environment variables removed from agents' environment; see `agentEnv()` |

The paths are computed once, when the module loads. The tests use this: they set their own `XDG_*` folders, or pass their own `Store` root and settings file.

## Functions

### `defaultSettings(): Settings`

Returns a new default settings object each time it is called, so callers can change it safely. The defaults:

- the four models;
- the effort ceilings;
- the per-tier limits;
- `permissionMode: 'inherit'`, `autoEffort: true`, `leanSubagents: true`, `leanOpus: true`, `collapseReports: false`;
- `defaultCwd: HOME`.

### `sanitizeSettings(raw, base = defaultSettings()): Settings`

Builds valid settings from any input. It starts from a copy of `base` (`structuredClone`) and copies over only the fields of `raw` that pass their check, so a field that is missing or malformed keeps its value from `base`. `App` passes the current settings as `base` when a browser sends settings, so a partial update changes only the fields it names; `loadSettings()` uses the defaults. The checks:

- `model`: matches a strict pattern;
- `effort`: one of the known levels;
- `max`: a whole number clamped to 0–12, for every tier except the lead (uses the private helper `clampInt()`);
- `permissionMode`: one of the known modes;
- `autoEffort`, `leanSubagents`, `leanOpus`, `collapseReports`: booleans;
- `defaultCwd`: an absolute path.

Unknown fields are dropped. It never throws. `test/unit.test.ts` checks that the defaults pass unchanged and that bad values (including `effort: 'max'`) fall back; `test/app.test.ts` checks that a partial update from a browser changes only what it names.

### `loadSettings(file = SETTINGS_FILE)` / `saveSettings(s, file = SETTINGS_FILE)`

`loadSettings()` reads the file and passes it through `sanitizeSettings()`. If the file is missing or is not JSON, it returns the defaults. `saveSettings()` writes the file indented, using `writeFileAtomic`.

Both take the file path as a parameter so that `App` can be given a different file (`settingsFile` option). The tests use this so they never write the real settings.

### `writeFileAtomic(path, data)`

1. Creates the parent folder with mode `0700` (only the owner can enter it). This applies when the folder is created; an existing folder keeps its mode.
2. Writes `<path>.<pid>.tmp` with mode `0600`.
3. Renames the temporary file over `path`.

A rename replaces the file in one step, so a crash never leaves half a file. `Store` also uses this function for `conversation.json`.

### `readSecret(file = SECRET_FILE)` / `loadSecret(file = SECRET_FILE)`

`readSecret()` returns the trimmed content of the file if it is exactly 64 lowercase hex characters, otherwise null (also when the file is missing). `masthead stop` uses it.

`loadSecret()` returns the secret, creating it when needed:

1. Creates the folder with mode `0700`.
2. If `readSecret()` finds a valid secret, sets the file back to `0600` if group or others have any permission on it, and returns it.
3. Otherwise writes 32 random bytes as hex to a temporary file (`<file>.<pid>.<random>.tmp`, mode `0600`). If a file exists but is not valid, the temporary file is renamed over it; if none exists, it is hard-linked into place, which fails with `EEXIST` if another process created it meanwhile (that error is ignored). The temporary file is then removed.
4. Reads the file back with `readSecret()` and returns that, so two processes starting together agree on one secret; throws if it is still not valid.

The secret is kept across restarts. The server and the `open` command call it (`secretOrExit()` in `server/main.ts`); see [Security model](Security-Model.md#4-the-local-secret).

### `findClaude(): ClaudeInfo`

Looks for the `claude` program in this order:

1. `$MASTHEAD_CLAUDE`;
2. each `PATH` folder;
3. `~/.local/bin`;
4. `~/.claude/local`;
5. `/usr/local/bin`;
6. `/usr/bin`.

It runs the first one it finds with `--version` (15-second timeout, using `agentEnv()`) and returns `{ path, version }`, or an `error` message. This runs synchronously when `App` is created, so start-up waits for it. The function's own comment says Masthead runs the person's Claude Code as it is and never touches its login.

### `agentEnv()`

The environment for each Claude Code process: a copy of the server's environment, minus:

- the variables in `SESSION_VARS`: `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, and the session-describing `CLAUDE_CODE_*` names `ENTRYPOINT`, `SESSION_ID`, `CHILD_SESSION`, `CHILD_NOTES_DIR`, `MESSAGING_SOCKET`, `MESSAGING_TOKEN`, `WORKER_EPOCH`, `SESSION_ATTENDED`, `ENVIRONMENT_KIND` and `EXECPATH`;
- any variable starting with `CLAUDE_CODE_BRIDGE_`.

It then adds `CLAUDE_AGENT_SDK_CLIENT_APP=masthead/<VERSION>`.

The removed variables are the ones a running Claude Code session sets about itself. Removing them means a Masthead server started from inside a Claude Code terminal still starts clean agents. Settings a person exports on purpose, and credentials such as `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, pass through unchanged (the comment above `SESSION_VARS`).

## Used by

- `server/app.ts`: settings functions, `SETTINGS_FILE`, `findClaude`, `HOME`;
- `server/agent.ts`: `agentEnv`;
- `server/store.ts`: `CONVERSATIONS_DIR`, `writeFileAtomic`;
- `server/main.ts`: `DEFAULT_PORT`, `SECRET_FILE`, `loadSecret`, `readSecret`;
- `server/cli.ts`: `DEFAULT_PORT`;
- the tests (see [Tests](Source-Tests.md)).

## Related pages

[Configuration and settings](Configuration-and-Settings.md) · [Storage on disk](Storage-on-Disk.md)
