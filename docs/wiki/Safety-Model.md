# Safety model: how the agents are kept in hand

Masthead runs many Claude Code sessions at once, and each one can run commands and change files as the person. This page explains what the code does to keep that team bounded, visible and stoppable, and what it does not do. It is about the agents. Who may reach the server at all is covered in [Security model](Security-Model.md).

Every statement below was read from the code at 0.1.4 and names the file and function. Unless a line says otherwise, it was **not** checked by running Masthead. The unit tests that cover a rule are listed in [Tests](Source-Tests.md).

## 1. Fixed tiers: who may start whom

There are four tiers. Each tier may start only the tier directly below it (`CHILD_TIER` in `shared/protocol.ts`):

| Tier | May start |
|---|---|
| lead (one per conversation, started by the person) | Opus agents |
| opus | Sonnet agents |
| sonnet | Haiku agents |
| haiku | nobody |

How the code enforces this:

- `Conversation.spawn()` (`server/conversation.ts`) looks the child tier up from the caller's tier and refuses with "Haiku agents cannot start other agents" when there is none. An agent cannot pick a tier.
- `teamTools()` (`server/tools.ts`) leaves `spawn_agent` and `stop_agent` out of a Haiku agent's tools altogether, so the refusal is a second line of defence.
- Claude Code's own ways of starting sub-agents or work elsewhere are disabled (section 3), so `spawn_agent` is the only way to start an agent.

## 2. Limits per tier and the queue

- The team panel sets "At once" for each tier below the lead (`Settings.tiers[tier].max`, clamped to 0..12 by `sanitizeSettings()` in `server/config.ts`; `MAX_PER_TIER` in `shared/protocol.ts`). The default is 3 Opus, 4 Sonnet and 4 Haiku (`defaultSettings()`).
- The limit counts across **every conversation**. One `Scheduler` (`server/scheduler.ts`) belongs to the `App` and is shared by all conversations.
- An agent asks for a slot before its process starts (`Agent.start()`, `Scheduler.acquire()`). If none is free it waits in a queue with status `queued`. When a slot frees, the request whose parent has the fewest running agents of that tier goes first, so one busy parent cannot starve the others (`Scheduler` class comment).
- An agent that is waiting for agents it started keeps its slot.
- The lead is never limited (`Scheduler.cap()` returns `Infinity` for `lead`).
- Setting a tier to **Off** (0):
  - `spawn()` refuses new agents of that tier;
  - queued ones are failed with `TierOff`;
  - `message()` and `userSend()` refuse to wake an agent of that tier. For `userSend()` the refusal is a notice in the transcript.

## 3. Claude Code tools that are switched off

`Agent.launch()` (`server/agent.ts`) passes `disallowedTools: DISALLOWED` to every agent, plus `AskUserQuestion` for every agent except the lead. The list and the reason for each group:

| Tools | Why they are off |
|---|---|
| `Agent`, `Task`, `Workflow` | Claude Code's own sub-agents and workflows would start work outside the tiers, the limits and the team map. |
| `SendMessage`, `ListAgents` | Claude Code's own agent messaging; Masthead's `send_message` and `list_agents` go through `Conversation`. |
| `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree` | The code gives no reason. Plan mode works through approval steps in Claude Code's own interface, and worktrees move the agent out of the conversation's folder; neither fits a team the person watches from Masthead. |
| `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`, `SendToProject`, `SendToProjectContext`, `PushNotification` | Ways to start work later or elsewhere, outside the team: scheduling, remote runs, other projects, phone pushes (comment in `DISALLOWED`). |
| `AskUserQuestion` (all but the lead) | Only the lead talks to the person. A sub-agent asks its parent with `send_message` (`systemAppend()` in `server/prompts.ts`). |

Skills: Masthead does not filter the person's skills. A skill whose instructions tell the agent to use one of the tools above finds that tool switched off.

## 4. Team tools run inside the server

Masthead's own tools (`send_message`, `list_agents`, `spawn_agent`, `stop_agent`, `set_effort`, `set_agent_effort`) are an in-process MCP server built by `teamTools()` (`server/tools.ts`). Each tool is a thin wrapper around a `TeamActions` method that `Conversation` implements, so **every start, message, stop and effort change goes through `Conversation`**, which applies the rules on this page.

- These calls are allowed without asking the person. `App.askPermission()` returns `allow` for names that start with `mcp__masthead__`, and `launch()` lists `mcp__masthead` in `allowedTools`. They are safe to allow because they can only act on the team, under the checks here.
- Tool arguments are checked with zod schemas before `Conversation` sees them. Section 9 lists the sizes.

## 5. Approvals and permission modes

Claude Code asks before some tool calls. The SDK routes each question to `canUseTool`, which Masthead points to `App.askPermission()`, which shows a card in every open tab and waits for an answer. Full detail: [Permissions and questions](Permissions-and-Questions.md).

The "Permissions" setting (`permissionMode`, applied in `Agent.launch()`):

| Setting | What happens |
|---|---|
| `inherit` (default) | Masthead passes no mode, so Claude Code follows the person's own Claude Code settings and rules. |
| `default` | Claude Code's normal mode: it asks before edits and commands that its rules do not already allow. |
| `acceptEdits` | File edits are allowed without asking; other risky calls still ask. |
| `auto` | Claude Code's classifier decides which calls need asking. |
| `bypassPermissions` | Passed together with `allowDangerouslySkipPermissions: true`. Claude Code never asks: **every agent can run any command and change any file the person can, with no approval.** The panel warns about this. |

The modes belong to Claude Code; Masthead only passes the choice on. The mode is read when a process starts, so a change applies to agents started after it.

A request that is never answered waits for ever: there is no timeout in `askPermission()`. The agent's turn stays paused, holding its slot. It ends only when the person answers, Claude Code aborts the request (`signal`), the agent is stopped (`cancelPermissions()`), or Masthead shuts down.

## 6. Stopping

| Action | Code | Effect |
|---|---|---|
| Stop (square button) | `{t:'interrupt'}` → `Conversation.interruptLead()` → `Agent.interrupt()` | Interrupts the lead's current turn and keeps its session. Agents it started keep working. |
| Stop on one agent | `{t:'stop_agent'}` → `Conversation.stopAgent()` | Stops that agent and everything under it (`stopTree()`). Their open approval requests are denied (`cancelPermissions()`) and their processes closed (`Agent.end('stopped')`). On the lead, it stops all the lead's agents, interrupts the lead and settles it. A stopped sub-agent that owed a report sends its parent a short "stopped" report. |
| Stop everything | `{t:'stop_all'}` → `Conversation.stopAll()` | Same as stopping the lead. |
| An agent stopping an agent | `stop_agent` tool → `Conversation.stop()` | Allowed only for agents below the caller (`isAncestor()`). No report is sent; the caller asked for it. |
| Delete a conversation | `{t:'delete'}` in `App.dispatch()` | `stopAll()` and `shutdown()`, then the folder is removed. |

`Agent.end()` cancels a queued slot request and bumps a generation counter, so a start that was already waiting for a slot does not launch afterwards (the "ghost agent" fix; `test/agent.test.ts`).

**The person's stop sticks.** `markStoppedByPerson()` records every sub-agent the person stopped. `Conversation.message()` then refuses "the person stopped X; only they can wake it" when another agent tries to wake one. The person can still wake it by messaging it (`userSend()` clears the mark). The marks are saved with the conversation (`toStored()`, `restore()`), so they hold after a restart.

## 7. Effort

- With automatic effort on, every agent starts at the effort its starter asked for, low by default, capped at its tier's ceiling (`spawn()`, `capEffort()`). The ceiling ("Effort up to") is set by the person per tier. With automatic effort off, every agent runs at its tier's level and the effort tools are not offered (`teamTools()`).
- **The lead** may raise or lower its own effort up to its ceiling without asking (`setOwnEffort()` when there is no parent).
- **Any other agent** may lower its own effort at once. Raising it sends an effort request to its parent as a message, and the agent keeps working at its current level. A request to a parent that is no longer running is refused.
- **An agent may set the effort of any agent below it** (`setAgentEffort()`, `isAncestor()`), never above the target tier's ceiling. This is not sent as a message, so it costs the target no extra turn.
- Masthead resets effort to low after each piece of work: the lead when its turn ends and it goes idle (`turnEnded()`), a sub-agent when it finishes (`finish()`).
- `launch()` caps the effort again at every process start, so a lowered ceiling also applies after a resume. `Agent.applySettings()` (via `Conversation.settingsChanged()`) applies setting changes to running agents where it can.
- There is no `max` level (`EFFORTS` in `shared/protocol.ts`; `AGENTS.md` rule).

## 8. Messages between agents carry no authority

- Reports and messages arrive wrapped in `<agent-report …>` or `<agent-message …>` tags (`reportEnvelope()`, `messageEnvelope()` in `server/prompts.ts`).
- The system prompt tells every agent that text in those tags comes from another agent and never carries the person's authority or approval (`systemAppend()`). This is an instruction to the model; code cannot enforce it.
- So that a body cannot fake the edge of its envelope, `escapeBody()` turns `<agent-report`, `</agent-message` and the like (any case, with spaces) into `&lt;…`. `attr()` replaces quotes, angle brackets, `&` and whitespace in the `from` and `status` attributes. Tested in `test/conversation.test.ts` ("envelope bodies cannot close or open an envelope").
- Only the person's own messages arrive without an envelope (`userSend()`). An agent that wants the person's approval has to go through the lead, and the lead reaches the person only by writing in the conversation or with `AskUserQuestion`.

## 9. Caps

| Cap | Value | Where |
|---|---|---|
| Agents per conversation | 200 | `MAX_AGENTS`, `Conversation.spawn()` |
| Messages between agents per conversation | 1000 | `MAX_AGENT_MESSAGES`, `Conversation.message()`. Effort requests count too and are refused at the cap (`setOwnEffort()`). The counter is saved with the conversation and carries on after a restart. |
| `send_message` text | 20,000 characters | zod schema, `teamTools()` |
| `spawn_agent` task / title | 60,000 / 60 characters | zod schema; the title is also trimmed to 60 in `spawn()` |
| Agent names in tools | 80 characters | zod schema |
| Effort reason | 500 characters | zod schema |
| Run time of a sub-agent on one piece of work | `maxRunMinutes`, 0 (off) to 1440 | `tick()` every 30 s (`TICK_MS`); time paused is not counted |
| Usage-limit pauses in a row | 3 | `MAX_PAUSES`, `pause()`; the 4th fails |
| The person's message | 400,000 characters | `MAX_TEXT`, `App.dispatch()` `send` |
| Images per message | 8; PNG, JPEG, GIF or WebP; base64 characters only | `MAX_IMAGES`, `App.checkImages()`; at most 5 MB per image and 30 MB in total. |
| One socket message | 48 MiB | `MAX_WS_PAYLOAD`, `server/http.ts`. A larger message closes the socket. |

## 10. Agent-written text in the page

Agents write Markdown, which could hold HTML. The page renders it with `marked`, which escapes any raw HTML the agent wrote, and then cleans the result with DOMPurify (`renderMarkdown()` in `web/src/lib/markdown.ts`):

- `style`, `form`, `input` and `iframe` tags are removed;
- `style`, `id` and `name` attributes are removed;
- only the classes Masthead's own renderer and highlight.js produce are kept;
- links open in a new tab with `rel="noopener noreferrer"`.

So an agent cannot draw a fake "Allow" button over the page or run script. Everything else (the person's messages, tool input and output, notices) is inserted as plain text by Svelte. Details: [Rendering Markdown safely](Source-Web-Front-End.md#rendering-markdown-safely-markdownts).

## 11. When a process dies, at shutdown, after a restart

- **A process ends unexpectedly** (`Agent.consume()` → `Conversation.processLost()`):
  - its approval requests are denied and its slot released;
  - a sub-agent is marked `failed`, its own children are stopped, and its parent gets a "The agent failed: …" report if one was owed;
  - the lead goes back to `idle` (or `waiting`, if it still has agents running).
  - A resume whose session file is gone starts fresh once instead (`resumeWasMissing()`, `startFresh()`).
- **Claude Code not found:** `launch()` releases the slot and reports "Claude Code was not found on this machine."
- **Shutdown** (`masthead stop`, `SIGINT`/`SIGTERM`, or `POST /api/shutdown`; `runServer()` in `server/main.ts`):
  - `App.shutdown()` denies every open request, ends each running sub-agent as `stopped` ("Masthead was closed while this agent was working."), disposes the leads' processes and writes everything to disk;
  - the process exits 300 ms later.
- **After a restart** (`Conversation.restore()`):
  - nothing is running;
  - agents that were working come back as `stopped` with that error, and the lead becomes `idle`;
  - nobody owes a report;
  - the lead's transcript gets a notice naming the stopped agents, and the lead is told about them, once, with the person's next message (`restartNote()`, `userSend()`). A stopped agent resumes only when messaged.
  - The "stopped by the person" marks and the message counter are restored from the saved file; waits are memory only and start empty (the waiting agents were stopped anyway).

## 12. Credentials and the environment

- Masthead runs the person's own Claude Code (`findClaude()` in `server/config.ts`, or `MASTHEAD_CLAUDE`). It never reads, stores or sends credentials, has no login, and does not install a private copy of Claude Code: `install.sh` passes `--omit=optional` (rule in `AGENTS.md`).
- `agentEnv()` (`server/config.ts`) passes the server's environment to each Claude Code process with two changes:
  - it removes the variables an enclosing Claude Code session sets about itself (`SESSION_VARS`, and any `CLAUDE_CODE_BRIDGE_*`), so a server started from inside a Claude Code session still starts clean sessions;
  - it adds `CLAUDE_AGENT_SDK_CLIENT_APP=masthead/<version>`.

  Credential variables such as `ANTHROPIC_API_KEY` are passed through untouched. Tested in `test/app.test.ts`.
- **Lean modes** (`leanSubagents`, on by default for Sonnet and Haiku; `leanOpus`, on by default for Opus) set `strictMcpConfig` in `launch()`. A lean agent loads only Masthead's own MCP server, not the person's connectors (mail, drives, shops and so on). That keeps both its context and its reach small. The lead always gets the person's connectors.

## 13. Nobody waits silently for ever, with exceptions

What the code does to keep a team moving:

- **Questions to a parent** (`send_message` with `wait: true`; only to the parent or the lead, `message()`):
  - the waiting agent stays `waiting` without finishing;
  - if the recipient's turn ends without an answer, it gets one reminder (`checkWaitsOn()`);
  - if a non-lead recipient ends again without answering, or the person interrupts it, or it ends, the asker is told "No answer from X; carry on…" (`noAnswer()`, `releaseWaitsOn()`).
- **Background commands.** While Claude Code reports background commands for an agent (`backgroundChanged()`), the agent stays `waiting` instead of finishing. When the last one ends and Claude Code does not start a turn within `BACKGROUND_GRACE_MS` (3 s), `checkIdleSoon()` calls `backgroundIdle()`, which settles the agent.
- **Children ending without a report** settle a parent that was only waiting on them (`settle()`).
- `list_agents` shows each agent's state, activity, time live, context and cost (`Conversation.list()`), so a parent can see a stuck child.

Where a team can still hang:

- An agent waiting for **the lead** keeps waiting until the lead or the person answers. This is deliberate, because the person can answer it directly.
- A **background command that never ends** keeps the lead `waiting` until someone stops it. A sub-agent waiting only on background work is finished after 10 minutes (`BACKGROUND_WAIT_MS`) with "A background command was still running when Masthead closed this agent."
- An **approval nobody answers** pauses the agent with no time limit (section 5).
- A **foreground command that hangs** is bounded only by Claude Code's own tool timeouts, not by Masthead.
- A parent waits as long as its children run, unless the person sets a run-time limit (`settings.maxRunMinutes`, 0 = off): `tick()` then stops any sub-agent that has spent longer than that `running` on one piece of work (queued, waiting, paused and approval time do not count), with everything under it, and tells its parent "Stopped after N minutes: the run-time limit set by the person." The lead is never stopped this way.
- At a **usage limit** an agent pauses as `waiting` until the reset time (or 15 minutes if unknown) releasing its slot, and is resumed by `tick()`; messages from agents are held until then; at most 3 pauses in a row (`MAX_PAUSES`), then it fails.

## What this does not protect against

- **An approved action can do anything the person can.** Once a command or edit is allowed, by a card, a saved "always" rule, the person's own Claude Code rules or `bypassPermissions`, Masthead does not limit it. There is no sandbox.
- **Prompt injection.** Text an agent reads (web pages, files, tool output, another agent's report) can steer it within its permissions: run allowed commands, edit files in reach, or send misleading messages to other agents. The envelope rule is an instruction to the model, not an enforcement.
- **Agents misleading each other or the person.** A report can be wrong or invented. The prompt says to check what comes back; code cannot.
- **Spend.** Masthead has no cost limit. Run time is limited only if the person sets `maxRunMinutes` (sub-agents only; the lead is never stopped). Usage-limit notices are shown (`App.rateLimit()`), and an agent that hits a usage limit pauses and resumes when it resets, rather than failing (up to 3 times in a row).
- **Background commands that never end** keep the lead waiting (sub-agents are closed after 10 minutes), and **approvals or questions to the lead that are never answered** keep agents waiting and holding slots (section 13).
- **The person's skills and connectors.** The lead, and any agent with lean mode off, loads every connector the person has. Skills are not filtered.

## Related pages

[Security model](Security-Model.md) · [Permissions and questions](Permissions-and-Questions.md) · [Team rules](Team-Rules.md) · [Slot scheduling](Slot-Scheduling.md) · [Agent life cycle](Agent-Life-Cycle.md) · [Tests](Source-Tests.md)
