# Safety model: how the agents are kept in hand

Masthead runs many agent sessions at once, and each one can run commands and change files as the person. This page explains what the code does to keep that team bounded, visible and stoppable, and what it does not do. It is about the agents. Who may reach the server at all (the local secret, remote devices and their roles) is covered in [Security model](Security-Model.md) and [Remote access](Remote-Access.md).

Every statement below was read from the 0.2.0 code on the `next` branch and names the file and function. It was **not** checked by running Masthead. The tests that cover a rule are listed in [Tests](Source-Tests.md); the state machine rows have tests in `test/machine.test.ts`.

## 1. Tiers: who may start whom

A conversation runs on one team profile: an ordered list of 1 to 5 tiers (`TeamProfile`, `MAX_TIERS` in `shared/protocol.ts`). Tier *i* may start only tier *i*+1; the last tier starts nobody (`childTierOf()`). The built-in `claude` profile:

| Tier | May start |
|---|---|
| `lead` (Fable 5.2; one per conversation, started by the person) | Opus agents |
| `opus` | Sonnet agents |
| `sonnet` | Haiku agents |
| `haiku` | nobody |

How the code enforces this:

- `Conversation.spawn()` (`server/core/conversation.ts`) looks the child tier up from the caller's tier and refuses with "Error: <label> agents cannot start other agents." when there is none. An agent cannot pick a tier.
- `teamToolDefs()` (`server/core/tools.ts`) does not give `spawn_agent`, `stop_agent` or `set_agent_effort` to an agent whose tier has no child tier, so the refusal is a second line of defence.
- The backends' own ways of starting sub-agents are switched off (section 3), so `spawn_agent` is the only way to start an agent.

See [Team rules](Team-Rules.md) and [Team profiles and settings](Team-Profiles-and-Settings.md).

## 2. The state machine's guarantees

Every change to an agent's life cycle goes through one pure function, `step()` in `server/core/machine.ts`, called by `Conversation.apply()`. That gives a few guarantees that hold whatever the backend does:

- **One state per agent, one place to change it.** `Conversation.states` holds an `AgentState` per agent; only `apply()` replaces it. Facts owned elsewhere (live children, background work, the report debt) are read fresh before each step, so the machine never acts on a stale count.
- **A finished agent stays finished** unless it is woken, restored or sent to: any other event on an `ended` state is ignored ("stale news"). A late `done`/`failed`/`stopped` status from the runtime cannot end an agent the machine has already queued again.
- **A sub-agent finishes only when nothing holds it.** It stays `waiting` while it has live children, waits for an answer, has background work or is paused at a usage limit (`holding()`), or while the runtime still has input no turn consumed (`ctx.busy`).
- **Ending is complete.** `endAs()` clears every hold, the report debt and the pause count, and emits `end`; the runtime's `end()` closes the session and gives the slot back. When a sub-agent ends with live children, they are stopped first (`stopChildren`).
- **Reports go once.** A report is sent only if `owesReport` was set, and ending clears it. An agent woken again owes a fresh report only if its parent can still receive one.
- **The lead never ends.** A stop, failure or end status makes it `waiting` or `idle`; it keeps its session.

Full table: [State machine](State-Machine.md).

## 3. Backend tools that are switched off

Each backend is told to hide its own team features, so work cannot start outside Masthead's tiers, limits and team map.

**Claude Code** (`server/backends/claude/session.ts`). Every session gets `disallowedTools: DISALLOWED`, plus `AskUserQuestion` for every agent except the lead (`SessionSpec.canAskPerson` is false for every non-lead):

| Tools | Why they are off |
|---|---|
| `Agent`, `Task`, `Workflow` | Claude Code's own sub-agents and workflows would start work outside the tiers and limits. |
| `SendMessage`, `ListAgents` | Its own agent messaging; Masthead's `send_message` and `list_agents` go through `Conversation`. |
| `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `ScheduleWakeup` | Built-in tools "that would bypass Masthead's own team, or that it has no screen for" (comment on `DISALLOWED`). |
| `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`, `SendToProject`, `SendToProjectContext`, `PushNotification` | "Ways to start work later or elsewhere, outside the team: scheduling, remote runs, other projects, phone pushes." |
| `AskUserQuestion` (all but the lead) | Only the lead talks to the person. A sub-agent asks its parent with `send_message`. |

**Codex** (`server/backends/codex/`). Codex's sub-agent tools (`collaboration.*`, `spawn_agent`, `wait_agent`, …) are removed through its model catalogue (`multi_agent_version` set to null, `server/backends/codex/cli.ts`), and the features `multi_agent`, `multi_agent_v2`, `goals` and `image_generation` are switched off per thread (`config()`). Detection checks the rendered prompt for such tools; if any remain, Codex is marked unusable: "Codex's own sub-agent tools could not be switched off (…), so a Codex team could break the team rules." As a last fallback, a native sub-agent Codex starts anyway is stopped and the agent told to use `spawn_agent` and `send_message`. A non-lead's `request_user_input` is answered empty without reaching the person.

Skills: Masthead does not filter the person's skills. A skill that tells an agent to use one of the tools above finds it switched off.

## 4. Team tools run inside the server

The team tools (`send_message`, `list_agents`, `spawn_agent`, `stop_agent`, `set_effort`, `set_agent_effort`) are defined once by `teamToolDefs()` as backend-neutral `ToolDef`s; Claude Code gets them as an in-process MCP server named `masthead`, Codex as dynamic tools. Each tool calls a `TeamActions` method that `Conversation` implements, so **every start, message, stop and effort change goes through `Conversation`**, which applies the rules on this page.

- The Claude backend allows these calls without asking the person (`canUseTool()` returns allow for `mcp__masthead__…`; `allowedTools` lists `mcp__masthead`). They can only act on the team, under the checks here.
- Tool arguments are described with JSON Schema (lengths in section 9); each `run()` reads only strings and known effort levels.

## 5. Approvals and permission modes

When a backend asks before a tool call, it calls `SessionEvents.askPermission()`; the runtime passes it to `Conversation.askPermission()`, which opens an approval hold (`ApprovalOpened`) and asks `App.askPermission()`, which shows a card in every open tab and waits. Full detail: [Permissions and questions](Permissions-and-Questions.md).

The backends differ in what they can ask (`BackendCaps` in `server/backends/types.ts`):

| Backend | `permissions` | "Always allow" | Questions to the person | Notes |
|---|---|---|---|---|
| Claude Code | `callback` | yes, when Claude Code offers rules | yes (lead only) | Every tool call Claude Code wants approved reaches Masthead through `canUseTool`. |
| Codex | `callback` | yes | yes (lead only) | Command, file-change and permission requests reach Masthead (`approvalsReviewer: 'user'`). |
| Fake (tests only) | `callback` | yes | yes | Selected only with `MASTHEAD_BACKEND=fake` and `MASTHEAD_ALLOW_FAKE=1`; the page can never choose it. |

The "Permissions" setting (`settings.permissionMode`) is passed in `SessionSpec.permissionMode`, and each backend maps it:

| Setting | Claude Code | Codex (`permissions()`) |
|---|---|---|
| `inherit` (default) | No mode passed: the person's own Claude Code settings and rules apply. | The person's own approval policy and sandbox. |
| `default` | Claude Code's normal mode. | `approvalPolicy: untrusted`, `sandbox: workspace-write`. |
| `acceptEdits` | Edits allowed without asking; other risky calls ask. | `approvalPolicy: on-request`, `sandbox: workspace-write`. |
| `auto` | Claude Code's classifier decides. | Same as `acceptEdits`. |
| `bypassPermissions` | Passed with `allowDangerouslySkipPermissions: true`: nothing asks. | `approvalPolicy: never`, `sandbox: danger-full-access`: nothing asks. |

With `bypassPermissions`, **every agent can run any command and change any file the person can, with no approval.** The modes belong to the backends; Masthead passes the choice on. The mode is read when a session opens.

An approval that is never answered waits for ever: `App.askPermission()` has no timeout. It ends when the person answers, the backend aborts the request (`signal`), the agent is stopped (`cancelPermissions()`: "The agent was stopped."), or Masthead shuts down ("Masthead is shutting down."). While it is open the run-time clock is stopped (section 9) and the agent shows the wait reason `approval`.

## 6. Stopping

| Action | Code | Effect |
|---|---|---|
| Stop (square button) | `{t:'interrupt'}` → `Conversation.interruptLead()` | Interrupts the lead's current turn and keeps its session. Agents it started keep working. |
| Stop on one agent | `{t:'stop_agent'}` → `Conversation.stopAgent()` | Stops that agent and everything under it (`stopTree()`, children first). Open approvals are denied (`cancelPermissions()`), messages held for them dropped (`dropHeld`), sessions closed. A stopped sub-agent that owed a report sends its parent a short "stopped" report; agents below it send nothing (their parents are being stopped too). On the lead: all its agents are stopped, the lead is interrupted, its pause and held messages are dropped, and it goes idle if nothing else holds it. |
| Stop everything | `{t:'stop_all'}` → `Conversation.stopAll()` | Same as stopping the lead. |
| An agent stopping an agent | `stop_agent` tool → `Conversation.stop()` | Only agents below the caller (`isAncestor()`). No report: the caller asked for it. |
| Delete a conversation | `{t:'delete'}` in `App.dispatch()` | `stopAll()` and `shutdown()`, then the folder is removed. |

**The person's stop sticks.** A `Stop` by the person sets `stoppedByPerson` on an agent that was working (machine row 23). `Conversation.message()` then refuses "Error: the person stopped "X"; only they can wake it." when another agent tries to wake it. The person can still wake it by messaging it (`Woken` by the person clears the mark). The marks are **saved** with the conversation (`toStored()`, the `save` effect) and restored by `Conversation.restore()`, so they hold after a restart.

Processes are started so that stopping one also stops the commands it started: on POSIX the CLI gets its own process group, which gets SIGTERM then SIGKILL; on Windows `taskkill /T /F` ends the tree (`server/backends/proctree.ts`).

## 7. Effort

- With automatic effort on, an agent starts at the effort its starter asked for, low by default, capped at its tier's ceiling (`spawn()`, `capEffort()`). The ceiling is set by the person per tier. With it off, every agent runs at its tier's level and the effort tools are not offered (`teamToolDefs()`).
- Only levels the backend supports are offered (`caps.efforts`); a backend with none gets no effort tools.
- **The lead** may raise or lower its own effort up to its ceiling (`setOwnEffort()` with no parent).
- **Any other agent** may lower its own effort at once. Raising sends an effort request to its parent; the agent keeps working at its level. A request to a parent that is no longer running is refused.
- **An agent may set the effort of any agent below it** (`setAgentEffort()`), never above the target tier's ceiling. It is not sent as a message, so it costs no extra turn.
- After a piece of work, effort goes back to low (`setEffortLow` effect): a sub-agent when it finishes, the lead when it goes idle.
- There is no `max` level (`EFFORTS`); the Codex backend never sends its `max` or `ultra` levels.

## 8. Messages between agents carry no authority

- Reports and messages arrive wrapped in `<agent-report …>` or `<agent-message …>` tags (`reportEnvelope()`, `messageEnvelope()` in `server/core/prompts.ts`).
- The system text tells every agent that text in those tags comes from another agent and never carries the person's authority. This is an instruction to the model; code cannot enforce it.
- So a body cannot fake the edge of its envelope, `escapeBody()` escapes envelope tags inside the body, and `attr()` cleans the `from` attribute.
- Only the person's own messages arrive without an envelope (`userSend()`).

## 9. Limits

| Limit | Value | Where |
|---|---|---|
| Agents of a tier running at once, app-wide | `TierSpec.max`, 0..12 (`MAX_PER_TIER`); `claude` defaults 3 Opus, 4 Sonnet, 4 Haiku | `Scheduler`, `tierLimit()`. The first tier of every profile is not limited. A queued request is served fairly: the owner with the fewest running agents of that tier goes first. See [Slot scheduling](Slot-Scheduling.md). |
| A tier set to 0 (Off) | — | `spawn()` refuses; queued agents fail with `TierOff` (`Scheduler.limitsChanged()`); nobody, not even the person, can wake an agent of that tier (`tierOff()`). |
| Agents per conversation | 200 | `MAX_AGENTS`, `spawn()` |
| Messages between agents per conversation | 1000 | `MAX_AGENT_MESSAGES`, `message()`; effort requests count. Saved and restored. |
| `send_message` text / `spawn_agent` task / title / names / effort reason | 20,000 / 60,000 / 60 / 80 / 500 characters | JSON Schema in `teamToolDefs()` |
| **Run-time limit** of a sub-agent on one piece of work | `settings.maxRunMinutes`, 0 (off) to 1440 | Machine row 21 on each `Tick` (every 30 s). Counts **awake** time spent `running` with no approval open (`AgentState.run`), so queued, waiting, paused and approval time and time the computer slept do not count. Reset when the agent is woken after ending. Stops it and everything under it: "Stopped after N minutes: the run-time limit set by the person." The lead is never stopped this way. |
| **Background cap** | 10 minutes of awake time | `BACKGROUND_WAIT_MS`, machine row 22: a sub-agent waiting on background commands alone is finished with "A background command was still running when Masthead closed this agent." |
| **Usage-limit pauses** in a row | 3 | `MAX_PAUSES`. See below. |
| The person's message | 400,000 characters; 8 images; 5 MB each; 30 MB together | `App.dispatch()` `send`, `checkImages()`, `checkRefs()` |
| Stored images per conversation | 500 MB; 8192 px a side, 40 megapixels | `BlobStore.put()` |
| One socket message | 48 MiB | `MAX_WS_PAYLOAD` |

**Usage-limit pauses** (machine rows 11 and 20). When a turn or process ends because the backend reports the usage limit (the runtime's `usageLimitFor()` is conservative, for every backend: the session must have reported a `rejected` usage notice and the error must be marked or worded as a rate limit), the agent does not fail. It goes `waiting` with a pause hold until the reset time, or 15 minutes later if unknown (`DEFAULT_PAUSE_MS`), gives up its slot, and its transcript says "Paused at the usage limit until HH:MM; Masthead resumes it then." Deadlines use the wall clock. On a `Tick` after the reset it is resumed with "The usage limit has reset. Carry on from where you stopped." (plus " Background commands you had running were stopped." when closing the process ended them). After 3 pauses in a row (a turn that gets through resets the count) a sub-agent fails; the lead carries on.

**Held messages.** While an agent is paused, messages from other agents and Masthead's notes to it are held (`Conversation.held`) and delivered in order when the pause ends. The person's own message is not held: it goes through at once, after what was held for that agent. Stopping the agent drops what was held.

## 10. Agent-written text in the page

Agents write Markdown, which could hold HTML. The page renders it with `marked` and cleans the result with DOMPurify (`renderMarkdown()` in `web/src/lib/markdown.ts`): `style`, `form`, `input` and `iframe` tags are removed, attributes are filtered by hooks, and links open in a new tab. So an agent cannot draw a fake "Allow" button or run script. Everything else (the person's messages, tool input and output, notices) is inserted as plain text. Images are served from `/blob` with a `sandbox` content-security policy. Details: [Web front end](Source-Web-Front-End.md).

## 11. When a process dies, at shutdown, after a restart

- **A process ends unexpectedly** (`SessionEvents.exited` → `Agent` → `Conversation.processLost()`): its approvals are denied and its slot released; at a usage limit it pauses (section 9); otherwise a sub-agent fails, its children are stopped, and its parent gets "The agent failed: …" if a report was owed; the lead goes `idle` or `waiting`. A resume whose session no longer exists starts fresh once.
- **No usable backend for the tier:** the agent fails with "No agent backend is available: the program this tier runs on was not found on this machine." A new conversation is refused up front if its lead's backend is unusable.
- **Shutdown** (`masthead stop`, a signal, or `POST /api/shutdown`; `runServer()` in `server/main.ts`): `App.shutdown()` releases keep-awake, denies every open request, stops each working sub-agent as `stopped` ("Masthead was closed while this agent was working.") quietly, writes everything to disk and disposes the backends; the process exits 300 ms later.
- **After a restart** (`Conversation.restore()`): nothing is running; agents that were working come back `stopped` with that error, and the lead `idle`; nobody owes a report; the lead's transcript gets a notice naming them and the lead is told once, with the person's next message (`restartNote()`). Stop marks and the message counter are restored; waits and pauses start empty.

## 12. Keeping the computer awake

With `settings.keepAwake` on (the default), `App.keepAwake()` holds off **idle** sleep while any conversation is busy, through `server/service/awake.ts`: `systemd-inhibit --what=idle` on Linux, `caffeinate -i -w <pid>` on macOS, `SetThreadExecutionState` through PowerShell on Windows. The hold is released 5 s after the last agent stops working, ends with the server even if it crashes, and never blocks closing the lid or choosing Suspend. If the computer does sleep, the awake-time clock keeps the sleep out of run times and the background cap, and a working conversation's lead gets "This computer was asleep from HH:MM to HH:MM; work carried on afterwards." (`Conversation.wokeFromSleep()`).

## 13. Credentials and the environment

- Masthead runs the person's own installed, signed-in Claude Code and Codex. It never reads, stores or sends their credentials (`BackendInfo` "never holds credentials").
- For Claude Code, `agentEnv()` (`server/backends/claude/env.ts`) passes the server's environment on, minus the variables an enclosing Claude Code session sets about itself (`SESSION_VARS`, `CLAUDE_CODE_BRIDGE_*`), plus `CLAUDE_AGENT_SDK_CLIENT_APP=masthead/<version>`. Credential variables such as `ANTHROPIC_API_KEY` pass through untouched.
- **Lean tiers** (`TierSpec.lean`; on by default for Opus, Sonnet and Haiku in the `claude` profile) skip the person's own MCP servers: Claude Code gets `strictMcpConfig`, Codex has the person's servers and ChatGPT apps switched off. The lead is not lean by default.

## 14. Nobody waits silently for ever, with exceptions

- **Questions to a parent** (`send_message` with `wait: true`; only to the parent or the lead): if the recipient's turn ends without an answer it gets one reminder; if a non-lead recipient ends another turn without answering, or the person interrupts it, or it ends, the asker is told "No answer from "X"; carry on with your best judgment or report what you have."
- **Children ending without a report** settle a parent that was only waiting on them (`settle()`).
- `list_agents` shows each agent's state (including "paused until HH:MM (usage limit)" and "waiting on a background command for …"), activity, time live, context and cost.

Where a team can still hang:

- An agent waiting for **the lead** keeps waiting until the lead or the person answers (deliberate: the person can answer it directly).
- A **background command that never ends** keeps the lead `waiting` until someone stops it (sub-agents are closed by the background cap). Codex does not report background commands at all (`caps.background: false`), so nothing waits for them.
- An **approval nobody answers** pauses the agent with no time limit.
- A **foreground command that hangs** is bounded only by the backend's own timeouts, and by the run-time limit if the person set one.

## What this does not protect against

- **An approved action can do anything the person can.** Once a command or edit is allowed (by a card, a saved "always" rule, the person's own backend rules, or `bypassPermissions`), Masthead does not limit it. Masthead adds no sandbox of its own; Codex's sandbox applies only as the chosen mode sets it.
- **Prompt injection.** Text an agent reads (web pages, files, tool output, another agent's report) can steer it within its permissions. The envelope rule is an instruction to the model, not an enforcement.
- **Agents misleading each other or the person.** A report can be wrong or invented.
- **Spend.** Masthead has no cost limit. Run time is limited only if the person sets `maxRunMinutes`, and only for sub-agents. Usage-limit pauses wait for the limit to reset; they do not reduce use.
- **Hangs** listed in section 14: unanswered approvals, waits on the lead, never-ending background commands on the lead, hanging foreground commands without a run-time limit.
- **The person's skills and connectors.** The lead, and any tier with lean off, loads every connector the person has. Skills are not filtered.
- **Sleep and power.** Keep-awake prevents only idle sleep; closing the lid, suspending or losing power stops the agents. After a restart they come back stopped.
- **Network and device access.** Covered in [Security model](Security-Model.md), not here.

## Related pages

[Security model](Security-Model.md) · [State machine](State-Machine.md) · [Permissions and questions](Permissions-and-Questions.md) · [Team rules](Team-Rules.md) · [Slot scheduling](Slot-Scheduling.md) · [Agent life cycle](Agent-Life-Cycle.md) · [Backend interface](Backend-Interface.md) · [Tests](Source-Tests.md)
