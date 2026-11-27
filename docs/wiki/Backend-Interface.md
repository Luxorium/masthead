# Agent backends: the interface (0.2.0)

**Role:** from 0.2.0 Masthead's runtime does not talk to Claude Code directly. It talks to a **backend** through the types in `server/backends/types.ts`, and the backends in use are kept by `server/backends/registry.ts`. A backend knows nothing about teams: it opens sessions, takes messages and reports what happened as neutral events. It never builds protocol items or page text, and it does not decide when an agent's work is over.

Backends in 0.2.0:

| Id | Label | Code | Page |
|---|---|---|---|
| `claude-code` | Claude Code | `server/backends/claude/` | [Claude Code backend](Source-Backend-Claude.md) |
| `codex` | Codex | `server/backends/codex/` | not written yet |
| `fake` | Fake backend | `server/backends/fake/` | [Fake backend](Source-Backend-Fake.md) |

## `server/backends/types.ts`

### `Backend` (line 187)

| Member | Meaning |
|---|---|
| `id`, `label`, `caps` | Identity and capabilities (`BackendCaps`, below). |
| `detect()` | What is installed: a `BackendInfo`. |
| `models()` | The models this backend offers: `ModelInfo[]`. |
| `open(spec, events)` | Starts a `Session`. Must not throw for an ordinary failure: it reports `events.exited({ failure })` instead. |
| `dispose?()` | Optional: stops shared processes (for example one app-server per backend) when the app shuts down. |

`BackendId` is `'claude-code' | 'codex' | 'fake'` or any other string.

### `BackendInfo` (line 12)

What detection found. Never holds credentials.

| Field | Meaning |
|---|---|
| `id`, `label` | As on the backend. |
| `available` | It can be used. |
| `path`, `version` | The program found and its version, or `null`. |
| `signedIn` | `null` when it could not be told. |
| `minVersion?` | Lowest version Masthead supports, when there is one. |
| `error?` | Shown on the page when the backend cannot be used (missing, too old, signed out). |
| `warning?` | Usable, but worth saying, for example a version Masthead has not been tested with, or (set by the registry) models that could not be read. |

### `ModelInfo` (line 27)

| Field | Meaning |
|---|---|
| `id`, `label` | The model's id and display name. |
| `efforts` | Masthead levels the model supports. |
| `nativeEffort` | How each Masthead level maps to the backend's own setting. |
| `contextWindow?`, `default?` | Size of the context, and whether it is the backend's default. |
| `description?` | The backend's own one-line description, as it shows it. |
| `order?` | The backend's picker order, lower first. It says nothing about capability. |

### `BackendCaps` (line 42)

| Flag | Meaning |
|---|---|
| `efforts` | Levels that have any effect; `[]` means no effort control. |
| `liveEffort` | An effort change reaches a running session. |
| `liveModel` | `Session.setModel` exists. |
| `resume` | A session can be resumed by id. |
| `images` | Messages may carry images. |
| `interrupt` | A running turn can be interrupted. |
| `background` | Reports background commands. |
| `permissions` | `'callback'` (asks per tool call), `'mode-only'` (only a permission mode) or `'none'`. |
| `approvalsAlways` | "Always allow" rules can be offered. |
| `questions` | The agent can ask the person a question. |
| `consumedIds` | `false`: turn results do not name the messages they consumed, and the runtime uses its fallback rule. |
| `midTurnDelivery` | `false`: the runtime queues sends until `turnEnded` and sends them as one batch. |
| `contextUsage` | `Session.contextUsage()` works. |
| `lean` | Can skip the person's own MCP servers. |

### Capabilities per backend

Read from `CLAUDE_CAPS` (`server/backends/claude/session.ts` line 60), `CODEX_CAPS` (`server/backends/codex/index.ts` line 62) and `FAKE_CAPS` (`server/backends/fake/index.ts` line 21).

| Flag | claude-code | codex | fake |
|---|---|---|---|
| `efforts` | all (`EFFORTS`) | all (`EFFORTS`) | all (`EFFORTS`) |
| `liveEffort` | yes | **no** | yes |
| `liveModel` | yes | yes | yes |
| `resume` | yes | yes | yes |
| `images` | yes | yes | yes |
| `interrupt` | yes | yes | yes |
| `background` | yes | **no** | yes |
| `permissions` | `callback` | `callback` | `callback` |
| `approvalsAlways` | yes | yes | yes |
| `questions` | yes | yes | yes |
| `consumedIds` | yes | yes | yes |
| `midTurnDelivery` | yes | yes | yes |
| `contextUsage` | yes | yes | yes |
| `lean` | yes | yes | yes |

The fake's flags can be overridden per instance (`new FakeBackend({ caps })`), which is how tests exercise the `consumedIds: false` and `midTurnDelivery: false` paths.

### `SessionSpec` (line 79)

| Field | Meaning |
|---|---|
| `resume?` | Session id to resume. |
| `model`, `effort`, `cwd` | As named. |
| `instructions` | Masthead's system text for this agent. |
| `tools` | The team tools (`ToolDef[]`). |
| `canAskPerson` | `false` for every non-lead. |
| `permissionMode` | The backend's mode name. |
| `lean` | Skip the person's own MCP servers. |
| `env` | Extra environment variables. The adapter builds the process environment and adds or removes no credentials. |

### `ToolDef` (line 72)

One team tool, bound to the agent whose session it is given to: `run(input)` closes over that agent and returns the result text. `input` is a JSON Schema object (`JSONSchema = Record<string, unknown>`).

### `Content`, `TextPart`, `ImagePart` (lines 95-106)

`Content` is a string or an array of `TextPart` (`{ type: 'text', text }`) and `ImagePart` (`{ type: 'image', mediaType, data }`, with `data` base64 **without** the `data:` prefix). Images only if `caps.images`.

### `Session` (line 108)

| Member | Meaning |
|---|---|
| `send(id, content)` | Queues a message. `id` is the runtime's own and comes back in `turnEnded.consumed`. |
| `interrupt()` | Interrupts the running turn. |
| `setEffort(effort)` | May return a promise; a rejection means the change did not reach the session. |
| `setModel?(model)` | Present when `caps.liveModel`. |
| `close(how)` | `'graceful'`: end the input and let the backend finish. `'now'`: end the process at once. |
| `contextUsage?()` | `{ used, max }`. |
| `ended` | Settles once the backend process behind the session has fully stopped (after close or exit). |

### `SessionEvents` (line 141)

| Event | Semantics |
|---|---|
| `sessionStarted(id)` | The backend's session id, for resuming later. |
| `turnStarted()` | A turn began (Claude: `system`/`init` or the first stream event). The Claude adapter sends it again for every stream event and assistant message, so it can repeat within a turn. |
| `text(final, isError?)` | A final text block; `isError` when the backend marks it as an error message. |
| `thinking(text)` | A final thinking block. |
| `draft(d)` | Streaming text. `{ kind, append: '' }` **starts a new block** of that kind; `{ kind, append: 'x' }` adds to it; `null` ends the draft. |
| `toolStarted({ id, name, input })`, `toolFinished({ id, result, isError, images? })` | A tool call and its result; `images` are `ImagePart`s from the result. |
| `turnEnded(r)` | A `TurnResult` (below). |
| `rateLimit(n)` | A `RateLimitNotice`; `resetsAt` in **seconds** since the epoch, as the backends report it. |
| `background(activeIds)` | The full set of running background tasks: it **replaces** the previous set. |
| `usage(u)` | `UsageUpdate`: `context` is the current size (absolute), `output` is tokens added since the last update (an increment), `costUsd` is this session's total so far. |
| `exited({ failure?, sessionMissing?, apiError? })` | The process ended without being asked to, or a start failed. **Never sent after `Session.close()`.** `sessionMissing` when a resume found no session; `apiError` as in `TurnResult` when the running turn had one. |
| `askPermission(ask)` | Returns a promise of a `PermissionAnswer`. |
| `compacted?()` | Optional: earlier context was summarized. |
| `activity?(text)` | Optional: a backend-specific state worth showing (for example compacting); `undefined` clears it. |

`TurnResult` (line 129): `consumed` is the ids of the runtime's messages this turn consumed. **`null`** means the backend cannot tell (the runtime then counts everything sent as answered); **`[]`** means none, a turn the backend started by itself. `text` is the turn's final text, `error?` a failure, `apiError?` how the backend classed an API error (for example `'rate_limit'`; the runtime decides what a usage limit is), `interrupted` whether it was interrupted.

### `PermissionAsk` and `PermissionAnswer` (lines 170, 181)

`PermissionAsk`: `kind` (`'command' | 'file' | 'tool' | 'question'`), `toolName`, `input`, optional `title` and `description`, `canAlways` (an "always allow" can be offered), `questions?` (for `kind: 'question'`), and `signal`, an `AbortSignal` that fires when the backend withdraws the request.

`PermissionAnswer`: `decision` (`'allow' | 'always' | 'deny'`), `answers?` (question text to answer) and `message?` (sent back with a denial).

## `server/backends/registry.ts`

`BackendStatus` (line 16) is `BackendInfo & { models: ModelInfo[] }`: what the page learns about one backend.

### `class BackendRegistry` (line 28)

| Member | Behaviour |
|---|---|
| constructor (line 34) | With `MASTHEAD_BACKEND=fake` but no `MASTHEAD_ALLOW_FAKE=1` it **throws** ("for tests only"). With both, it holds only a `FakeBackend` (step time from `MASTHEAD_FAKE_STEP_MS`, default 20 ms here) and returns. Otherwise it holds `ClaudeBackend` (from the `ClaudeInfo` found at start-up) and, unless `codex: false`, `CodexBackend`. Before detection, Claude Code's status is as found at start-up (`signedIn: null`, no models) and Codex has no status at all. |
| `fake` | The `FakeBackend` when selected, else `null`. |
| `detectAll()` (line 62) | Runs every backend's `detect()` in parallel, then `models()` for the available ones. Never throws: a failing `detect()` becomes `available: false` with its message as `error`; a failing `models()` keeps it available with a `warning` ("Its models could not be read: …"). Returns `status()`. |
| `status()` (line 85) | Copies of every status, models included. |
| `get(id)` (line 90) | The fake for **any** id when it is selected. Otherwise `undefined` when the status says `available: false`, else the backend (also for a backend not yet detected). |
| `unavailableReason(id)` (line 97) | "There is no agent backend called …" for an unknown id; else the status's `error`, or "<label> cannot be used right now." |
| `generatedProfiles()` (line 104) | `[codexProfile(models)]` when Codex is detected and available; `[]` with the fake or without Codex. |
| `dispose()` (line 111) | Calls every backend's `dispose?()`, ignoring failures. `App.shutdown()` calls it. |

### When detection runs

- **At start-up, only for a real start**: the `App` constructor (`server/app/app.ts` line 86) calls `detectAll()` and then `backendsDetected()` only when neither `claude` nor `registry` was passed in. Tests decide themselves when to detect.
- **On demand**: the page's `check_backends` message (`server/app/app.ts` line 371) runs `detectAll()`, then `backendsDetected()`, then broadcasts `{ t: 'backends', backends }`.

`backendsDetected()` merges `generatedProfiles()` into the settings with `withBuiltInProfiles()`.

### How the page learns about backends

A version 2 page gets `backends: BackendStatus[]` in its `state` (`server/app/app.ts` line 275, only when `hub.isV2(client)`; version 1 pages do not), and a `{ t: 'backends', backends }` message after each `check_backends`. The page keeps both in `store.backends` (`web/src/lib/store.svelte.ts`). Neither the `backends` field, the `backends` message nor `check_backends` is declared in `shared/protocol-v2.ts`: the state there is `Record<string, unknown>`, and the server casts the message.

### `codexProfile(models)` and `server/backends/codex/families.ts`

`codexProfile` (registry line 135) builds the built-in **Codex** team profile from the installed Codex's model list. `codexTeamModels()` (families line 32) orders the models:

1. `parseCodexModel(id)` (families line 12) reads ids shaped `<word>-<version>-<family>`, e.g. `gpt-6.2-astra` → family `astra`, version `[6, 2]`. An id of another shape counts as its own family.
2. For each family only the **newest version** is kept (versions compared number by number).
3. Known families come first, in `CODEX_FAMILY_ORDER` (families line 9): **astra > sol > terra > luna**. This table is data: Codex's own catalogue has no capability rank.
4. Unknown families follow in catalogue order (`order`, else list position).

The profile takes the first **four** at most (one tier if only one model). Tier ids are `codex:0`, `codex:1`, …, `backend: 'codex'`, label = model label, colour from `PALETTE` in turn. Per tier (`TIER_SHAPE`, registry line 116):

| Tier | Wanted effort | max | lean |
|---|---|---|---|
| `codex:0` (lead) | xhigh | 1 | no |
| `codex:1` | xhigh | 3 | yes |
| `codex:2` | high | 4 | yes |
| `codex:3` | medium | 4 | yes |

`effortFor()` caps the wanted effort to the highest level the model supports that is not above it (or the model's first level). The profile is `{ id: 'codex', label: 'Codex', builtIn: true, description: "Built from the installed Codex's model list. Change it in the settings." }`.

## `server/backends/proctree.ts`

Stopping a CLI must also stop the commands it started. Ending only the CLI leaves its children behind on Windows (no process groups), and on POSIX a child that ignores its parent's end keeps running.

| Function | Behaviour |
|---|---|
| `spawnTree(command, args, options, deps)` (line 37) | Spawns with `windowsHide: true`; on POSIX also `detached: true`, so the CLI gets its own process group. |
| `killTree(child, deps, graceMs)` (line 45) | Does **nothing** if the child has no pid or has already exited (`exitCode` or `signalCode` set). POSIX: `SIGTERM` to the group (`kill(-pid)`), then `SIGKILL` to the group after `KILL_GRACE_MS` = **3 s** if it has still not exited; if signalling the group fails, the child itself is signalled. Windows: `taskkill /T /F /PID <pid>`; if that fails and the child is still running, `child.kill()`. |

`TreeDeps` (line 13) holds `platform`, `spawn`, `kill`, `execFile` and `setTimeout`, so tests inject them; `realTreeDeps` uses Node's (its timer is `unref`'d). Used by the Claude adapter through the SDK's `spawnClaudeCodeProcess` option ([Claude Code backend](Source-Backend-Claude.md)) and by Codex's `server/backends/codex/cli.ts` (line 57).

**Verification:** on Linux by unit tests (`test/proctree.test.ts`, `test/codex-proctree.test.ts`) and the Claude live run. The Windows path is checked only by a unit test with injected dependencies; it has **not been run on Windows** and needs a manual Windows check on the release checklist.

## Points to be aware of

- `ClaudeBackend.detect()` does not detect anything itself in 0.2.0: it returns what `findClaude()` found at start-up, and `models()` returns `[]`. So `check_backends` cannot notice a Claude Code installed or updated after start-up, and Claude Code has no model list.
- A Claude Code that was found but whose `--version` failed has a `path` **and** an `error`; it still counts as `available`.
- `get()` returns a backend that has not been detected yet (Codex before `detectAll()` finishes).
- With the fake selected the registry's status has `models: []` until `detectAll()` runs, and `get()` hands out the fake whatever id is asked for.
- Two defaults for the fake's step time: 20 ms through the registry, 0 ms for `new FakeBackend()` in unit tests.

## Tests

`test/registry.test.ts`: Codex team order; the fake needs the allow flag and stands in for every backend; detection reads Codex models and builds its team; a conversation on the generated Codex team on a fake app-server. `test/proctree.test.ts`: POSIX group and grace time, nothing after exit, Windows `taskkill`, the Claude adapter's use. `test/backend-conformance.ts`: the shared conformance suite.

## Related pages

[Claude Code backend](Source-Backend-Claude.md) · [Fake backend](Source-Backend-Fake.md) · [server/app.ts](Source-App.md) · [Agent life cycle](Agent-Life-Cycle.md)
