# Agent life cycle

This page follows one agent from its start to its end **from the runtime's and the backend's side**: when a process starts, what happens during and after a turn, and how it ends or is resumed. The code is `server/runtime/agent.ts` (the `Agent` class, see [server/runtime/agent.ts](Source-Runtime.md)) and the backend behind it (`server/backends/`, see [Backend interface](Backend-Interface.md); for Claude Code, [Claude Code backend](Source-Backend-Claude.md)).

The statuses, the holds that keep an agent `waiting` (children, an awaited answer, background work, a usage-limit pause), and what an ended turn means for the team are decided by the core state machine: see [State machine](State-Machine.md) and [server/core/machine.ts](Source-Core-Machine.md). This page refers to them but does not repeat them.

## Terms

- **Turn**: one round of work by the model: it reads what it was sent, thinks, calls tools and writes a final message. A turn ends with the backend's `turnEnded` event (for Claude Code, a `result` message).
- **Session**: the backend's saved history of one agent's conversation, identified by a session id. A session outlives a process and can be **resumed**.
- **Process**: the running backend program for one agent. In the runtime the backend's `Session` object (`Agent.session`) stands for it; `hasProcess` is true while there is one.
- **Slot**: permission from the scheduler for one agent of a tier to have a process. See [Slot scheduling](Slot-Scheduling.md).
- **Run**: the turns since the agent last took up work; its outcome text joins all their final texts.

## 1. Start

The conversation creates every `Agent`: the lead (no session, no process, status `idle`), a sub-agent from `spawn_agent` (status `queued`, owing a report, with its task as the **seed**, the first message of a brand-new session), and restored agents (with their saved `sessionId`, or their saved task as seed if they never got a session). `spawn()` then calls `agent.start()`, which is `ensureProcess()`. The lead gets its first process only when its first message arrives.

## 2. Getting a slot

`ensureProcess()` returns at once if a start is already in progress or a usable process exists. Otherwise:

1. `starting = true` (so `busy` is true), and the current **generation** is noted. `end()` and `dispose()` increase it.
2. `scheduler.acquire(tier, id, owner)`, owner = the parent's id (the conversation id for the lead).
3. `queued` is shown only if the slot was not granted by the next microtask.
4. Once granted, it waits for the previous process to have fully exited (`exited`, from `session.ended`), so a resume never overlaps the old process.
5. If the generation changed meanwhile, the agent was ended while it waited (a slot can be granted in the same pass that freed it, after `end()` found nothing left to cancel): the start is dropped and the slot given back, unless a newer start now holds it. A stopped agent is never launched.
6. A cancelled request (`SlotCancelled`, the agent was stopped while queued) is dropped quietly. Any other refusal, such as `TierOff` (the tier was set to 0 while the agent waited), goes to `host.processLost()`, as does an exception thrown by `launch()`.

## 3. Opening a session: `launch()`

1. **Backend.** `host.backend(agent)` (the app picks the backend named by the tier's profile, `claude-code` by default, if it is available). If there is none, the agent fails with "No agent backend is available: the program this tier runs on was not found on this machine." and its slot is released. Only tests use the other way in, `host.query`, which builds a Claude Code backend around a stand-in for the SDK's `query()`.
2. **Model and effort.** Tier settings come from the team profile (`findTier`), or the 0.1.x `tiers` view. The lead takes the tier's current model; other agents keep the one they were created with. With automatic effort the agent's level is capped at the tier's ceiling; without, it is the tier's level.
3. **Input.** A new session (no `sessionId`) gets the seed first, then the backlog (messages accepted before the process existed). All of it is kept in `sent`.
4. **Reset per process**: `resumedFrom`, `launchedAutoEffort`, rate-limit notices, the usage-limit flags, `stale`, `inTurn`, the background set, `closing`.
5. **`backend.open(spec, events)`** with `resume` (if there is a session), model, effort, folder, Masthead's system text (`systemAppend()`, given the launch effort and the backend's caps), the team tools bound to this agent, `canAskPerson` (lead only), the permission mode and `lean` (never the lead).
6. Every message in `sent` is sent with its id; the status becomes `running`.

For Claude Code, `open()` starts the Agent SDK's `query()` in streaming-input mode with Claude Code's own system prompt plus Masthead's text, the team tools as an in-process MCP server, the built-in tools that would bypass the team turned off, partial messages for live drafts, adaptive thinking with summarized display, and the process started in its own process tree so a stop ends the commands it started. Details on [Claude Code backend](Source-Backend-Claude.md).

## 4. Turns

- **Turn start.** The backend's `turnStarted` (Claude Code: `system/init`, any stream event, any assistant message) sets `inTurn` and cancels the background grace timer. If the agent is `idle` or `waiting` and not paused at the usage limit (`info.pausedUntil`), it becomes `running`: backends also start turns by themselves, for instance when a background command finishes.
- **During the turn.** Text, thinking and tool events become transcript items; the live draft is sent at most every 70 ms (a new block is sent at once and clears the activity line); a tool call sets the activity line and its result is clipped to 12,000 characters, with images stored through `host.storeImage`.
- **Messages during a turn** go straight into the running process, each with a new id in `unanswered`.
- **Turn end.** The backend names the ids the turn consumed. They leave `unanswered`; a turn the backend started by itself names none (`[]`) and removes none; a backend that cannot tell (`null`, e.g. an older Claude Code that never names them) clears everything, so an agent can never stay busy for ever. The turn's final text is added to the run. Then:
  - if anything is still unanswered, another turn follows; an error is shown as a notice and the agent stays `running`;
  - otherwise the run text is emptied (unless background work runs), the real context size is read while the process is still up, and `host.turnEnded(agent, { text, error, interrupted })` hands the decision to the machine (finish, wait, or go idle).

The outcome text is every turn's final text since the agent took up work, because a message that lands as a turn ends makes the backend run one more turn whose reply is often only "Noted". At most the newest 8 texts and about 60,000 characters are kept; the text then starts with "(earlier text not shown)".

## 5. Background work

A backend that reports background commands (`caps.background`; Claude Code does) sends the full set of running ones each time it changes. The set belongs to one process.

- A turn that ends while background work runs still calls `turnEnded`; the machine keeps the agent `waiting` (the background hold). The run text is kept.
- When the work ends, the backend starts a turn by itself; its result names no message and its outcome carries the earlier turn's text too.
- If the set empties and no turn starts within 3 s (`BACKGROUND_GRACE_MS`), the runtime calls `host.backgroundIdle(agent)` (only if the same process is still open, not closing, not in a turn and not busy), and the machine releases the hold.
- `end('done')` while background commands run closes the process at once instead of letting it finish, so it never waits for them.
- If the process exits instead, the process-lost path runs (section 8).

## 6. Usage limit

A turn counts as stopped by the usage limit only if the latest rate-limit notice of some window this process reported has status `rejected` **and** the error is classed as a rate limit (`apiError: 'rate_limit'`, for Claude Code the assistant message's `error`) or says so. A busy API, a network or a tool error has no rejected notice behind it and is an ordinary error. An interrupted turn never counts.

Then the runtime, before calling the host:

1. moves the messages this process was sent and no turn consumed into `held` (as content, so they do not count as busy; the message the failed turn consumed is already in the session with the error and is not sent again);
2. clears `unanswered`, marks the process `limited`, sets `backgroundStopped` if background work was running;
3. closes the process at once, so nothing stays queued inside it and no turn can start by itself during the pause;
4. calls `turnEnded` with `usageLimit: { resetsAt }` (ms; backends report seconds), even if more input was queued.

Anything the host delivers from inside that `turnEnded` goes to the backlog of a new process, never to the closing one. A result that was already on its way from the closed process is reported with `usageLimit` too (the machine treats repeats as one pause). A process that *dies* at the limit calls `processLost(agent, message, usageLimit)` and holds its messages the same way.

The machine then pauses the agent until `resetsAt` and releases its slot; messages sent to it during the pause are kept by the conversation and delivered when the pause ends. The next `deliver()` sends the runtime's held messages first, under new ids, in a new process that resumes the session. `dropHeld()` forgets them; `end()`, `dispose()` and the machine's `dropHeld` effect (on a stop) call it. See [State machine](State-Machine.md) rows 11, 11a and 20.

## 7. A session that no longer exists

If an agent's session was deleted or moved, a resume cannot work. The backend says so with `exited({ sessionMissing: true })`. Claude Code reports it only as text, so the Claude adapter's rule is narrow: the process was a resume, it ended before reporting `init`, and the failure, the last 4,000 characters of Claude Code's error output, or a result set aside before `init` contains "No conversation found with session ID". Any other failure is reported as a lost process, so a session is never thrown away because of a network or sign-in problem.

The runtime then starts fresh, **once**: it forgets the session id and seed, adds the notice "The earlier session could not be found, so its context is lost. This agent starts fresh.", and launches a new session whose input is a note to the agent saying the same, then every message the old process was sent and never answered, then the backlog. A second missing session in a row is not retried; the flag clears when a session does start.

## 8. Process lost

If the session ends without Masthead asking (`closing` is false) and it is not a missing session, the runtime clears `unanswered` and the run text (after holding messages if it was the usage limit) and calls `host.processLost(agent, failure or 'The agent process ended unexpectedly.', usageLimit?)`. A failed `open()` and a refused slot come the same way. The conversation cancels the agent's open approvals and feeds `ProcessLost` to the machine: an error notice, the slot released, then a pause at the usage limit, or for a sub-agent a failure reported to its parent, or for the lead `waiting`/`idle`.

## 9. Stop, end, dispose

- **`interrupt()`** (the lead's Stop button) ends the current turn and keeps the process and session; only while `running`.
- **`end(status, error?)`** is how the machine's `end` effect ends an agent: it cancels a queued slot request, increases the generation (so a waiting start is dropped), marks `closing`, clears backlog, unanswered messages, run text, held messages and the background set, closes the session (`graceful` for `done` with no background work: the backend finishes on its own; `now` otherwise), releases the slot and sets the status. Because `closing` is set, the session's end is not treated as a crash.
- **`dispose()`** does the same but always closes at once and leaves the status alone. `Conversation.shutdown()` uses it for agents that are not live sub-agents (the lead and finished agents); live sub-agents are stopped through the machine with "Masthead was closed while this agent was working.".

## 10. Resume

A `done`, `failed` or `stopped` agent has no process but keeps its `sessionId`. When the machine wakes it, `deliver()` puts the message in the backlog and `ensureProcess()` gets a slot (it may queue like a new agent), waits for the old process to have exited, and launches with `resume`. An agent that never got a session gets its saved seed first. Who may wake whom is on [Team rules](Team-Rules.md).

The same path relaunches a **stale** process. Settings the running process cannot take mark it stale: a change of the automatic-effort switch (the tools are built at launch), and a model or effort change that did not reach the session (`setModel` missing or rejected, `setEffort` rejected). The next message that arrives between turns (nothing unanswered, no turn running, no background work) closes the process gracefully and resumes the same session in a new process, keeping the slot. It is never relaunched mid-turn: a message during a turn goes into the running process.

## Checked against a real Claude Code

These were checked on 2026-11-27 against Claude Code 2.1.331 (Haiku) with throwaway harnesses that drove the 0.1.4 `Agent` class, before its Claude Code code moved into `server/backends/claude/session.ts`; the adapter says it carries that behaviour over unchanged. They were not run again for this page.

- **Background work:** with `sleep 20` in the background, the turn's result came at 3.5 s, then task updates, an empty `background_tasks_changed` and `init` at 22.8 s, then the self-started turn's result (its `origin.kind` was `task-notification`). The grace path: a task stopped with `Query.stopTask()` gave `task_notification` (stopped) and an empty `background_tasks_changed`, Claude Code started no turn, and `backgroundIdle()` fired 3.0 s later.
- **Missing session:** after the session's `.jsonl` file under `~/.claude/projects/<folder>/` was deleted, the resume wrote an `error_during_execution` result "No conversation found with session ID: …" before any `init`; the notice appeared once and the message was answered by a new session.
- **Lead model change:** after `setModel()`, the next turn's `init` and assistant message named the new model, in the same process.
- **Automatic-effort switch:** the next message started a new process that resumed the same session; its `init` listed the team tools without `set_effort` and `set_agent_effort`, the agent still knew the first message, and the new message was answered.
- **Effort change mid-turn:** `applyFlagSettings({ effortLevel })` sent during a turn applied from the next request of the same turn.
- **Rate limits:** a real `rate_limit_event` carried `utilization` as a fraction (0.33) and `resetsAt` in seconds since the epoch.

`npm run test:live` (real Claude Code, Haiku for every tier; not run for this page) covers background work in its fourth round and, in its sixth round, the automatic-effort relaunch together with a deleted lead session file; the seventh round switches automatic effort back.

## Covered only by tests

- **The usage limit** (a `rejected` notice, held messages, the closed process, late results, a process lost at the limit) has never been seen for real; it is covered by `test/agent.test.ts` with a fake `query` and on the fake backend.
- **A Claude Code that never names consumed messages** (`consumed: null`): unit test only.
- **A failed `setEffort`** relaunching the process: fake backend only (Claude Code's `applyFlagSettings` was not seen to fail).
- **Tool-result images stored as blobs**, **a self-started turn moving a `waiting` agent to `running`**, and **a backend without background tracking**: fake backend only.
- **The generation guard** (an agent ended while waiting for a slot is never launched): unit test only.

The `runtime on fake:` tests in `test/agent.test.ts` run this runtime on the fake backend ([Fake backend](Source-Backend-Fake.md)); the `agent:` tests run it through the Claude adapter with a stand-in for the SDK's `query()`. All 30 passed on 2026-11-27.

## Related pages

[server/runtime/agent.ts](Source-Runtime.md) · [State machine](State-Machine.md) · [server/core/machine.ts](Source-Core-Machine.md) · [server/core/conversation.ts](Source-Core-Conversation.md) · [Backend interface](Backend-Interface.md) · [Claude Code backend](Source-Backend-Claude.md) · [Slot scheduling](Slot-Scheduling.md) · [Team rules](Team-Rules.md)
