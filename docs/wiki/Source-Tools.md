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
spawn(parent, title, task, effort?)   message(from, to, text, wait?)   list(viewer)
stop(caller, name)   setOwnEffort(agent, level, reason)   setAgentEffort(caller, name, level)
autoEffort()   label(tier)
```

`label(tier)` returns the configured model's readable name (`modelLabel`), so tool descriptions say "Start a Sonnet 5.5 agent" or whatever the settings name; the article comes from `withArticle()` in `server/prompts.ts` ("Start an Opus 5.5 agent").

## `reply(text)`

Wraps a string as an MCP tool result. If the text starts with `Error:`, the result is marked `isError`, which tells the model the call failed. Every `Conversation` method follows that convention.

## `teamTools(agent, team)`

Builds the tool list for one agent. The list depends on the agent's tier and on the settings at launch time:

| Tool | Who gets it | Input | Calls |
|---|---|---|---|
| `send_message` | everyone | `to` (1–80 characters), `message` (1–20,000); for every agent but the lead also `wait?` (boolean) | `team.message()` |
| `list_agents` | everyone | none | `team.list()` |
| `spawn_agent` | lead, Opus, Sonnet (tiers that have a child tier) | `title` (1–60 characters, "a few words on its job, shown to the person"), `task` (1–60,000), `effort?` | `team.spawn()` |
| `stop_agent` | lead, Opus, Sonnet | `name` (1–80) | `team.stop()` |
| `set_effort` | everyone, when automatic effort is on | `level`, `reason` (1–500) | `team.setOwnEffort()` |
| `set_agent_effort` | lead, Opus, Sonnet, when automatic effort is on | `name`, `level` | `team.setAgentEffort()` |

The input shapes are **zod** schemas. Zod is a library that describes and validates data; the SDK turns these schemas into the tool's JSON schema for the model and checks each call against them. `level` and `effort` use `effortSchema`, which is built from `EFFORTS`, so `max` is not accepted.

The tool descriptions are written for the model:

- **`spawn_agent`** says the new agent gets the next name from the phonetic alphabet, and that the reply says which name.
- **`send_message`** gives an example name ("charlie") and mentions the aliases "lead" and "parent". Its `wait` input (not offered to the lead) is described as: "You need the answer to continue: end your turn and you resume when it arrives. Parent or lead only".
- **`stop_agent`** says it is only for work that is no longer wanted: a stopped agent sends no report, so it must never be used to wait for or collect a result.
- **`set_effort`** says low is right for most work (the agent's actual level is in its system prompt) and depends on the tier. The lead is told it changes its own effort directly. Everyone else is told that raising needs approval, to keep working at the current level, and ends: "If approved, the new level applies by itself from your next step; no message is sent. list_agents shows your current effort."

## `send_message` and `wait`

Only non-lead agents get the `wait` input; the lead's schema has just `to` and `message`, because the lead is never left waiting for an answer. The handler reads it with a cast (`(a as { wait?: boolean }).wait === true`) because the two schemas give `a` different types, and passes it to `team.message()`.

`Conversation.message()` then decides whether the wait counts: only a sub-agent may wait, and only for its **parent or the lead**, who are bound to see the question. If it counts, the sender is marked as waiting for the target, the target's envelope gets the `'wait'` hint (see [server/prompts.ts](Source-Prompts.md)), and the reply ends "End your turn when you have nothing else to do; you resume when the answer arrives." If a sub-agent asks to wait for anyone else, the message is still delivered but nobody waits, and the reply ends "(Not waiting: you can wait only for your parent or the lead.)"

## Callers

`Conversation.tools(agent)` calls `teamTools(agent, this)`; `Agent.launch()` gets the result through its host and passes it as `mcpServers: { masthead: … }`. `Conversation` is the only implementation of `TeamActions`. The tool list is built once per launch.

## Two layers of enforcement

`teamTools()` leaves out the tools an agent may not use, so the model never sees them. The `Conversation` methods check again anyway (tier, ancestry, limits, settings), because the tool list is fixed when a process launches while the settings can change afterwards. For example, if automatic effort is switched off while an agent is running, the agent still has `set_effort`, but calling it returns "Error: automatic effort is switched off in the settings."

## Related pages

[Team rules](Team-Rules.md) · [server/conversation.ts](Source-Conversation.md) · [Thinking effort](Thinking-Effort.md)
