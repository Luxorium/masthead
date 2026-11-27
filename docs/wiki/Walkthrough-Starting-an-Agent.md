# Walkthrough: an agent starting another

This follows the lead (`alpha`) starting its first agent with `spawn_agent`, in a conversation on the Claude team profile; the new agent will be named `bravo` and run on the second tier (`opus`). The same code runs at every level, on every profile: an agent may only start the tier directly below its own in its profile. It describes version 0.2.0 (branch `next`). Line numbers are file-relative and were checked on 2026-11-27; the code was still changing, so search for the function name if a line has moved.

## The path

```mermaid
sequenceDiagram
  participant L as Lead's session (backend)
  participant T as Team tools (tools.ts ToolDef)
  participant C as Conversation
  participant M as machine.ts
  participant N as Agent "bravo" (runtime)
  participant S as Scheduler
  participant R as App.backend() → registry
  participant B as bravo's session
  L->>T: spawn_agent {title, task, effort?}<br/>(Claude: mcp__masthead__spawn_agent; Codex: item/tool/call)
  T->>C: spawn(alpha, title, task, effort)
  C->>C: checks; next name (bravo); title; start effort
  C->>M: initial(false): queued, owes a report
  C->>N: new Agent(info, seed = task); addItem(inbound task); start()
  C-->>T: "Started … agent "bravo" … at low effort…"
  T-->>L: tool result (the lead carries on)
  N->>S: acquire(tier, id, owner = alpha)
  alt slot free and nobody queued
    S-->>N: granted at once
  else
    N->>N: status queued (published)
    S-->>N: granted later by pump()
  end
  N->>R: backendFor() → host.backend(tier)
  R-->>N: the Backend for the tier's `backend` id
  N->>B: backend.open(spec, events); send(seed)
  B-->>N: sessionStarted, turns…, turnEnded
  N->>C: turnEnded → machine TurnEnded → done, report effect
  C->>L: report(): inbound item + <agent-report> delivered to the lead
```

## Step by step

### 1. The tool reaches the agent's backend

When an agent's session is opened, `Agent.launch()` (`server/runtime/agent.ts`, line 341) passes `tools: this.toolsForSession()` (line 383), which asks its host for `tools(agent)`. `Conversation.tools()` (`server/core/conversation.ts`, line 449) returns `teamToolDefs(agent, this)` (`server/core/tools.ts`, line 33): backend-neutral `ToolDef`s (name, description, JSON Schema, `run`), bound to that agent. `spawn_agent` (line 59) is added only when `childTier()` finds a tier below the agent's in its profile; its `run` calls `team.spawn(agent, title, task, effort)` (line 69). Its schema: `title` 1–60 characters, `task` 1–60,000, `effort` one of the levels the backend has (left out when it has none).

Each backend binds the same definitions its own way:

- **Claude Code:** `ClaudeSession.options()` (`server/backends/claude/session.ts`, line 172) passes `mcpServers: { masthead: mcpServer(s.tools) }` (line 180). `mcpServer()` (`server/backends/claude/mcp.ts`, line 52) turns each `ToolDef` into an SDK tool with a zod shape (`zodShape`) and builds an **in-process** MCP server with `createSdkMcpServer` (line 60). The model sees `mcp__masthead__spawn_agent`. When it calls it, `canUseTool()` (line 239) allows any `mcp__masthead__` tool without asking the person; the tool's handler runs `d.run(args)` and returns its text, marked as an error when it starts with `Error:`.
- **Codex:** `thread/start` carries `dynamicTools` built from the same `ToolDef`s (`server/backends/codex/index.ts`, line 347). A call arrives as the server request `item/tool/call` (line 540) and `toolCall()` (line 756) runs the matching `ToolDef`, answering with its text (`success: false` for an `Error:` text). Team tools never ask the person.

See [Backend interface](Backend-Interface.md) and [server/backends/claude/](Source-Backend-Claude.md).

### 2. `Conversation.spawn()` (`conversation.ts`, line 745)

- `childTierOf(settings, parent.tier)` (`shared/protocol.ts`, line 68) gives the tier below the parent's in its profile (`lead` → `opus` on the Claude profile; `codex:0` → `codex:1` on the Codex one). None: "Error: … agents cannot start other agents."
- The child tier's `max` is 0: "Error: … agents are switched off in the settings. Do this work yourself." At 200 agents (`MAX_AGENTS`): an error suggesting `send_message`. An empty task: an error. Tier names in these texts come from `label()`: the profile's label or the model's name.
- **Name:** the next phonetic name not in use (`agentName(this.agents.size)`, then onward), here `bravo`. **Title:** whitespace collapsed, at most 60 characters.
- **Effort:** with automatic effort on, `capEffort(effort ?? 'low', ceiling)`, where the ceiling is the tier's effort in the profile; off, the tier's effort.
- **Info:** `newInfo()`: status `queued`, `parentId` = the lead, the model from the tier's spec, the task clipped to 400 characters as a preview.
- `new Agent(info, this, { owesReport: true, seed: task })` (line 763): the full task is the **seed**, the first message of its new session.
- **Machine:** `this.states.set(agent.id, initial(false))` (line 764): phase `queued`, `owesReport: true` (`server/core/machine.ts`, `initial()`, line 115). This is the state of machine row 1 ("Spawned → queued, owes a report", `case 'Spawned'`, line 242); `spawn()` sets it directly rather than sending a `Spawned` event. See [State machine](State-Machine.md).
- `willQueue` = the tier's running count ≥ its max, or anything already queued (`scheduler.running()`/`queued()`).
- `addAgent()` publishes the new agent; an `inbound` item with `via: 'task'` records the task in its transcript; `agent.start()` (line 768); `touch()`.
- Returns "Started <label> agent "bravo" (<title>) at low effort. Its report will arrive as a message when it finishes.", with "(queued: N may run at once)" when predicted. This text is the tool result; the lead's turn carries on. If the lead ends its turn while bravo is live, it becomes `waiting`.

### 3. Runtime start and the slot

`Agent.start()` (`agent.ts`, line 244) calls `ensureProcess()` (line 293), which calls `scheduler.acquire(tier, id, owner)` (line 299) with `owner` = the parent's id (`server/core/scheduler.ts`, `acquire()`, line 72). If there is room and nobody is queued it resolves at once and the agent never shows `queued`; otherwise a microtask sets the status `queued` and the request waits until `pump()` (line 112) picks it: the waiter whose parent has the fewest running agents of that tier, first come first served within one parent. A tier at 0 refuses at once with `TierOff`; the agent fails and reports. If the agent is stopped while it waits, it is never launched and the slot is given back. See [server/core/scheduler.ts](Source-Core-Scheduler.md) and [Slot scheduling](Slot-Scheduling.md).

### 4. The backend, chosen by tier

`launch()` calls `backendFor()` (line 333) → `host.backend(this)` → `Conversation.backend()` (`conversation.ts`, line 433) → `App.backend(tier)` (`server/app/app.ts`, line 101): `this.registry.get(findTier(settings, tier)?.backend ?? 'claude-code')`. `BackendRegistry.get()` (`server/backends/registry.ts`, line 90) returns the fake backend for everything when it was selected on purpose (`MASTHEAD_BACKEND=fake` with `MASTHEAD_ALLOW_FAKE=1`), nothing when that backend was detected as unavailable, else the backend. With no backend, the slot is released and the agent fails with "No agent backend is available…".

### 5. Opening the session

`launch()` reads the tier's model and effort from the profile (`tierSettings()`), caps the agent's effort to the tier's ceiling, puts the seed first in the messages to send, and calls `backend.open(spec, this.events())` (line 375). The spec carries the model, effort, the conversation folder, `instructions` from `systemAppend()` (its name, tier label, parent, effort and the backend's capabilities), the team tools for its tier, `canAskPerson` only for the lead, the permission mode and `lean`. Then each message is `session.send()`-ed and the status becomes `running` (line 400). The runtime's `setStatus()` calls `host.agentChanged()`; `Conversation.agentChanged()` (line 452) runs a `Status` event so the machine follows (`queued` → `running`), and `App` publishes `{t:'agent'}` (the page shows bravo in the team panel and map).

For Claude Code, `ClaudeBackend.open()` creates a `ClaudeSession`, whose constructor calls the SDK's `query({prompt: channel, options})`; `send()` pushes the seed into that channel. The first `init` gives the session id (`onSessionStarted()`, `agent.ts`, line 465), and the seed is dropped since it is now in the session. From here bravo works like any agent: see [Walkthrough: sending a message](Walkthrough-Sending-a-Message.md), steps 6–9.

### 6. The report back

When bravo's turn ends with nothing holding it, `Conversation.turnEnded()` (line 478) runs `TurnEnded` (`machine.ts`, line 260, row 7): `finish('done', text)` (line 190) ends it and, because it owes a report, adds a `report` effect (plus `setEffortLow` with automatic effort). `exec()` runs the `end` effect (`Agent.end()`, `agent.ts`, line 732: closes the session and releases the slot, which lets the scheduler start the next waiter) and the `report` effect (`conversation.ts`, line 601) → `report()` (line 643): an `inbound` item with `via: 'report'` in the lead's transcript, and `deliverTo()` (line 629) sends the lead an `<agent-report from="bravo" …>` envelope, which wakes it for a new turn. Details: [Walkthrough: a report coming back](Walkthrough-Report-Coming-Back.md).

## Related pages

[State machine](State-Machine.md) · [server/runtime/agent.ts](Source-Runtime.md) · [Backend interface](Backend-Interface.md) · [server/backends/claude/](Source-Backend-Claude.md) · [server/core/tools.ts](Source-Core-Tools.md) · [server/core/conversation.ts](Source-Core-Conversation.md) · [Team rules](Team-Rules.md) · [Slot scheduling](Slot-Scheduling.md)
