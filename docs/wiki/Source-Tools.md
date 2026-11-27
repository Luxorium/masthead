# server/tools.ts

**Role:** builds the tools an agent uses to work with the rest of its team. They are served by an **in-process MCP server**: the Agent SDK's `createSdkMcpServer()` makes a tool server that lives inside the Masthead process. When Claude Code calls one of these tools, the call runs as a JavaScript function in the server, with direct access to the `Conversation`. No separate program is involved.

In Claude Code the tools appear as `mcp__masthead__<name>`. Three settings make them always available:

- They are always loaded into the prompt (`alwaysLoad: true`) instead of being hidden behind tool search.
- They are pre-approved: `allowedTools: ['mcp__masthead']` in `Agent.launch()`.
- `App.askPermission()` allows them without asking the person.

Pre-approving them makes the SDK print a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning, which Masthead silences on purpose (see [server/main.ts](Source-Main.md)). The server's version is `VERSION`.

## `TeamActions`

The interface the tools call. `Conversation` implements it, and every method returns the text the agent sees.

```ts
spawn(parent, title, task, effort?)   message(from, to, text)   list(viewer)
stop(caller, name)   setOwnEffort(agent, level, reason)   setAgentEffort(caller, name, level)
autoEffort()   label(tier)
```

`label(tier)` returns the configured model's readable name (`modelLabel`), so tool descriptions say "Start a Sonnet 5.5 agent" or whatever the settings name.

## `reply(text)`

Wraps a string as an MCP tool result. If the text starts with `Error:`, the result is marked `isError`, which tells the model the call failed. Every `Conversation` method follows that convention.

## `teamTools(agent, team)`

Builds the tool list for one agent. The list depends on the agent's tier and on the settings at launch time:

| Tool | Who gets it | Input | Calls |
|---|---|---|---|
| `send_message` | everyone | `to` (1–80 characters), `message` (1–20,000) | `team.message()` |
| `list_agents` | everyone | none | `team.list()` |
| `spawn_agent` | lead, Opus, Sonnet (tiers that have a child tier) | `title` (1–60 characters, "a few words on its job, shown to the person"), `task` (1–60,000), `effort?` | `team.spawn()` |
| `stop_agent` | lead, Opus, Sonnet | `name` (1–80) | `team.stop()` |
| `set_effort` | everyone, when automatic effort is on | `level`, `reason` (1–500) | `team.setOwnEffort()` |
| `set_agent_effort` | lead, Opus, Sonnet, when automatic effort is on | `name`, `level` | `team.setAgentEffort()` |

The input shapes are **zod** schemas. Zod is a library that describes and validates data; the SDK turns these schemas into the tool's JSON schema for the model and checks each call against them. `level` and `effort` use `effortSchema`, which is built from `EFFORTS`, so `max` is not accepted.

The tool descriptions are written for the model:

- **`spawn_agent`** says the new agent gets the next name from the phonetic alphabet, and that the reply says which name.
- **`send_message`** gives an example name ("charlie") and mentions the aliases "lead" and "parent".
- **`stop_agent`** says it is only for work that is no longer wanted: a stopped agent sends no report, so it must never be used to wait for or collect a result.
- **`set_effort`** depends on the tier. The lead is told it changes its own effort directly. Everyone else is told that raising needs approval, and to keep working at the current level until told the outcome.

## Two layers of enforcement

`teamTools()` leaves out the tools an agent may not use, so the model never sees them. The `Conversation` methods check again anyway (tier, ancestry, limits, settings), because the tool list is fixed when a process launches while the settings can change afterwards. For example, if automatic effort is switched off while an agent is running, the agent still has `set_effort`, but calling it returns "Error: automatic effort is switched off in the settings."

## Related pages

[Team rules](Team-Rules.md) · [server/conversation.ts](Source-Conversation.md) · [Thinking effort](Thinking-Effort.md)
