# Glossary

Terms used in the code and this wiki, in alphabetical order. Code names are in backticks.

| Term | Meaning |
|---|---|
| **Agent** | One member of a team: a Claude Code session plus Masthead's record of it. Class `Agent` in `server/agent.ts`; record `AgentInfo` in `shared/protocol.ts`. |
| **Agent name** | The short name every agent gets, in order, from the radio spelling alphabet: `alpha` (the lead), `bravo`, `charlie`, … `zulu`, then `alpha-2`. Shown capitalised ("Bravo"). See `agentName()`. |
| **Agent SDK** | `@anthropic-ai/claude-agent-sdk`, the library Masthead uses to start and talk to Claude Code (`query()`), and to define in-process tools (`tool()`, `createSdkMcpServer()`). |
| **`AgentHost`** | Interface for what an `Agent` needs from its owner; implemented by `Conversation`. |
| **Ancestor** | An agent's parent, its parent's parent, and so on up to the lead. Checked by `isAncestor()`. Ancestors may stop agents below them and set their effort. |
| **Automatic effort** (`autoEffort`) | Setting: agents start at low effort and manage it with tools; tier effort settings become ceilings. See [Thinking effort](Thinking-Effort.md). |
| **Backlog** | Messages an agent accepted while it had no process; handed to the next process at launch. |
| **Breadcrumbs** | The "Alpha / Bravo / Charlie" path shown above a sub-agent's chat in the page. |
| **Broadcast** | Sending a server message to every connected browser tab (`App.broadcast()`). |
| **Busy** | An agent that has been sent something no finished turn has answered yet, or that is starting (`Agent.busy`). |
| **Ceiling** | With automatic effort on, the highest effort level a tier may reach, set by the person. |
| **Channel** | The async queue used as an agent's input stream (`Channel` in `server/agent.ts`). |
| **Child / parent** | The agent another agent started, and the agent that started it (`AgentInfo.parentId`). |
| **Claude Code** | Anthropic's command-line coding agent (`claude`), installed and signed in by the person. Masthead runs it; it never handles its login. |
| **`ClientMsg` / `ServerMsg`** | The message types browser → server and server → browser. See [Browser/server protocol](Browser-Server-Protocol.md). |
| **Conversation** | One chat: a lead and every agent started under it, with a working folder (`cwd`). Class `Conversation`; record `ConversationMeta`. |
| **`ConversationHost`** | Interface for what a `Conversation` needs from the app; implemented by `App`. |
| **CSP** | Content-Security-Policy: a response header telling the browser what the page may load and connect to. See [Security model](Security-Model.md). |
| **cwd** | "Current working directory": the folder a conversation's agents work in. |
| **Dispose** | `Agent.dispose()`: end an agent's process and return its slot without changing its recorded status. Used at shutdown. |
| **DNS rebinding** | An attack that makes an outside page appear same-origin with a local server. Defeated by the Host header check. |
| **DOMPurify** | The library the page uses to clean model-written HTML before showing it. |
| **Draft** | The text or thinking an agent is writing right now, streamed to the page and not saved (`Draft`). |
| **Effort** | How much the model reasons: `low`, `medium`, `high`, `xhigh` (Extra). No `max`. |
| **Effort request** | A message a sub-agent's `set_effort` sends to its parent asking for a higher level. |
| **Envelope** | The `<agent-report>` or `<agent-message>` tags wrapping text from another agent (`server/prompts.ts`). |
| **Inbound item** | A transcript entry for something from another agent: a task, report or message (`kind: 'inbound'`). |
| **Interrupt** | Ending an agent's current turn while keeping its process and session. Used for the lead. |
| **Item** | One transcript entry (`Item`): user text, agent text, thinking, tool call, inbound, or notice. |
| **JSONL** | JSON Lines: a text file with one JSON value per line. Used for transcripts. |
| **Lead** | The top agent of a conversation, the one the person talks to, always named `alpha` (Fable 5.2 by default). `lead` also works as an alias in `send_message`. |
| **Lean sub-agents** (`leanSubagents`) | Setting: Sonnet and Haiku agents get only Masthead's MCP server, not the person's own. |
| **Live** | Status `queued`, `running` or `waiting`. |
| **MCP / MCP server** | Model Context Protocol: a standard way to give Claude Code extra tools. Masthead's team tools are an in-process MCP server named `masthead`. |
| **`modelLabel()`** | Turns a model id into the name people use: `claude-opus-5-5` → "Opus 5.5". Tier names everywhere come from it. |
| **Owes a report** (`owesReport`) | The agent must send its parent a report when it next finishes. |
| **Owner** | In the scheduler, the parent id a slot request is made for; used for fair queueing. |
| **Permission mode** | Claude Code's policy for asking before acting (`inherit`, `default`, `acceptEdits`, `auto`, `bypassPermissions`). |
| **Permission request** | A tool approval or a question shown to the person (`PermissionRequest`). |
| **Process** | The running `claude` program behind an agent (the SDK `Query`, `Agent.q`). |
| **Report** | A sub-agent's final message, delivered to its parent in an `<agent-report>` envelope. |
| **Resume** | Starting a new process that continues an existing Claude Code session (`options.resume = sessionId`). |
| **Seed** | The first message of a brand-new agent session: its task. Saved to disk while the agent has not started (`pendingSeed`). |
| **Session** | Claude Code's saved conversation history for one agent (`sessionId`). Survives the process and app restarts. |
| **Settle** | Moving on an agent that was only waiting for children that ended without a report (`Conversation.settle()`). |
| **Slot** | Permission to run one agent of a tier; limited by the tier's `max`. See [Slot scheduling](Slot-Scheduling.md). |
| **Slug** | A name reduced to lower-case letters, digits and hyphens. Used when looking up agent names typed by agents. |
| **Status** | `queued`, `running`, `waiting`, `idle`, `done`, `failed`, `stopped`. See [Agent life cycle](Agent-Life-Cycle.md). |
| **Store (page)** | The single object in `web/src/lib/store.svelte.ts` holding everything the page knows. Not to be confused with `Store` in `server/store.ts`, which writes files. |
| **Sub-agent** | Any agent other than the lead. |
| **Svelte / runes** | The front-end framework; runes (`$state`, `$derived`, `$effect`) mark reactive values. |
| **systemd user unit** | A service managed by Linux's systemd for one user. The launcher uses `masthead.service` if it exists. |
| **Team** | All agents in one conversation. |
| **Team map** | The page view that draws the team as a tree of cards, with a hover preview of each agent's chat. |
| **Team panel** | The right-hand column of the page: limits, effort, permissions, context use and the agent list. |
| **`TeamActions`** | Interface for what the team tools can do; implemented by `Conversation`. |
| **Tier** | An agent's level: `lead`, `opus`, `sonnet`, `haiku`. Each may start only the next one down. |
| **Title** | A few words on an agent's job, given by the agent that started it (`spawn_agent`'s `title`); shown beside its name. |
| **Turn** | One round of work by the model, ending in a `result` message. |
| **Unanswered** | Ids of messages sent to an agent that no finished turn has consumed yet. |
| **Waiting** | Status of an agent whose turn ended while agents it started are still live. |
| **WebSocket** | A two-way connection that stays open between page and server, at `/ws`. |
| **XDG** | The Linux convention for where programs keep config (`~/.config`) and data (`~/.local/share`). |
