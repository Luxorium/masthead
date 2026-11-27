# Walkthrough: an agent starting another

This follows the lead (`alpha`) starting its first Opus agent with `spawn_agent`; that agent will be named `bravo`. The same code runs when an Opus starts a Sonnet or a Sonnet starts a Haiku.

## The path

```mermaid
sequenceDiagram
  participant CC as Lead's Claude Code
  participant T as tools.ts (in-process MCP)
  participant C as Conversation
  participant N as New Agent (Opus)
  participant S as Scheduler
  participant CC2 as New Claude Code process
  CC->>T: mcp__masthead__spawn_agent {title, task, effort?}
  Note over CC,T: canUseTool → App allows mcp__masthead__* at once
  T->>C: spawn(alpha, title, task, effort)
  C->>C: checks; next phonetic name (bravo); clean title; start effort
  C->>N: new Agent(info: queued, owesReport, seed = task)
  C->>N: addItem(inbound task) ; start()
  N->>S: acquire('opus', id, owner = lead id)
  C-->>T: "Started Opus 5.5 agent "bravo" (title) at low effort…"
  T-->>CC: tool result (the lead carries on)
  alt slot free
    S-->>N: granted
  else all Opus slots busy
    N->>N: status queued (broadcast)
    S-->>N: granted later by pump()
  end
  N->>CC2: launch(): query() with seed as first message
  CC2-->>N: init, stream, …
```

## Step by step

1. **The call.** The lead's model calls `spawn_agent` with a `title` (a few words on the job, e.g. "Review the API layer"), a `task` and optionally an `effort`. Claude Code sends the call to the `masthead` MCP server built by `teamTools()` in `server/tools.ts`. It asks `canUseTool` first; `App.askPermission()` allows any `mcp__masthead__` tool without asking the person. The zod schema has already checked lengths (title ≤ 60, task ≤ 60,000) and that `effort` is one of the four levels.
2. **`Conversation.spawn(parent, rawName, task, effort)`** (`server/conversation.ts`):
   - `CHILD_TIER['lead']` is `opus`. A Haiku parent would get "Error: Haiku agents cannot start other agents." (it would not have the tool in the first place).
   - If the Opus `max` is 0: "Error: Opus 5.5 agents are switched off in the settings. Do this work yourself." ("Opus 5.5" is `label('opus')`, made from the configured model id.)
   - At 200 agents: an error suggesting reuse via `send_message`. Empty task: an error.
   - **Name:** `agentName(agents.size)`. The conversation holds only `alpha` so far, so this is `agentName(1)` = `bravo`; if that name were somehow taken it would try the next one.
   - **Title:** whitespace collapsed, trimmed, at most 60 characters.
   - **Effort:** with automatic effort on, `capEffort(effort ?? 'low', settings.tiers.opus.effort)`; off, the Opus level.
   - **Info:** `newInfo()` with the name and title, status `queued`, `parentId` = the lead, the task clipped to 400 characters as a preview, and the Opus model from settings.
   - **Agent:** `new Agent(info, this, { owesReport: true, seed: task })`. The full task is the seed: the first user message of its new session.
   - **Queue prediction:** `willQueue` = Opus running ≥ max, or anything already queued.
   - `addAgent()` broadcasts the new agent; an `inbound` item with `via: 'task'` records the task in its transcript; `agent.start()`; `touch()`.
   - Returns "Started Opus 5.5 agent "bravo" (Review the API layer) at low effort. Its report will arrive as a message when it finishes.", with "(queued: N may run at once)" added when predicted. The tool description told the lead that the reply names the new agent.
3. **The lead carries on.** The tool result goes back to the lead immediately; the lead's turn continues. It may start more agents or end its turn, in which case it becomes `waiting` because it has a live child ([Agent life cycle](Agent-Life-Cycle.md)).
4. **Slot.** `Agent.start()` → `ensureProcess()` → `scheduler.acquire('opus', id, leadId)`. If a slot is free and nobody is queued, it is granted at once and the agent never shows `queued`. Otherwise it shows `queued` and waits; when a slot frees, `pump()` picks the waiter whose parent has the fewest running Opus agents ([Slot scheduling](Slot-Scheduling.md)).
5. **Launch.** `launch()` creates the input channel with the seed first, builds options with the Opus model, the starting effort, the conversation folder, the team tools for an Opus (`send_message`, `list_agents`, `spawn_agent` for Sonnets, `stop_agent`, and with automatic effort `set_effort` and `set_agent_effort`), `AskUserQuestion` disallowed, and the system prompt from `systemAppend()` naming its parent. Status becomes `running`.
6. **On the page.** The `{t:'agent'}` broadcast for the new agent makes "Bravo" appear in the team panel's agent tree and in the team map under Alpha, with its title and the status Queued or Working. The lead's transcript shows the tool call as "Starting an agent: Review the API layer" while it runs and "Started an agent: …" once its result is in (`toolLine()`).
7. **Session.** The `init` message gives the session id; the seed is dropped since it is now in the session. From here the agent works like any other ([Sending a message](Walkthrough-Sending-a-Message.md), step 5).

When it finishes, its report goes back up: [A report coming back](Walkthrough-Report-Coming-Back.md).

## Related pages

[Team rules](Team-Rules.md) · [server/conversation.ts](Source-Conversation.md) · [server/tools.ts](Source-Tools.md) · [Slot scheduling](Slot-Scheduling.md)
