# server/backends/claude/ (0.2.0)

**Role:** the Claude Code backend. One Agent SDK `query()` per session, driven in streaming-input mode, with its messages translated into the neutral events of [the backend interface](Backend-Interface.md). It decides nothing about when an agent's work is over; it only reports. The behaviour is carried over from 0.1.4's `server/agent.ts`.

| File | Contents |
|---|---|
| `session.ts` | `ClaudeBackend`, `ClaudeSession`, `Channel`, `DISALLOWED`, `MISSING_SESSION`, `CLAUDE_CAPS`, `toolResultText` |
| `mcp.ts` | The in-process MCP server holding the team tools |
| `env.ts` | Finding Claude Code (`findClaude`) and the environment it runs in (`agentEnv`) |

## `session.ts`

### `Channel<T>` (line 24)

An async queue used as the session's input stream. `push()` adds an item (ignored once closed), `close()` ends the stream after the items already queued.

### `ClaudeBackend` (line 108)

`id = 'claude-code'`, `label = 'Claude Code'`, `caps = CLAUDE_CAPS` (line 60; table on [the interface page](Backend-Interface.md#capabilities-per-backend)). Options: `path`, `version`, `error` as found by `findClaude()`, and for tests `treeDeps` and `query`.

- `detect()` looks for Claude Code again (path search and `--version`, through `findClaude`) each time on a real start, so "Check again" finds a Claude Code installed later; tests that hand in a fixed `claude` get what they gave. `available` needs a path and no error (a binary whose `--version` fails is not usable). `signedIn: null`.
- `models()` returns `[]` (the comment says it is to be filled from `Query.supportedModels()` later).
- `open()` returns a `ClaudeSession`.

### `ClaudeSession` (line 138)

The constructor calls `query({ prompt: channel, options })`. If that throws, `ended` resolves at once and `exited({ failure })` is sent in a microtask. Otherwise `ended` is the promise of `consume()`, which reads every SDK message.

#### Options (`options()`, line 172)

| SDK option | Value |
|---|---|
| `model`, `effort`, `cwd` | From the spec. |
| `env` | `{ ...agentEnv(), ...spec.env }`. |
| `pathToClaudeCodeExecutable` | The path found, if any. |
| `mcpServers` | `{ masthead: mcpServer(spec.tools) }`. |
| `mcpServersDelivery` | `'argv'`. The option only affects servers Claude Code runs or connects to; in-process servers are not affected (`sdk.d.ts`). Leaving it unset makes the SDK print a deprecation warning when Claude Code is started through `pathToClaudeCodeExecutable` or `spawnClaudeCodeProcess`; `'initialize'` needs a Claude Code at least as new as the SDK's bundled one. |
| `allowedTools` | `['mcp__masthead']`. |
| `disallowedTools` | `DISALLOWED`, plus `AskUserQuestion` when `canAskPerson` is false (every non-lead). |
| `includePartialMessages` | `true` (needed for drafts and usage). |
| `thinking` | `{ type: 'adaptive', display: 'summarized' }`. |
| `strictMcpConfig` | `spec.lean`: lean agents load only Masthead's own tools, not the person's MCP servers. |
| `systemPrompt` | The `claude_code` preset with `spec.instructions` appended. |
| `canUseTool`, `stderr`, `spawnClaudeCodeProcess` | The session's own handlers (below). |
| `resume` | When the spec has one. |
| `permissionMode` | Unless the spec says `'inherit'`; `bypassPermissions` also sets `allowDangerouslySkipPermissions`. |

`DISALLOWED` (line 51): `Agent`, `Task`, `Workflow`, `SendMessage`, `ListAgents`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`, `SendToProject`, `SendToProjectContext`, `PushNotification`: tools that would bypass Masthead's team or start work later or elsewhere, or that it has no screen for.

#### Starting the process (`spawnProcess`, line 209)

Through `spawnClaudeCodeProcess` Masthead starts Claude Code itself with `spawnTree()` from [proctree.ts](Backend-Interface.md#serverbackendsproctreets), so a stop ends the commands it started too. Because a custom spawner gets no stderr handling from the SDK, stderr is read here into `stderrTail` (last 4,000 characters; the missing-session check needs it). The SDK's `kill()` and its abort signal (sent after its own graceful-close window) both call `killTree()`.

#### Permissions (`canUseTool`, line 239)

| Direction | Rule |
|---|---|
| Masthead's tools | Any tool starting `mcp__masthead__` is allowed without asking: the conversation checks those. |
| SDK → `PermissionAsk` | `kind`: `question` for `AskUserQuestion`, `command` for `Bash`, `file` for `Edit`, `Write`, `NotebookEdit`, else `tool`. `title` from the SDK; `description` is the SDK's `description`, else its `decisionReason`. `canAlways` when it is not a question and the SDK gave `suggestions`. `questions` from the input for a question. `signal` is the SDK's. |
| `PermissionAnswer` → SDK | `deny` → `{ behavior: 'deny', message }` (default "The person declined this."). A question with `answers` → allow with `answers` added to the input. `always` with suggestions → allow with `updatedPermissions: suggestions`. Otherwise allow with the input unchanged. |

#### Methods

| Method | Behaviour |
|---|---|
| `send(id, content)` | Pushes a user message with `uuid: id`; images become base64 image blocks. |
| `interrupt()` | `q.interrupt()`; marks the turn interrupted (unmarked if the call fails). |
| `setEffort(e)` | `q.applyFlagSettings({ effortLevel: e })`. |
| `setModel(m)` | `q.setModel(m)`; rejects with "no process" when there is none. |
| `close('graceful')` | Closes the input channel. |
| `close('now')` | `q.close()`. Both set `closeRequested`, so no `exited` follows. |
| `contextUsage()` | `q.getContextUsage()` → `{ used: totalTokens, max: maxTokens }`. |

#### Message translation (`handle`, line 317; `stream`, line 418)

| SDK message | Neutral events |
|---|---|
| `system` / `init` | `turnStarted()`, then `sessionStarted(session_id)`. Every turn starts with `init`, also turns Claude Code starts by itself. Marks `sawInit`. |
| `system` / `status` with `compacting` | `activity('Compacting its context')`. |
| `system` / `background_tasks_changed` | `background(ids of the tasks that are not ambient)`. |
| `system` / `compact_boundary` | `compacted()`. |
| `stream_event` | `turnStarted()`, then by event: `message_start` with usage → `usage({ context })` where context = input + cache read + cache creation tokens; `message_delta` with `output_tokens` → context grows by it, `usage({ context, output })`; `content_block_start` of text or thinking → `draft({ kind, append: '' })`; `text_delta` / `thinking_delta` → `draft({ kind, append })`. |
| `assistant` | `draft(null)`, `turnStarted()`. Each non-blank text block → `text(text, isError)` (error when the message has `error`); each non-blank thinking block → `thinking()`; each `tool_use` → `toolStarted()`. An `error` is kept as the turn's `apiError` and error text (`<error>: <last text>`). |
| `user` | Each `tool_result` → `toolFinished({ id, result, isError, images? })`. `result` is `toolResultText()` (text blocks, `[image]`, `[tool loaded: name]`, `[type]`); base64 image blocks in the result become `images`. |
| `rate_limit_event` | See below. |
| `result` | `turnEnded()` (see below), after `usage({ costUsd: total_cost_usd })`. |

#### End of a turn (`result`, line 441)

- **Consumed ids:** `user_message_uuids`, else the single `user_message_uuid`. When neither is present: `[]` if this process has already shown it names consumed messages (`namesConsumed`, set by a named result or by an `assistant` message with `user_message_uuid`), else `null`.
- **Error:** for a non-success subtype (and not interrupted): the `errors` strings without those starting `[ede_diagnostic]`, joined with `; `, else the assistant error text, else the subtype with `_` as spaces. For `is_error` on a success: the result text, else "The turn ended with an error.".
- **Text:** the result string, else the last text block.
- **apiError:** the assistant message's `error` from this turn.

#### Missing session

`MISSING_SESSION` (line 57) is `/No conversation found with session ID/`. A `result` that arrives on a resume **before `init`** and names it is set aside rather than reported as a turn. When the process ends (`consume`, line 300) without `close()`, `exited` gets `sessionMissing: true` only if the spec was a resume, no `init` was seen, and the set-aside result, the thrown failure or `stderrTail` names the missing session. Otherwise `exited({ failure, apiError })`.

#### Rate limits (line 377)

If `rate_limit_info.unifiedWindows` is present (it is not in the SDK's types, so it is read defensively), one `rateLimit()` per window: its own `status`, `utilization` and `resetsAt`, falling back to the event's figures for the window of the event's `rateLimitType`. Otherwise one notice from the event's own figures. `resetsAt` is passed on in **seconds**.

## `mcp.ts`

`MCP_NAME = 'masthead'`; the model sees the tools as `mcp__masthead__<name>`. `mcpServer(defs)` (line 52) builds one in-process server with `createSdkMcpServer` (`alwaysLoad: true`). A tool's result is returned as text, with `isError` when the text starts with `Error:`.

The SDK helper takes zod shapes, so `zodShape()` (line 39) turns the top-level `properties` of a `ToolDef`'s JSON Schema back into zod. Supported subset (`zodFor`, line 14):

| JSON Schema | zod |
|---|---|
| `enum` of strings (checked first) | `z.enum` |
| `string` with `minLength` / `maxLength` | `z.string().min().max()` |
| `number`, `integer` with `minimum` / `maximum` | `z.number()` (`.int()` for integer) `.min().max()` |
| `boolean` | `z.boolean()` |
| anything else (arrays, objects, enums of non-strings) | `z.any()` |

A property's `description` is kept; properties not in `required` become optional.

## `env.ts`

| Function | Behaviour |
|---|---|
| `claudeCandidates()` (line 51) | Where Claude Code may be, in order: `$MASTHEAD_CLAUDE`, each absolute `PATH` folder, then installer folders: `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, `~/.bun/bin`, `/opt/homebrew/bin` (macOS), `/usr/local/bin`, `/usr/bin`; on Windows `~\.local\bin` and `%APPDATA%\npm`, with each `PATHEXT` extension (`.exe` first). |
| `resolveShim()` (line 78) | Reads the real target (`.exe`, `.js`, `.cjs`, `.mjs`) out of an npm `.cmd`/`.bat` shim, since the SDK starts Claude Code without a shell. |
| `locateClaude()` (line 84) | The first candidate that exists and can run without a shell. |
| `findClaude()` (line 105) | Locates it and runs `--version` (a `.js` entry with this Node; 15 s timeout). Not found → error "Claude Code was not found. Install it and sign in with `claude`, then restart Masthead."; `--version` fails → path kept, `version: null`, error "Could not run …". |
| `agentEnv()` (line 125) | `process.env` without the variables a running Claude Code session sets about itself (`SESSION_VARS`, line 8: `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, …) and any `CLAUDE_CODE_BRIDGE_*`, compared in upper case on Windows; adds `CLAUDE_AGENT_SDK_CLIENT_APP=masthead/<version>`. Credentials pass through untouched. |

## Observed with a real Claude Code 2.1.331

Recorded on [Agent life cycle](Agent-Life-Cycle.md) and [the agent](Source-Runtime.md), checked on 2026-11-27 (Haiku):

- **Background work:** the turn's result, then task updates, an empty `background_tasks_changed` and an `init`, then the self-started turn's result. A task stopped with `Query.stopTask()` gave an empty `background_tasks_changed` and no new turn.
- **Missing session:** after the session file was deleted, the resume wrote an `error_during_execution` result "No conversation found with session ID: …" before any `init`.
- **`setModel` mid-conversation:** the next turn's `init` and assistant message named the new model, in the same process.
- **Relaunch after the automatic-effort switch:** a new process resumed the same session with the changed tool list.
- **`applyFlagSettings` sent mid-turn:** applies from the next request of the same turn.
- **Rate limits:** a real event carried `utilization` as a fraction (0.33) and `resetsAt` in seconds since the epoch. A reached limit (status `rejected`) has not been seen for real.

These checks were made before or alongside the move into `server/backends/claude/`; this page's author did not run them again.

## Points to be aware of

- `models()` is empty: the Claude tiers still name their models in the settings.
- `turnStarted()` is sent on every stream event and every assistant message, not once per turn.
- A turn's `text` events can repeat what `turnEnded.text` carries; `turnEnded.text` prefers the result string.
- `exited` carries the `apiError` of the last assistant error only if no `result` cleared it first.
- `namesConsumed` is per process: a new process starts with `null` for unnamed results until it names one.
- `unifiedWindows` is outside the SDK's types and could change with any Claude Code release.

## Tests

`test/proctree.test.ts` checks that Claude Code is started through the tree spawner, that the SDK's kill ends the tree, and that stderr still reaches the missing-session check. The agent behaviour above is covered by `test/agent.test.ts` (which drives `ClaudeBackend` through `server/runtime/agent.ts` with a fake `query`) and `npm run test:live` (neither run for this page).

## Related pages

[Backend interface](Backend-Interface.md) · [Fake backend](Source-Backend-Fake.md) · [Agent life cycle](Agent-Life-Cycle.md) · [the agent](Source-Runtime.md)
