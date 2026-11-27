# Glossary

Terms used in the code and this wiki for Masthead 0.2.0, in alphabetical order. Code names are in backticks; file paths are relative to the repository root.

| Term | Meaning |
|---|---|
| **Agent** | One member of a team: a backend session plus Masthead's record of it. Runtime class `Agent` in `server/runtime/agent.ts`; record `AgentInfo` in `shared/protocol.ts`; life-cycle state `AgentState` in `server/core/machine.ts`. |
| **Agent name** | The short name every agent gets, in order, from the radio spelling alphabet: `alpha` (the lead), `bravo`, `charlie`, … `zulu`, then `alpha-ii`, `bravo-ii`, … Shown capitalised ("Bravo", "Alpha II"). `agentName()`, `displayName()` in `shared/protocol.ts`. |
| **Agent SDK** | `@anthropic-ai/claude-agent-sdk`, the library the Claude Code backend uses to start and talk to Claude Code (`query()`). Only `server/backends/claude/` (and the runtime's test hook) uses it. |
| **`AgentHost`** | What an `Agent` needs from its owner (`server/runtime/agent.ts`); implemented by `Conversation`. |
| **Ancestor** | An agent's parent, its parent's parent, and so on up to the lead (`isAncestor()`). Ancestors may stop agents below them and set their effort. |
| **Approval** | A tool call a backend asks the person to allow, shown as a card (`PermissionRequest` with `kind: 'permission'`). While one is open the agent's run clock stops (`holds.approvals`). Version 2 tabs also get a short `ApprovalSummary` for badges. See [Permissions and questions](Permissions-and-Questions.md). |
| **Automatic effort** (`autoEffort`) | Setting: agents start at low effort and manage it with the effort tools; each tier's effort becomes a ceiling. See [Thinking effort](Thinking-Effort.md). |
| **Awake-time clock** | `Clock.active()` in `server/core/conversation.ts`: time the computer was awake, used for durations (run-time limit, background cap, "for 3m" in `list_agents`). It follows the wall clock but moves at most 60 s per reading (`ACTIVE_STEP_MS`) and is read every 15 s, so a sleep counts as at most one step. Compare **wall clock**. |
| **Background cap** | A sub-agent waiting on background commands alone is finished after 10 minutes of awake time (`BACKGROUND_WAIT_MS`), with "A background command was still running when Masthead closed this agent." The lead is never closed this way. |
| **Background work** | Commands a backend runs in the background for an agent and reports through `SessionEvents.background()` (`Agent.hasBackgroundWork`). Only backends with `caps.background` report it (Claude Code yes, Codex no). A hold. |
| **Backend** | A program agents run on, behind the interface in `server/backends/types.ts`: `claude-code` (Claude Code via the Agent SDK), `codex` (Codex via `codex app-server`) or `fake` (scripted, tests only). Each tier names its backend. See [Backend interface](Backend-Interface.md). |
| **Backend caps** (`BackendCaps`) | What a backend can do: effort levels, live effort and model changes, resume, images, interrupt, background reporting, permission model (`callback`/`mode-only`/`none`), "always" rules, questions, consumed ids, mid-turn delivery, context usage, lean. |
| **Backlog** | Messages an `Agent` accepted while it had no session; sent when the session opens. |
| **Blob** | An image stored on the server, per conversation, named by the SHA-256 of its bytes (`BlobStore` in `server/storage/blobs.ts`). Referred to by a `BlobRef` (`blob`, `mediaType`, `w`, `h`, `bytes`). |
| **Blob token** | A per-socket token (`state.blobToken`) that lets the page fetch `/blob/<conv>/<hash>?t=<token>` with a plain `<img>`; valid while the socket is open and 60 s after (`BlobTokens` in `server/transport/blobs.ts`). |
| **Busy** (agent) | The runtime still has input no finished turn has consumed, or a start pending (`Agent.busy`). A waiting agent does not finish while busy. |
| **Busy** (conversation) | Any of its agents is live (`Conversation.busy()`); sent as `ConversationMeta.busy` and used by keep-awake. |
| **Capability** (protocol) | What a version 2 page says it handles in `hello.caps`: `drafts-delta`, `items-paging`, `blobs`, `resync`. Recorded by the `Hub`, not acted on. |
| **Ceiling** | With automatic effort on, the highest effort a tier may reach, set by the person (`TierSpec.effort`). |
| **Child / parent** | The agent another agent started, and the agent that started it (`AgentInfo.parentId`). |
| **Clipped item** | A live `tool` item whose `input` or `result` exceeded 16,384 characters (`CLIP_CHARS`), cut for version 2 tabs and marked `truncated: true`; the page asks for the whole item with `item_full`. |
| **`ClientError`** | An error with an `ErrorCode` (`protocol`, `refused`, `not_found`, `too_large`, `invalid`) thrown while handling a tab's message (`server/app/clients.ts`). |
| **Consumed ids** | The ids of runtime messages a finished turn answered (`TurnResult.consumed`). An agent's turn is over only when nothing it was sent is still unanswered. |
| **Conversation** | One chat: a lead and every agent started under it, a working folder (`cwd`) and a team profile (`ConversationMeta.profileId`). Class `Conversation` in `server/core/conversation.ts`, the shell around the state machine. |
| **`ConversationHost`** | What a `Conversation` needs from the app (`server/core/conversation.ts`); implemented by `App`. |
| **cwd** | "Current working directory": the folder a conversation's agents work in. |
| **Draft** | The text or thinking an agent is writing right now, not saved (`Draft`). Version 2 tabs get it as deltas: `draft` with `dseq` and `append` or `text`, then `draft_end`. |
| **`dseq`** | Counter within one draft for version 2 tabs; a gap means a delta was lost and the page sends `draft_sync`. |
| **Effect** | What `step()` asks the shell to do after a transition (`Effect` in `server/core/machine.ts`): `send`, `report`, `end`, `setEffortLow`, `releaseSlot`, `pauseRuntime`, `resumeRuntime`, `dropHeld`, `stopChildren`, `notice`, `remind`, `noAnswer`, `childEndedQuietly`, `save`. Carried out by `Conversation.exec()`. |
| **Effort** | How much the model reasons: `low`, `medium`, `high`, `xhigh` (shown as Extra). No `max`. A backend offers only the levels in its `caps.efforts`. |
| **Effort request** | A message a sub-agent's `set_effort` sends to its parent asking for a higher level. |
| **Envelope** | The `<agent-report>` or `<agent-message>` tags wrapping text from another agent (`reportEnvelope()`, `messageEnvelope()` in `server/core/prompts.ts`). |
| **Epoch** | Random id made at each server start (`Hub.epoch`); a page sends it back with `subscribe` so a `seq` from an earlier start is never replayed. |
| **Event** (machine) | An input to `step()`: `Spawned`, `Launched`, `Input`, `TurnStarted`, `TurnEnded`, `ProcessLost`, `Asked`, `AnswerArrived`, `ChildStarted`, `ChildEnded`, `Background`, `Tick`, `Stop`, `Woken`, `Restored`, `Status`, … |
| **Held messages** | Messages from agents (and Masthead's notes) to an agent paused at a usage limit, kept in `Conversation.held` and delivered in order when the pause ends. The person's own messages are not held: they go through at once, after what was held. A stop drops them (`dropHeld`). |
| **Hold** | A reason a `waiting` agent is not finished (`Holds` in `server/core/machine.ts`): live children, an answer it waits for, background work, a usage-limit pause. Open approvals are counted in `holds` too but only stop the run clock. `holding()` is true while any of the first four is present. |
| **Hub** | `Hub` in `server/app/clients.ts`: every connected tab, its protocol version and subscriptions, the per-conversation event rings, draft deltas, clipping and coded errors. `admit()` is the role gate. |
| **Inbound item** | A transcript entry for something from another agent: a task, report or message (`kind: 'inbound'`). |
| **Interrupt** | Ending an agent's current turn while keeping its session (`Session.interrupt()`); used for the lead. |
| **Item** | One transcript entry (`Item`): `user`, `text`, `thinking`, `tool`, `inbound` or `notice`. |
| **JSONL** | JSON Lines: one JSON value per line. Transcripts are `items/<agentId>.jsonl`. |
| **Keep awake** (`keepAwake`) | Setting, on by default: while any conversation is busy, Masthead holds off **idle** sleep with a helper process (`systemd-inhibit`, `caffeinate`, or PowerShell `SetThreadExecutionState`; `server/service/awake.ts`). Closing the lid or choosing Suspend still works. |
| **Lead** | The first tier's agent of a conversation, the one the person talks to, always named `alpha`. It never ends; `lead` also works as a name in `send_message`. |
| **Lean** | `TierSpec.lean`: agents of that tier skip the person's own MCP servers (Claude Code: `strictMcpConfig`; Codex: the person's servers switched off). `leanSubagents` / `leanOpus` are the 0.1.x compatibility view of this for the Claude profile. |
| **Limit streak** | Usage-limit pauses in a row (`AgentState.limitStreak`). After 3 (`MAX_PAUSES`), a sub-agent fails and the lead carries on. |
| **Live** | Phase `queued`, `running` or `waiting` (`live()`). |
| **Local secret** | Random secret in the data folder; the local socket, `/api/shutdown` and image uploads require it. See [Security model](Security-Model.md). |
| **MCP / MCP server** | Model Context Protocol: a standard way to give an agent tools. The Claude backend exposes Masthead's team tools as an in-process MCP server named `masthead`; Codex gets them as dynamic tools. |
| **`modelLabel()`** | Turns a model id into a name people use: `claude-opus-5-5` → "Opus 5.5". A tier's `label` defaults to it. |
| **Owes a report** (`owesReport`) | The agent must report to its parent when it next finishes. |
| **Owner** | In the scheduler, the parent id (or conversation id) a slot request is made for; used for fair queueing. |
| **Pause** | A hold set when an agent hits a usage limit: it goes `waiting`, gives up its slot, and resumes at the reset time (or 15 minutes later if unknown; `DEFAULT_PAUSE_MS`). `AgentInfo.pausedUntil` shows when. |
| **Permission mode** | `settings.permissionMode`: `inherit`, `default`, `acceptEdits`, `auto`, `bypassPermissions`. Each backend maps it to its own policy. See [Safety model](Safety-Model.md#5-approvals-and-permission-modes). |
| **Permission request** | A tool approval or a question shown to the person (`PermissionRequest`). |
| **Phase** | An agent's life-cycle position in the state machine (`Phase` in `server/core/machine.ts`): `queued`, `running`, `waiting`, `idle` (lead only), `ended`. The page's **status** is the phase, with `ended` replaced by its kind (`statusOf()`). |
| **Profile** (team profile) | A named team: an ordered list of 1 to 5 tiers (`TeamProfile` in `shared/protocol.ts`). The built-in `claude` profile is always present; a generated `codex` profile is added when Codex is usable. Each conversation runs on one. See [Team profiles and settings](Team-Profiles-and-Settings.md). |
| **Report** | What a sub-agent said in its last run of turns, delivered to its parent in an `<agent-report>` envelope when it finishes. |
| **Resume** | Opening a new backend session that continues an existing one (`SessionSpec.resume`), keeping the agent's context. |
| **Resync** | `{t:'resync'}`: the server cannot replay a version 2 tab's missed events, so it sends a fresh snapshot. |
| **Ring** | The `Hub`'s per-conversation buffer of recent version 2 events (at most 500 or 8 MiB), used to replay on `subscribe`. |
| **Role** | What an approved remote device may do: `read`, `approve` or `full` (`allowedMessage()` in `server/remote/authorise.ts`). See [Security model](Security-Model.md). |
| **Run clock / run-time limit** | `AgentState.run`: awake time a sub-agent spent `running` with no approval open on its current piece of work. When it passes `settings.maxRunMinutes` (0 = off, at most 1440), the agent is stopped: "Stopped after N minutes: the run-time limit set by the person." |
| **Runtime** | `server/runtime/agent.ts`: the backend-neutral layer that drives one backend session for one agent and turns its events into items, drafts, usage and status. See [Runtime](Source-Runtime.md). |
| **Seed** | The first message of a brand-new agent: its task. Saved while the agent has no session yet (`Agent.pendingSeed`). |
| **`seq`** | Per-conversation sequence number on version 2 events; the page sends the last one it has with `subscribe` to replay from there. |
| **Session** | A backend's conversation with one agent (`Session` in `server/backends/types.ts`; `sessionId` is the backend's id for it). Survives the process and restarts, so an agent can be resumed. |
| **Settle** | Moving on a parent that was only waiting for a child that ended without a report (`Conversation.settle()`, a `ChildEnded` event). |
| **Shell** | `Conversation` in its role around the pure machine: it feeds events in with `apply()` and carries out effects with `exec()`. |
| **Slot** | Permission to run one agent of a tier; limited by the tier's `max`, across all conversations (`Scheduler`). The first tier of every profile is not limited. See [Slot scheduling](Slot-Scheduling.md). |
| **Status** | What the page and agents see: `queued`, `running`, `waiting`, `idle`, `done`, `failed`, `stopped` (`AgentStatus`). Also the machine event `Status`, by which the runtime's own status changes enter the machine. |
| **Stop mark** (`stoppedByPerson`) | Set when the person stops a working sub-agent; other agents may then not wake it ("the person stopped X; only they can wake it"). Cleared when the person messages it. Saved with the conversation. |
| **Store (page)** | The single object in `web/src/lib/store.svelte.ts` holding everything the page knows. Not `Store` in `server/storage/store.ts`, which writes files. |
| **Sub-agent** | Any agent other than the lead. |
| **Subscribe** | A version 2 tab's `{t:'subscribe', convId}`: from then on it gets that conversation's detailed events. |
| **Team** | All agents in one conversation. |
| **Team map** | The page view that draws the team as a tree of cards. |
| **`TeamActions`** | What the team tools can do (`server/core/tools.ts`); implemented by `Conversation`. |
| **Team tools** | `send_message`, `list_agents`, `spawn_agent`, `stop_agent`, `set_effort`, `set_agent_effort`, defined once as backend-neutral `ToolDef`s by `teamToolDefs()`. |
| **Tick** | The machine event fed every 30 s (`TICK_MS`) while something needs watching: pause ends, run-time limit, background cap. |
| **Tier** | A level in a team profile (`TierSpec`): backend, model, effort, `max`, `lean`, colour. Tier *i* may start only tier *i*+1; the last starts nothing. |
| **Tier id** | A tier's unique id across all profiles (`TierId`). The `claude` profile keeps `lead`, `opus`, `sonnet`, `haiku` so 0.1.x conversations load unchanged; other profiles use `<profile>:<index>` from 0 (e.g. `codex:0`). |
| **Title** | A few words on an agent's job, given by whoever started it (`spawn_agent`'s `title`, at most 60 characters). |
| **Turn** | One round of work by the model, ending in a turn result (`SessionEvents.turnEnded`). |
| **Unanswered** | Ids of messages sent to an agent's session that no finished turn has consumed yet. |
| **Usage limit** | The account's usage cap reported by the backend. An agent that hits it pauses (see **Pause**); notices are passed to the page as `rate_limit`. |
| **Version 1 / version 2 tab** | A tab speaking the old protocol (0.1.x page, served by the adapter) or protocol 2 after `hello` with `protocol: 2`. See [Browser/server protocol](Browser-Server-Protocol.md). |
| **Wait reason** | The one reason shown for a held agent, by priority (`waitReason()`): `paused`, `approval` (running with an open approval), `answer`, `children`, `background`. |
| **Waiting** | Phase of an agent whose turn ended while a hold remains. |
| **Waiting for an answer** | A sub-agent that sent `send_message` with `wait: true` to its parent or the lead (`holds.answer`; `AgentInfo.waitingFor` names the recipient). If the recipient's turn ends without answering it is reminded once; a non-lead recipient that still does not answer, a recipient that ends, or the person interrupting the recipient releases the asker with "No answer from …". The lead's askers keep waiting. |
| **Wall clock** | `Clock.now()`: ordinary time, used for deadlines such as a usage limit's reset time. |
| **WebSocket** | The two-way connection between page and server at `/ws`. |
| **XDG** | The Linux convention for where programs keep config (`~/.config`) and data (`~/.local/share`). |

## Related pages

[Architecture](Architecture.md) · [State machine](State-Machine.md) · [Browser/server protocol](Browser-Server-Protocol.md) · [Team profiles and settings](Team-Profiles-and-Settings.md) · [Index](Index.md)
