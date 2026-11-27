# server/settings/settings.ts and server/paths.ts

**Role:** `server/paths.ts` decides where Masthead keeps its files. `server/settings/settings.ts` builds the default settings and checks every settings object that comes from the settings file or from a page. It also migrates a 0.1.x settings file and keeps the built-in team profiles. The concepts are explained on [Team profiles and settings](Team-Profiles-and-Settings.md). This page goes through the code.

`server/config.ts` from 0.1.x no longer exists. Its parts now live in `server/paths.ts` (folders), `server/settings/settings.ts` (settings), `server/storage/atomic.ts` (`writeFileAtomic`), `server/transport/auth.ts` (the local secret) and `server/backends/claude/env.ts` (finding Claude Code, the agents' environment).

## server/paths.ts

### Constants

| Name | Value |
|---|---|
| `DEFAULT_PORT` | `7717` |
| `HOME` | `os.homedir()` |
| `CONFIG_DIR` | `appDirs(process.platform, process.env, HOME).config`, worked out once when the module loads |
| `DATA_DIR` | `appDirs(...).data` |
| `SETTINGS_FILE` | `<CONFIG_DIR>/settings.json` |
| `CONVERSATIONS_DIR` | `<DATA_DIR>/conversations` |
| `SECRET_FILE` | `<DATA_DIR>/secret`, the local server's secret (see [Security model](Security-Model.md)) |

### `appDirs(platform, env, home)`

Returns `{ config, data }`. It is a pure function, so tests can try each platform. Rules, in order:

1. The platform default:
   - Linux and other systems: `~/.config/masthead` and `~/.local/share/masthead`, the same XDG folders 0.1.x used.
   - macOS (`darwin`): `~/Library/Application Support/Masthead` for both.
   - Windows (`win32`): `%APPDATA%\Masthead` for config and `%LOCALAPPDATA%\Masthead` for data. Without those variables it uses `<home>\AppData\Roaming` and `<home>\AppData\Local`. Windows path rules (`path.win32`) apply.
2. `XDG_CONFIG_HOME` / `XDG_DATA_HOME`, when set, replace the base folder on **every** platform (`<XDG_…>/masthead`).
3. `MASTHEAD_CONFIG_DIR` / `MASTHEAD_DATA_DIR`, when set, are used exactly as given and win over everything else.

The macOS and Windows locations are new in 0.2.0. No earlier install existed there, so nothing has to move.

## server/settings/settings.ts

The module-level patterns used for validation:

- `MODEL_ID` = `/^[A-Za-z0-9._\-\[\]:]{1,80}$/`
- `PROFILE_ID` = `/^[a-z0-9][a-z0-9-]{0,30}$/`
- `BACKEND_ID` = `/^[a-z0-9][a-z0-9-]{0,30}$/`

### `claudeProfile()`

Returns a new copy of the built-in Claude team profile: id `claude` (`CLAUDE_PROFILE`), label "Claude", `builtIn: true`, and four tiers whose ids are the 0.1.x tier names:

| id | model | effort | max | lean | colour |
|---|---|---|---|---|---|
| `lead` | `claude-fable-5-2` | `xhigh` | 1 | false | amber |
| `opus` | `claude-opus-5-5` | `xhigh` | 3 | true | violet |
| `sonnet` | `claude-sonnet-5-5` | `high` | 4 | true | blue |
| `haiku` | `claude-haiku-5-5` | `medium` | 4 | true | teal |

Every tier has `backend: 'claude-code'` and a label from `modelLabel(model)` ("Opus 5.5" and so on).

### `defaultSettings()`

The settings used when no file exists or it cannot be read: `version: 2`, `profiles: [claudeProfile()]`, `defaultProfile: 'claude'`, `permissionMode: 'inherit'`, `autoEffort: true`, `leanSubagents: true`, `leanOpus: true`, `collapseReports: false`, `maxRunMinutes: 0`, `keepAwake: true`, `autoCompact: true`, `defaultCwd: HOME`. The function passes the result through `withCompat()`, which fills in `tiers`.

### `clampInt(v, lo, hi, fallback)` (internal)

A number is truncated and clamped to `lo..hi`. Anything else gives `fallback`.

### `absoluteFolder(p, paths = path)`

A type guard: `p` is a non-empty string of at most 4096 characters, and `paths.isAbsolute(p)` is true. It uses the platform's own path rules, so `C:\x` passes on Windows and `/x` passes elsewhere. Tests pass `path.win32` or `path.posix` as `paths`. Used for `defaultCwd`.

### `claude(s)` (internal)

The `claude` profile of `s`. Callers make sure it exists.

### `withCompat(s)` (internal)

Rebuilds the compatibility fields from the claude profile and returns `s`, which it changes in place:

- `tiers`: for each of `lead`, `opus`, `sonnet`, `haiku`, the tier's `{ model, effort, max }`;
- `leanSubagents`: `sonnet.lean && haiku.lean`;
- `leanOpus`: `opus.lean`.

Every function that returns settings ends with this call, so the compatibility view always matches the profile.

### `parseTier(raw, base, first)` (internal)

One tier from untrusted input, laid over a copy of `base`. The caller fixes the tier's id and position. Each field is taken only if it is valid:

- `model` must match `MODEL_ID`. If the label was the default one made from the old model, the label follows the new model.
- `label`: a non-empty string after trimming, cut to 40 characters.
- `backend` must match `BACKEND_ID`. This checks the form only. Whether the backend exists is decided at run time ([Backend interface](Backend-Interface.md)).
- `effort`: one of `low`, `medium`, `high`, `xhigh`.
- `max`: `clampInt` to 0–12 (`MAX_PER_TIER`). This is **never** taken for the first tier.
- `lean`: a boolean.
- `colour`: one of `PALETTE`.

Input that is not an object returns `base` unchanged.

### `parseProfiles(raw, prev)` (internal)

The profile list from untrusted input. `prev` is the current list.

- An item is dropped if it is not an object, if its `id` does not match `PROFILE_ID`, or if its id was already seen.
- The `claude` profile always keeps its four tiers and their ids. Only their settings can change: `parseTier(tiersIn[i], base[i], i === 0)`. Here `base` is the previous claude profile, or `claudeProfile()` if there was none.
- Any other profile needs 1 to `MAX_TIERS` (5) tiers, or it is dropped. Tier `i` gets the id `<profile>:<i>` whatever the input says. A tier has no previous value when the profile is new or now has more tiers. Such a tier starts from: backend `claude-code`, no model, effort `medium`, max 1 for the first tier and 2 for the others, lean for every tier except the first, and colour `PALETTE[i % 8]`. An empty label becomes `modelLabel(model)`. A profile in which any tier ends up without a model is dropped.
- `label`: trimmed, at most 40 characters. If it is missing, the previous label is kept, or the id is used. `description`: whitespace collapsed, at most 200 characters, otherwise the previous one.
- `builtIn` is true for `claude` and for any profile that was built in before. Input cannot make a profile built-in.
- If `claude` is missing from the input, the previous one (or `claudeProfile()`) is put first.

### `applyCompat(d, r, trusted)` (internal)

Applies the 0.1.x shape (`tiers.<lead|opus|sonnet|haiku>` plus `leanSubagents` and `leanOpus`) to the claude profile of `d`. Every tier goes through `parseTier`, so the lead's `max` is never taken. With `trusted` (a whole settings object, whose view fields only repeat its own profile), the lead's `max` is removed before parsing. In that case the lean switches change only when they differ from what the profile already holds. Without `trusted`, any boolean given is applied. `leanSubagents` sets both `sonnet` and `haiku`.

### `sanitizeSettings(raw, base = defaultSettings())`

**The one place settings are validated.** It always returns valid settings. Anything missing, unknown or malformed keeps its value from `base`, so a partial patch changes only what it names. Steps:

1. Take a `structuredClone` of `base`. Set `version = 2`. Make sure a `claude` profile exists.
2. `applyCompat(d, base, true)`: if code changed `base.tiers` directly, that change wins over the profile.
3. If `raw` is not an object, return `withCompat(d)`.
4. If `raw.profiles` is an array, run `parseProfiles`, then `applyCompat(d, raw, true)`. A view field that differs from the new profile counts as a change. Otherwise run `applyCompat(d, raw, false)`. This branch is how a **0.1.x file** and a page that still sends `tiers` reach the claude profile.
5. `defaultProfile` is taken if it names an existing profile. If the current default no longer exists, it falls back to `claude`.
6. `permissionMode` must be one of `PERMISSION_CHOICES`. `autoEffort`, `collapseReports`, `keepAwake` and `autoCompact` must be booleans. A `keepAwake` or `autoCompact` that is still missing (a file or `base` made before the field existed) becomes `true`, so automatic tidying starts on for existing installs. See [Compact team](Compact-Team.md). `maxRunMinutes` is clamped to 0–1440. `defaultCwd` must pass `absoluteFolder`.
7. Return `withCompat(d)`.

### `loadSettings(file = SETTINGS_FILE)`

Reads and parses the file. If the parsed object has no `version` (a 0.1.x file), the function copies the file to `<file>.v1.bak`, once only (never if that backup exists), before anything can overwrite it. It then returns `sanitizeSettings(raw)` over the defaults, so the migration happens in memory. The file is written in the new format at the next save. Any error (no file, bad JSON, a failed copy) gives `defaultSettings()`.

### `saveSettings(s, file = SETTINGS_FILE)`

Writes `JSON.stringify(s, null, 2)` plus a newline with `writeFileAtomic` (see [Storage](Source-Storage.md#atomicts)). The file gets mode `0600`, and its folder is created with mode `0700`.

### `tierLimit(s, tier)`

The scheduler's limit for a tier id. The `Scheduler` in `App` is built with `(tier) => tierLimit(this.currentSettings, tier)`. It returns `Infinity` for the first tier of any profile (each conversation always has its lead), the tier's `max` for any other tier, and `0` for an id no profile has any more. A 0 means agents of that tier cannot start ([Scheduler](Source-Core-Scheduler.md)).

### `withBuiltInProfiles(s, generated)`

Adds generated built-in profiles that `s` does not hold yet. Today the only one is the Codex team that `codexProfile()` in `server/backends/registry.ts` builds from the installed Codex's model list. It returns `s` itself (the same object) when there is nothing to add. Otherwise it validates the result through `sanitizeSettings({ profiles: [...s.profiles, ...extra] }, s)` and marks the new profiles `builtIn`. A stored copy always wins, even one the person edited. `App.backendsDetected()` calls this function after backend detection and saves only if the object changed.

### `resetProfile(s, id, generated = [])`

Puts built-in profile `id` back to its defaults: `claude` from `claudeProfile()`, any other id from `generated`. It returns `s` unchanged when the profile is unknown or not built in, or when no fresh copy exists (for example, Codex is no longer detected). The fresh copy goes through `sanitizeSettings` with a base that lacks the old profile, so none of the old tier values carry over. `App` calls this function for the page's `{t:'reset_profile', id}` message, which `App` refuses with "Only a built-in team can be reset." for other profiles.

## Callers

- `server/app/app.ts`: `loadSettings` in the constructor, `sanitizeSettings(msg.settings, currentSettings)` for `{t:'settings'}`, `saveSettings` in `updateSettings()`, `tierLimit` for the scheduler, `withBuiltInProfiles` in `backendsDetected()`, and `resetProfile` for `reset_profile`.
- Tests: `test/settings.test.ts`.

Not verified by running: this page was written from the code. The tests were not run for it.

## Related pages

[Team profiles and settings](Team-Profiles-and-Settings.md) · [Configuration and settings](Configuration-and-Settings.md) · [Storage](Source-Storage.md) · [Storage on disk](Storage-on-Disk.md) · [shared/protocol.ts](Source-Shared-Protocol.md) · [Compact team](Compact-Team.md)
