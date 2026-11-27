# server/runtime/agent.ts

**Role:** one member of the team, on whichever backend it runs. An `Agent` owns one backend session at a time (see [Backend interface](Backend-Interface.md)), feeds it messages under ids of its own, and turns the session's neutral events into the app's view of the agent: transcript items, a live draft, a status, usage numbers and an activity line. It decides no team policy: it reports to its host (the `Conversation` in `server/core/conversation.ts`), and the core state machine (`server/core/machine.ts`) decides what an ended turn means. Nothing in this file is specific to Claude Code except the test seam `AgentHost.query` (below); the Claude Code side is in `server/backends/claude/session.ts` ([Claude Code backend](Source-Backend-Claude.md)).

In 0.1.4 a single file, `server/agent.ts`, held both the Claude Code session and this bookkeeping (`git show v0.1.4:server/agent.ts`). The rules below were carried over; the table [Every rule kept from 0.1.x](#every-rule-kept-from-01x-and-where-it-lives-now) says where each one lives now. How an agent moves through its life is on [Agent life cycle](Agent-Life-Cycle.md); statuses and holds are on [State machine](State-Machine.md).

## Types

### `AgentHost` (line 25)

What an agent needs from the conversation that owns it. `Conversation` implements it (the `// ---- AgentHost ----` section of `server/core/conversation.ts`).

| Member | Purpose | What `Conversation` does |
|---|---|---|
| `cwd` | Folder the agent works in. | The conversation's folder (`meta.cwd`). |
| `scheduler` | The shared slot scheduler ([Slot scheduling](Slot-Scheduling.md)). | The app's. |
| `settings()` | Current settings. | The app's. |
| `claudePath()` | Path to `claude`, or null. Used only to build the test-seam backend (`query`, below). | The app's. |
| `parentName(agent)` | For the system prompt. | The parent's name, or null for the lead. |
| `tools(agent)` | The team tools as neutral `ToolDef`s, bound to this agent. Built once per process, at launch. | `teamToolDefs(agent, this)`. |
| `agentChanged(agent)` | Something on `agent.info` changed. | Feeds a `Status` event to the machine when the runtime's status differs from the machine's phase, forgets messages it held for a non-live agent, passes it up. |
| `itemChanged(agent, item)`, `draftChanged(agent, draft)`, `rateLimit(notice)` | Change notifications. | Passed up to the app. |
| `askPermission(agent, ask)` | An approval or question from the backend. | Feeds `ApprovalOpened`/`ApprovalClosed` around the app's request (approval time does not count toward the run-time limit). |
| `turnEnded(agent, outcome)` | A turn finished and nothing the agent was sent is still unanswered, or the turn hit the usage limit. Also called when background work still runs. | `TurnEnded` event (`conversation.ts` line 559); reads the lead's context size; reminds or releases agents waiting for this one's answer. |
| `processLost(agent, message, usageLimit?)` | The process went away without being asked, or a start failed. | Cancels open approvals; `ProcessLost` event (`conversation.ts` line 571). |
| `backgroundIdle?(agent)` | Optional. Background work ended, the last turn is over, and no new turn started within `BACKGROUND_GRACE_MS`. | `BackgroundIdle` event (`conversation.ts` line 576). |
| `storeImage?(agent, data, mediaType)` | Optional. Stores an image from a tool result; returns `{ ref }` or `{ error }`. | Stores it as a blob of the conversation, or `{ error: 'images are not stored here' }` when the app has no store. |
| `backend?(agent)` | Optional. The backend this agent runs on, or undefined when none can be used; then the agent fails with a neutral not-found error (tests use `query`). | `host.backend(agent.tier)`; the app looks up the tier's `backend` in its profile (`'claude-code'` when the tier names none) and the registry returns undefined for one that is not available. |
| `query?` | Optional test seam: a stand-in for the Agent SDK's `query()`. Only tests set it. | Not set. |

### `UsageLimit` (line 57)

`{ resetsAt?: number; backgroundStopped?: true }`: the usage limit stopped the agent. `resetsAt` is in ms since the epoch, if known; `backgroundStopped` is set when background commands were running and were stopped with the process.

### `TurnOutcome` (line 63)

`{ text, error?, interrupted, usageLimit? }`: what the agent said since it last took up work (the run text, below), an error if the turn failed, whether it was interrupted, and a `UsageLimit` when it failed at the usage limit.

### `Msg` (private)

`{ id, content }`: a message the runtime sent or will send. Its `id` (a random UUID) comes back in a turn's `consumed` ids.

`Content` is re-exported from `server/backends/types.ts`: a string, or an array of text and image parts.

## Constants and helpers

| Name | Line | Value / what it does |
|---|---|---|
| `TOOL_RESULT_LIMIT` | 81 | 12,000: tool results are clipped to this many characters for the transcript. |
| `DRAFT_INTERVAL_MS` | 82 | 70: the live draft is sent at most this often. |
| `RUN_TEXT_TURNS`, `RUN_TEXT_CHARS` | 87, 88 | 8 turns and 60,000 characters: the most a run text keeps. |
| `FULL_ANSWER_CHARS` | 90 | 400: a turn text this long, from a turn that answered a message it was sent, is a full answer; the run's outcome starts at the last one (see `runText()`). |
| `BACKGROUND_GRACE_MS` (exported) | 91 | 3,000: how long to wait, after the last background command ends, for the turn the backend starts by itself. The comment records that with Claude Code 2.1.331 `init` followed the empty `background_tasks_changed` within 0.1 s. |
| `clip(text, limit)` (exported) | 93 | Cuts text and appends "… (N more characters not shown)". |
| `describeTool(name, input)` (exported) | 98 | One line for the activity display: `toolLine(name, input, true)` from [shared/toolline.ts](Source-Shared-Toolline.md), verb and target joined, cut to 90 characters. |

## `class Agent` (line 113)

### Public state

- `info: AgentInfo` (read-only reference; its fields are changed in place and broadcast through `agentChanged`).
- `sessionId`: the backend's session id, set from the `sessionStarted` event; null before the first session and after a fresh-session retry.
- `owesReport`: whether it owes its parent a report when it next finishes. The conversation copies it into and out of the machine's state on every event.
- `lastText`: the run text of its most recent run (given to the machine as `ctx.lastText`, used when a parent settles a child that ended without a report).

### Private state

| Field | Meaning |
|---|---|
| `session` | The backend `Session` of the running process, or null. |
| `starting` | A slot request or launch is in progress. |
| `backlog` | Messages accepted while no usable process exists; handed to the next process. |
| `unanswered` | Ids of messages sent to the session that no finished turn has consumed. |
| `seed` | The first message of a brand-new session (a sub-agent's task); dropped once a session id is known. |
| `closing` | Masthead asked the process to end, so its end is not a crash. Stays true for a finished agent. |
| `exited` | Settles when the current process has fully exited (`session.ended`); a new launch waits for it. |
| `costBefore` | Cost of earlier processes; the backend reports `costUsd` per session process. |
| `openTools` | Tool items waiting for their result, by tool id. |
| `draft`, `draftTimer` | The block being streamed and its throttle timer. |
| `runTexts`, `runAnswers`, `runTextsCut` | Final texts of the turns of the current run; per text, whether its turn answered a message it was sent (false for a turn the backend started by itself); and whether older ones were dropped. |
| `stallTimer` | Runs from a turn that ended with messages still unanswered until the next turn starts (`stallCheck()`). |
| `generation` | Increased by `end()` and `dispose()`; a start waiting for a slot or for the old process checks it. |
| `sent` | Everything put into the current process, so unanswered messages can be sent again (fresh session, usage limit). |
| `resumedFrom` | The session the current process was asked to resume, if any. |
| `freshRetried` | A fresh session was already tried after a missing one; there is never a second try. |
| `background` | Ids of the background tasks the current process reports as running (replace semantics). |
| `idleTimer` | The `BACKGROUND_GRACE_MS` timer. |
| `inTurn` | Between the first sign of a turn and its result. |
| `launchedAutoEffort` | The `autoEffort` setting the current process's tools were built with. |
| `stale` | The running process cannot take a settings change; relaunch it before its next turn. |
| `limits` | The latest rate-limit notice of each window this process reported (keyed by `type`). |
| `held` | Content of messages a usage-limit turn or loss never answered; sent again first by the next `deliver()`. |
| `limited` | This process hit the usage limit; its later results only repeat that. |
| `lastLimit` | The usage limit this process last reported. |
| `midTurnDelivery` | Whether the current backend takes messages during a turn (`BackendCaps.midTurnDelivery`), set at launch. |
| `afterTurn` | Messages kept back until the running turn ends, for a backend without mid-turn delivery; emptied by `sessionGone()`. |
| `teamTools` | Names of the team tools given to the current session (from `toolsForSession()`). |
| `compactRun` | The running `compact()` promise; while set, `deliver()` puts messages in `backlog`. |

### Getters

`id`, `name`, `tier`, `status` (from `info`); `isLead` (`parentId === null`: with team profiles the lead's tier id is not always `lead`); `live` (status `queued`, `running` or `waiting`); `hasProcess` (`session !== null`); `pendingSeed` (the task text of an agent whose session has not started yet, otherwise null; the conversation saves it so the task survives a restart); `hasBackgroundWork` (`background` is not empty); `busy` (something unanswered, or a start in progress).

### Public methods

| Method | Line | What it does |
|---|---|---|
| `constructor(info, host, opts)` | 181 | `opts`: `sessionId`, `owesReport`, `seed` (default none/false). Sets `costBefore` from the saved usage, so cost keeps adding up across restarts. The conversation creates every agent (create, restore, spawn). |
| `setStatus(status, error?)` | 246 | Sets `info.activitySince` to now when the status changes or an activity line is cleared; sets status and error; clears the activity line unless `running`; sets `endedAt` for done/failed/stopped and clears it otherwise; calls `agentChanged` only if something changed. |
| `addItem(item)` | 257 | Gives a `NewItem` an id (unless it has one) and a timestamp, sets `info.lastOutputAt` to that timestamp for a `text`, `thinking` or `tool` item, and passes it to `itemChanged`. |
| `start()` | 244 | `ensureProcess()`. |
| `deliver(content)` | 249 | While `compact()` runs, only puts the message in `backlog` (sent after the compaction). Otherwise clears `limited`. Builds the messages to send: the `held` ones first (each under a new id), then this one, all added to `unanswered`. If the process is `stale` and the agent is between turns (nothing unanswered before this call, no turn running, no background work), closes it gracefully, marks `closing`, puts the messages in `backlog` and calls `ensureProcess()`. Otherwise, with a usable process, keeps each one in `sent` and sends it into the process (or, during a turn on a backend without mid-turn delivery, keeps it in `afterTurn`), then sets `running`; with none, adds them to `backlog` and calls `ensureProcess()`. |
| `dropHeld()` | 285 | Forgets the held messages. Called by `end()`, `dispose()` and the conversation's `dropHeld` effect. |
| `static imageContent(text, images)` | 289 | Plain text, or image parts followed by a text part. |
| `currentDraft()` | 742 | The current draft, for `{t:'items'}` replies. |
| `interrupt()` | 752 | If there is a session and the status is `running`, `session.interrupt()`. Keeps the process and session. |
| `end(status, error?)` | 761 | Cancels a queued slot request, increases `generation`, clears `starting`, marks `closing`, clears backlog, unanswered and run texts, drops held messages, clears `limited`, closes the session (`graceful` for `done` with no background work; `now` for `stopped`, `failed`, or `done` while background commands run), clears the background set, releases the slot, sets the status. |
| `dispose()` | 781 | Like `end()` but always closes at once and leaves the status alone. Used by `Conversation.shutdown()` for agents that are not live sub-agents (the lead and finished agents). |
| `setEffort(level)` | 797 | Sets `info.effort`, broadcasts, and calls `session.setEffort(level)` on a running session; if that throws or rejects (and the session is still the same), the process is marked `stale`. |
| `applySettings(settings)` | 818 | Only with a usable process (`launch()` reads settings anyway). Effort: the agent's level capped at the tier's ceiling with `autoEffort`, else the tier's level, through `setEffort()`. Lead only: a changed model is set on `info` and sent with `session.setModel`; no `setModel`, or a rejection, marks `stale`. A change of `autoEffort` since launch marks `stale` (tools are built at launch). A changed `permissionMode` (against `permissionMode`, the mode the session has) is sent at once with `session.setPermissionMode(mode)`, so a message delivered right after goes out under it; no such method, a throw or a rejection marks `stale` (line 936). Called by `Conversation.settingsChanged()`. |
| `compact()` | 849 | See [Compaction](#compaction-compact). |
| `refreshContext()` | 914 | If the session has `contextUsage`, reads `{ used, max }` into `usage.context`/`contextMax` (ignored if the session changed meanwhile or the call fails). |

### Private methods

| Method | Line | What it does |
|---|---|---|
| `userMessage(content)` | 294 | Wraps content as a `Msg` with a fresh id and adds the id to `unanswered`. Every message goes through it, so the unanswered rule sees all of them. |
| `ensureProcess()` | 300 | Returns if a start is in progress or a usable process exists. Sets `starting`, notes `generation`, asks the scheduler for a slot (owner = parent id, or the conversation id for the lead), shows `queued` only if the slot was not granted by the next microtask, then waits for `exited`. If the generation changed meanwhile, gives the slot back (unless a newer start or a session now holds it) and does not launch. Otherwise `launch()`; an exception becomes `processLost`. A refused slot: `SlotCancelled` is dropped quietly, anything else (e.g. `TierOff`) goes to `processLost`. |
| `backendFor()` | 340 | `host.backend?.(this)`; if that gives nothing and `host.query` is set (tests), a `ClaudeBackend` with that `query` and `claudePath()`; otherwise null. There is no silent default. |
| `launch()` | 348 | See below. |
| `events()` | 431 | The `SessionEvents` given to `backend.open()`; see the table below. |
| `toolsForSession()` | 483 | `host.tools(this)`, recording the names in `teamTools`. |
| `onSessionStarted(id)` | 489 | Clears `freshRetried`; a new id is stored, the seed dropped and the change broadcast. |
| `tierSettings(settings)` | 499 | `findTier(settings, tier)` from the profiles; if the profiles do not list the tier, the 0.1.x `settings.tiers` view, with `lean` from `leanSubagents` (sonnet, haiku) and `leanOpus` (opus); if that has no such tier either (its profile was deleted), the agent's own model and effort with `lean: false`. |
| `onDraft(d)` | 546 | Non-empty streamed text sets `info.lastOutputAt` (sent with the agent's next change, not on its own). `null` ends the draft; `append: ''` starts a new block (clears the activity line, empty draft sent now); text of the same kind is appended (throttled); a different kind starts a new draft. |
| `onUsage(u)` | 519 | Adds `output`, sets `context`, sets `costUsd` to `costBefore + u.costUsd`. |
| `sessionGone()` | 566 | Clean-up when a session ends either way: a turn still open (`inTurn`) is counted in `usage.turns` and sets `usage.costPartial` (its cost, reported only at a turn's end, is lost); no session, `afterTurn` emptied, cost carried forward, draft cleared, open tools closed, `inTurn` off, background cleared. |
| `onExited(r)` | 538 | The `exited` event: see [Every rule](#every-rule-kept-from-01x-and-where-it-lives-now) (fresh session, usage limit, process lost). |
| `startFresh()` | 557 | Once per missing session: forgets session and seed, adds the info notice, launches with a note to the agent, the unanswered messages from `sent`, then the backlog. |
| `handleResult(r)` | 621 | The `turnEnded` event: first sends what waited in `afterTurn`; then the usage limit. A result from a process being closed (`closing`: an ended agent whose running turn was let finish) is ignored after that: what it consumed was sent before the end, and its text must not join the next run's report. Then consumed ids, the run text (`addRunText(r.text, consumed === null \|\| consumed.length > 0)`), and `turnEnded` to the host; if messages are still unanswered, `stallCheck()`. |
| `usageLimitFor(error, apiError)` | 646 | The usage-limit rule. |
| `holdUnanswered()` | 657 | Moves the content of every message in `sent` that is still unanswered into `held`. |
| `addRunText(text, answers)`, `runText()`, `clearRunTexts()` | 713, 731, 743 | The run text (see [Run texts](#every-rule-kept-from-01x-and-where-it-lives-now)). |
| `stallCheck()`, `clearStall()` | 786, 776 | After a turn ends with messages still unanswered, waits `Agent.unansweredGraceMs` (a static, 60,000 ms; tests shorten it) for the turn that answers them. If none has started by then (same session, not closing, no turn running), they count as answered: `unanswered` is cleared, the notice "A message to this agent got no turn of its own; Masthead counts it as answered." is added, and `host.turnEnded()` gets the run text (emptied unless background work runs), so an agent never shows working for ever. Cleared by `turnStarted()` and `clearBackground()`. |
| `turnStarted()` | 749 | Ignored while `closing` (a process being closed may still finish a turn). `idle`/`waiting` → `running` unless `info.pausedUntil` is set; sets `inTurn`; cancels the grace timer and the stall timer. |
| `backgroundChanged(ids)`, `clearBackground()`, `checkIdleSoon()` | 691, 699, 710 | The background set and its grace timer. |
| `setActivity(text)` | 818 | Sets the activity line and `info.activitySince`, and broadcasts. |
| `setDraft(draft, now)` | 727 | Sends at once when `now`, otherwise at most once per `DRAFT_INTERVAL_MS`. |
| `closeOpenTools()` | 746 | Marks every tool item still waiting for a result as done. |
| `runCompaction()`, `afterCompaction()`, `closeQuietly()` | 861, 898, 906 | The body of `compact()`, the delivery of what waited meanwhile, and closing a process opened only to compact (gives the slot back). |

### `launch()` in detail

```mermaid
flowchart TD
  A[launch] --> A0{"tier marked unusable<br/>in the settings?"}
  A0 -- yes --> A1["clear unanswered and backlog, release slot,<br/>processLost('This team's … level can't be used: …')"]
  A0 -- no --> B{backendFor}
  B -- null --> B1["clear unanswered and backlog, release slot,<br/>processLost('No agent backend is available: …')"]
  B -- backend --> C["tierSettings(settings): lead takes the tier's model"]
  C --> D["effort = autoEffort ? capEffort(effort, ceiling) : ceiling"]
  D --> E["sent = seed (new session only) + backlog; backlog emptied<br/>(a compaction run sends nothing yet and keeps the backlog)"]
  E --> F["reset: resumedFrom, launchedAutoEffort, limits, limited, lastLimit,<br/>stale, inTurn, background, closing"]
  F --> G["backend.open(spec, events())<br/>spec: resume?, model, effort, cwd, env (scratchEnv), dirs [scratch]?, instructions = systemAppend(... tmpDir, caps),<br/>tools = toolsForSession(), canAskPerson = lead, permissionMode, lean"]
  G -- throws --> G1["release slot, processLost(message)"]
  G -- session --> H["session.send(id, content) for each of sent;<br/>midTurnDelivery from caps; status running (not for a compaction run);<br/>exited = session.ended → sessionGone if still current"]
```

- `lean` is the tier's `lean` flag, never for the lead.
- `instructions` is `systemAppend()` from `server/core/prompts.ts`, given the effort the agent launches at, the scratch folder (`tmpDir`, with `tmpIsEnv` = `caps.sessionEnv`), and the backend's `efforts`, `background` and `midTurnDelivery` caps, so the prompt names only what the backend can do.
- The scratch folder: `launch()` asks `host.scratchDir?.(this)` (the conversation's folder, made if need be; line 426). With one, the spec gets `dirs: [dir]` and, only when the backend's `caps.sessionEnv` is true (Claude Code, fake; not Codex, whose one app-server is shared), `env: scratchEnv(dir)` (`TMPDIR` and `CLAUDE_CODE_TMPDIR`, plus `TMP`/`TEMP` on Windows); the system text tells the agent to put temporary files there, naming `$TMPDIR` only when it is set. Otherwise `env` is `{}`; without a folder the agent uses the system temporary folder.
- `permissionMode` is noted as the mode the session has, for `applySettings()`.
- A backend's `open()` should not throw for an ordinary failure (it reports `exited({ failure })`); the catch is for the rest.

### Events from the session

| Event | What the runtime does |
|---|---|
| `sessionStarted(id)` | `onSessionStarted`. |
| `turnStarted()` | `turnStarted()`. |
| `text(final, isError)` | A `text` item, or an error notice when `isError`. |
| `thinking(text)` | A `thinking` item. |
| `draft(d)` | `onDraft`. |
| `toolStarted(t)` | A `tool` item with id `tool-<id>`, kept in `openTools`; activity line from `describeTool()`. A team tool reported under its bare name (Codex) is shown as `mcp__masthead__<name>`, the form the page and `describeTool()` know. |
| `toolFinished(t)` | The tool item done, result clipped to 12,000 characters. Images go to `host.storeImage`; the refs are put on the item, a failure is written into the result next to `[image]`. When no tool is open any more, the activity line is cleared. |
| `turnEnded(r)` | `handleResult`. |
| `rateLimit(n)` | Passed to the host and kept in `limits` by window. |
| `background(ids)` | `backgroundChanged`. |
| `usage(u)` | `onUsage`. |
| `exited(r)` | `onExited`. |
| `askPermission(ask)` | `host.askPermission`. |
| `compacted()` | Info notice "Earlier context was summarized to free up space." |
| `activity(text)` | Activity line. |

## Compaction: `compact()`

`compact(): Promise<{ ok, error? }>` compacts the agent's memory for the team's compact step ([Compact team](Compact-Team.md)). It refuses (`ok: false`) while the agent is in a turn, has unanswered input or is starting; returns `ok: true` with nothing to do for an agent that never had a session; and returns the same promise to a second caller. An agent without a process fails at once when its tier is marked `unusable` or no backend can be found, and gives up with "No free place to run it came up within a minute; try again later." when no slot frees within 60 s (the slot request is cancelled). Otherwise its session is resumed quietly: `launch()` sends nothing and sets no status (so a finished agent stays done), holds a slot meanwhile, and `closeQuietly()` closes it and gives the slot back afterwards. Messages delivered during compaction wait in the backlog and are delivered afterwards. It is not a turn: no `turnEnded`, no turn counted, `lastText` and the report debt unchanged; the context size is read again afterwards. Tested on the fake backend and live on Claude Code (`test/compact.live.ts`, Haiku, 2026-11-27: passed).

## Every rule kept from 0.1.x and where it lives now

"Runtime" is `server/runtime/agent.ts`; "Claude adapter" is `server/backends/claude/session.ts`; "machine" is `server/core/machine.ts` with its shell `server/core/conversation.ts`.

| Rule | Runtime | Claude adapter | Machine / conversation |
|---|---|---|---|
| **Unanswered / consumed ids.** Every message has an id in `unanswered`; a turn is over for the agent only when nothing is unanswered. `consumed: [...]` removes those ids; `[]` (a turn the backend started by itself) removes none; `null` (cannot tell) clears all, so an agent never stays busy for ever. A turn that ends with something still unanswered starts the stall timer: if no turn starts within `Agent.unansweredGraceMs` (60 s), the rest counts as answered. | `userMessage()`, `handleResult()` (line 621), `stallCheck()` (line 786). | `result()` (line 471) builds `consumed` from `user_message_uuids` or `user_message_uuid`; a result naming none gives `[]` if this process named one before or its `init` listed `interrupt_receipt_v1` (`namesConsumed`, also set by an assistant message's `user_message_uuid`), else `null` (line 507). | Reads `agent.busy` as `ctx.busy`. |
| **Backlog and seed.** Messages accepted with no usable process wait in `backlog`; a new session gets the seed first. The seed is dropped once the session id is known and saved as `pendingSeed` until then. | `deliver()`, `launch()`, `onSessionStarted()`. | — | The conversation saves `pendingSeed`. |
| **Generation ghost-start guard.** A start waiting for a slot or the old process's exit is dropped if `end()`/`dispose()` ran meanwhile; the slot is given back unless a newer start holds it. | `ensureProcess()` (line 300), `end()`, `dispose()`. | — | — |
| **Wait for the old process before a resume.** | `exited` from `session.ended`; `ensureProcess()` waits for it. | `ended` settles when `consume()` finishes (lines 182, 328). | — |
| **Fresh session once on a missing session.** Only for a resume that ended before the session started and whose output names the missing session; never twice in a row; the flag clears when a session starts. Re-sends a note, the unanswered messages, the backlog. | `onExited()` → `startFresh()` (line 557). | Decides `sessionMissing` (line 342): `spec.resume`, no `init` seen, and `MISSING_SESSION` (line 58) in the failure, the stderr tail, or a result set aside before `init` (`missingSaid`, line 436). | — |
| **Stale relaunch between turns.** Set by an `autoEffort` switch since launch, a failed `setModel`/no `setModel`, a failed `setEffort`, or a failed or missing `setPermissionMode`. Acted on only by `deliver()` between turns; the old process closes gracefully and the same session resumes, keeping the slot. Never mid-turn. | `applySettings()`, `setEffort()`, `deliver()`. | `setEffort` → `applyFlagSettings({ effortLevel })` (line 288); `setModel` → `Query.setModel` (line 291). | `settingsChanged()` calls `applySettings()`. |
| **Held messages at a usage limit.** The process is closed (`now`) *before* `turnEnded`, so anything the host delivers from inside it goes to a new process. Only unconsumed messages are held (the consumed one is in the session with the error). Held messages go first, under new ids, on the next `deliver()`. A late result from the closed process is reported with `usageLimit` too. `end()`/`dispose()`/`dropHeld()` forget them. A process lost at the limit holds the same way. | `handleResult()`, `onExited()`, `holdUnanswered()`, `dropHeld()`. | — | The machine pauses (`pause()`, `machine.ts` line 224): `releaseSlot`, `pauseRuntime`; the conversation keeps its own `held` list for messages delivered *during* the pause (`deliverTo()`, `conversation.ts` line 713) and delivers it on `resumeRuntime` (`conversation.ts` line 675); `Stop` emits `dropHeld` (`machine.ts` lines 392, 400). |
| **Usage-limit rule.** Only if the latest notice of some window this process reported is `rejected` **and** `apiError` is `rate_limit` or the error text matches `rate[ _]limit`, `usage limit`, `limit reached` or `hit your limit`. Never for an interrupted turn. `resetsAt` arrives in seconds and is turned into ms. | `usageLimitFor()` (line 646). | Reports `rateLimit` per window (`unifiedWindows`, read defensively) and `apiError` from the assistant message's `error`. | Pause, give up after the 4th window in a row ([State machine](State-Machine.md) rows 11, 11a). |
| **Run texts.** The outcome text is every turn's final text since the agent last took up work, oldest first, joined by blank lines, a repeat of the previous one not added. At most 8 texts and 60,000 characters (the newest always kept). New in 0.2.1: the outcome starts at the **last full answer**, a text of at least `FULL_ANSWER_CHARS` (400) from a turn that answered a message it was sent; an agent asked again rewrites its report, and the later full answer replaces the earlier one. Shorter texts after it ("Noted") are kept with it, and the text of a turn the backend started by itself (`consumed: []`, a finished background command) is never a full answer, so it cannot drop the report written before it; a backend that cannot tell (`null`) counts as answering. "(earlier text not shown)" goes first only when older texts were dropped and no full answer cut the start. The turn of a process being closed adds no text. Emptied when the outcome is sent unless background work runs, and by `end()`, `dispose()`, a lost process and a failed fresh start. | `addRunText(text, answers)`, `runText()`, `clearRunTexts()`. | `turnEnded.text` prefers the result string over the last text block. | Uses `text` and `lastText`. |
| **Background set, 3 s grace, `backgroundIdle`.** The set is per process and replaced on each event; emptied when a process starts or ends and by `end()`/`dispose()`. When it empties, a 3 s timer calls `host.backgroundIdle` only if the same session is open, not closing, not in a turn, not busy and with no background work. `end('done')` with background work closes at once. | `backgroundChanged()`, `checkIdleSoon()`, `end()`. | Non-ambient task ids from `system/background_tasks_changed`. | `holds.background` read fresh; `BackgroundIdle` (row 19); 10-minute background cap (row 22). |
| **`turnStarted` moves `idle`/`waiting` to `running`** unless `info.pausedUntil` is set. | `turnStarted()` (line 682). | Sent on `init`, every stream event and every assistant message. | `Status` event (`machine.ts` line 423): ignored while a pause holds the agent. |
| **Draft throttle.** 70 ms; `append: ''` starts a block and clears the activity line. | `onDraft()`, `setDraft()`. | `content_block_start` (text or thinking) → `append: ''`; deltas → appends; an assistant message → `null`. | — |
| **Tool results** clipped to 12,000 characters; images through `host.storeImage`. | `toolFinished` handler. | `toolResultText()` (images as `[image]`) and base64 image parts. | `storeImage` stores a blob. |
| **Context size at every turn end** (read while the process is still up). | `handleResult()` calls `refreshContext()` (line 636) for every agent, before `turnEnded`, when the run ends normally (not at a usage limit, not while more input is unanswered). | `contextUsage()` → `Query.getContextUsage()`. | `turnEnded()` calls it again for the lead (`conversation.ts` line 562). |
| **Tiers read with `findTier`**, falling back to the 0.1.x `tiers` view. | `tierSettings()` (line 499). | — | — |
| **System text with the backend's caps.** | `launch()`: `systemAppend({ …, caps })`. | Appended to the `claude_code` preset. | `server/core/prompts.ts`. |
| **Backend choice.** No silent default: no backend → the agent fails with "No agent backend is available: the program this tier runs on was not found on this machine." `host.query` is only a test seam. | `backendFor()` (line 340), `launch()`. | — | `backend(agent)` (`conversation.ts` line 511) → the app's registry. |
| **Neutral texts.** Notices and errors written by the runtime name no CLI ("the program this tier runs on", "The agent process ended unexpectedly."). | `launch()`, `onExited()`. | — | — |

Not in the runtime any more (now in the Claude adapter): the `Channel` input stream, `DISALLOWED` tools, `STDERR_KEEP`, `toolResultText`, the SDK `Options`, the `[ede_diagnostic]` filter and the interrupted flag.

## Points to be aware of

- With `BackendCaps.midTurnDelivery` false, a message delivered during a turn is kept in `afterTurn` (still unanswered, so the agent stays busy) and sent when that turn's result arrives, before the run's end is decided; the next turn is part of the same run. `caps.consumedIds` is not read by the runtime (a `null` from the backend is enough).
- For the lead the context size is read twice per turn end (`handleResult()` and `Conversation.turnEnded()`); harmless.
- If `launch()` threw after `backend.open()` succeeded, the catch in `ensureProcess()` would drop the session without closing it. Nothing after `open()` is expected to throw.

## Tests

`test/agent.test.ts` (38 tests, all passing when run for this page on 2026-11-27): the `agent:` tests drive this runtime through `ClaudeBackend` with a fake `query` (the `AgentHost.query` seam); the `runtime on fake:` tests drive it on the fake backend ([Fake backend](Source-Backend-Fake.md)). What was checked against a real Claude Code is listed on [Agent life cycle](Agent-Life-Cycle.md#checked-against-a-real-claude-code).

## Related pages

[Agent life cycle](Agent-Life-Cycle.md) · [State machine](State-Machine.md) · [server/core/machine.ts](Source-Core-Machine.md) · [server/core/conversation.ts](Source-Core-Conversation.md) · [Backend interface](Backend-Interface.md) · [Claude Code backend](Source-Backend-Claude.md) · [Fake backend](Source-Backend-Fake.md) · [Permissions and questions](Permissions-and-Questions.md)
