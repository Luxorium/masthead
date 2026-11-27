# server/core/tools.ts

**Role:** defines the **team tools** an agent uses to work with the rest of its team (`send_message`, `list_agents`, `spawn_agent`, `stop_agent`, `set_effort`, `set_agent_effort`). Since 0.2.0 the definitions are written once and are **backend-neutral**: each is a `ToolDef` (`server/backends/types.ts`: `name`, `description`, `input` as a JSON Schema, and `run(input) → Promise<string>`), and each backend binds them its own way (see [Backend interface](Backend-Interface.md)):

- **Claude Code**: `mcpServer()` in `server/backends/claude/mcp.ts` turns the JSON Schemas back into zod shapes and serves the tools from an in-process MCP server named `masthead` (`alwaysLoad: true`), so the model sees them as `mcp__masthead__<name>`. A result whose text starts with `Error:` is marked `isError`. See [Claude backend](Source-Backend-Claude.md).
- **Codex**: dynamic tools; a result starting with `Error:` is returned with `success: false`. See [Codex backend](Source-Backend-Codex.md).
- **Fake backend** (tests): calls `run()` directly. See [Fake backend](Source-Backend-Fake.md).

Every call goes through the conversation, which enforces the tiers and limits. The file comment notes that descriptions are paid for on every request, so they are kept short.

## `TeamActions`

The interface the tools call. `Conversation` (`server/core/conversation.ts`) is the only implementation; every action returns the text the agent sees, starting with `Error:` when the call failed.

| Member | Purpose |
|---|---|
| `spawn(parent, title, task, effort)` | `spawn_agent` |
| `message(from, to, text, wait?)` | `send_message` |
| `list(viewer)` | `list_agents` |
| `stop(caller, name)` | `stop_agent` |
| `setOwnEffort(agent, level, reason)` | `set_effort` |
| `setAgentEffort(caller, name, level)` | `set_agent_effort` |
| `autoEffort()` | Whether automatic effort is on (decides the effort tools). |
| `label(tier)` | The tier's readable name, from its profile; used in the `spawn_agent` description with `withArticle()` from `server/core/prompts.ts` ("Start an Opus 5.5 agent"). |
| `childTier(tier)` | The tier an agent of `tier` may start, from its team profile; null for the last tier. |
| `caps?(agent)` | The agent's backend capabilities (`efforts`); all levels when not given. |

What each action checks and replies is on [server/core/conversation.ts](Source-Core-Conversation.md#teamactions-implementation).

## Private helpers

- `str(min, max, description?)`: a string schema with `minLength` / `maxLength`.
- `object(properties, required)`: an object schema with `additionalProperties: false`.
- `s(v)`: reads an argument as a string, `''` if it is not one. A guard only: the schema already says what it must be.

## `teamToolDefs(agent, team)`

Builds the tool list for one agent. Inside it:

- `child = team.childTier(agent.tier)`; `isLead` = `agent.info.parentId === null`.
- `levels`: the backend's effort levels (`team.caps?.(agent)?.efforts`, else all of `EFFORTS`), kept only if they are in `EFFORTS`, so there is never a `max` level.
- `effort(description?)`: an enum schema over `levels`; `level(v)` returns `v` if it is one of `levels`, else `undefined`.
- `add(name, description, input, run)`: pushes a `ToolDef` whose `run` passes the raw input (or `{}`) to the handler.

| Tool | Who gets it | Input | Calls |
|---|---|---|---|
| `send_message` | everyone | `to` (1–80 characters), `message` (1–20,000); for sub-agents also `wait` (boolean) | `team.message(agent, to, message, wait === true)` |
| `list_agents` | everyone | none | `team.list(agent)` |
| `spawn_agent` | agents whose tier has a child tier | `title` (1–60), `task` (1–60,000), `effort` (only if the backend has effort levels) | `team.spawn()`, with an unknown effort read as left out |
| `stop_agent` | agents whose tier has a child tier | `name` (1–80) | `team.stop()` |
| `set_effort` | everyone, when automatic effort is on and the backend has effort levels | `level`, `reason` (1–500) | `team.setOwnEffort()`, or "Error: unknown effort level." |
| `set_agent_effort` | as `set_effort`, and only with a child tier | `name` (1–80), `level` | `team.setAgentEffort()`, or "Error: unknown effort level." |

The tool descriptions, as the model reads them:

- **`send_message`**: "Send a short message to another agent in this conversation by name, e.g. "charlie" ("lead" and "parent" also work). A finished agent resumes with its context to read it. Use it to ask a question, pass on a finding or answer a message. It returns once delivered; any answer arrives later as a message." The `wait` input: "You need the answer to continue: end your turn and you resume when it arrives. Parent or lead only".
- **`list_agents`**: "List the agents in this conversation: name, tier, status, effort, who started each and its task."
- **`spawn_agent`**: "Start a <label> agent on a task. It knows only what you write in "task". It is given the next name from the phonetic alphabet (bravo, charlie, …); the reply tells you which. Returns at once; the agent's report arrives later as an <agent-report> message." `title`: "A few words on its job, shown to the person, e.g. "Review the API layer"". `task`: "Everything the agent needs: goal, paths, constraints, what to send back". `effort`: "Thinking effort to start at. Leave out for low; raise only for work that needs careful reasoning".
- **`stop_agent`**: "Stop an agent you started, or one started below it, together with everything under it. Only for work that is no longer wanted: a stopped agent sends no report. Never use it to wait for or collect a result."
- **`set_effort`**: for the lead, "Change your own thinking effort from your next step on. Low is right for most work. Raise it when …; lower it again afterwards. Change it at the start of a piece of work, not repeatedly." For others, "Ask to change your own thinking effort. Low is right for most work. Lowering applies at once. Raising needs the approval of the agent that started you: this sends the request and returns; keep working at your current level. If approved, the new level applies by itself from your next step; no message is sent. list_agents shows your current effort." `reason`: "One sentence on why".
- **`set_agent_effort`**: "Set the thinking effort of an agent you started, or of one started below it. Use it to approve or adjust an effort request, or to raise or lower effort as the work changes."

## `send_message` and `wait`

Only sub-agents get the `wait` input; the lead's schema has just `to` and `message`, because the lead is never left waiting for an answer. `Conversation.message()` then decides whether the wait counts: only a sub-agent may wait, and only for its **parent or the lead**, who are bound to see the question. If it counts, the sender gets an answer hold in its machine state (see [server/core/machine.ts](Source-Core-Machine.md)), the target's envelope gets the `'wait'` hint (see [server/core/prompts.ts](Source-Core-Prompts.md#messageenvelopefrom-tier-text-hint)), and the reply ends "End your turn when you have nothing else to do; you resume when the answer arrives." A wait for anyone else is not honoured: the message is still delivered and the reply ends "(Not waiting: you can wait only for your parent or the lead.)"

## Callers

`Conversation.tools(agent)` returns `teamToolDefs(agent, this)`; `Agent.launch()` (`server/runtime/agent.ts`) passes the result as the session's `tools` to `backend.open()`. The list is built once per launch.

## Two layers of enforcement

`teamToolDefs()` leaves out the tools an agent may not use, so the model never sees them. The `Conversation` methods check again anyway (tier, ancestry, limits, settings), because the tool list is fixed when a process launches while the settings can change afterwards. For example, if automatic effort is switched off while an agent is running, the agent still has `set_effort`, but calling it returns "Error: automatic effort is switched off in the settings."

## Tests

`test/prompts.test.ts` ("tools: one neutral definition per agent; spawn only with a child tier; effort tools only with levels"). The actions behind the tools are tested in `test/conversation.test.ts`. Read for this page, not run.

## Related pages

[Team rules](Team-Rules.md) · [server/core/conversation.ts](Source-Core-Conversation.md) · [server/core/prompts.ts](Source-Core-Prompts.md) · [Backend interface](Backend-Interface.md) · [Thinking effort](Thinking-Effort.md)
