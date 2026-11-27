# 0.2.0 research: a Codex backend

Research by bravo, 2026-11-27, against `codex-cli 0.172.0` (`/usr/bin/codex`, signed in with a ChatGPT
Pro plan) and Masthead `next` (0.1.4). Read-only on the project except this file. Experiments ran in
`/tmp/codex-exp` with `gpt-6-luna` at `low` effort. Each run cost about 19k input tokens, most of it
cached. The one test session that was saved to `~/.codex/sessions` was deleted afterwards with
`codex delete --force <id>`.

Sources:

- **[help]**: `codex <cmd> --help`.
- **[types]**: `codex app-server generate-ts --out ts` (98 top-level files and 703 files in `v2/`, plus
  `--experimental`) and `generate-json-schema --out schema`. Copies are in `/tmp/codex-research/`.
- **[run]**: the JSON-RPC client in `/tmp/codex-exp/rpc.mjs`.
- **[docs]**: learn.chatgpt.com/docs/app-server and /docs/config-file/config-reference;
  developers.openai.com/codex now redirects there. Quotes were taken through a summarising fetch tool.

"Unverified" means it was read but not seen working.

## 1. How to drive Codex from Node

Codex offers three ways in. **Use `codex app-server`.**

| Way | What it is | Long-lived session | Input mid-turn | Approvals to host | Host tools |
|---|---|---|---|---|---|
| `codex exec --json` | one process per turn, JSONL events | no; use `exec resume <id>` per turn | no | no (the policy decides) | MCP only |
| `@openai/codex-sdk` (TS) | "spawns the CLI and exchanges JSONL events" [docs] | thread object, one run at a time | not documented | not documented | MCP only |
| `codex app-server` | JSON-RPC 2.0, newline-delimited JSON over stdio (default) [help][docs] | yes; one process, many threads | `turn/steer` [run] | server requests [run] | `dynamicTools` [run] or MCP |

- The docs say app-server is for "a deep integration inside your own product", and the SDK is for
  CI and automation.
- `codex --help` labels app-server "[experimental]".
- Its protocol is generated per version (`generate-ts`). Masthead should vendor the types for the
  version it supports and check the version at start-up.

`codex exec --json` [run]: stdin must be closed (`</dev/null`). Otherwise it waits for stdin; it hung
for 120 s.

```
{"type":"thread.started","thread_id":"01a21ba9-…"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}
{"type":"turn.completed","usage":{"input_tokens":16384,"cached_input_tokens":12800,…,"output_tokens":6,"reasoning_output_tokens":0}}
```

### app-server protocol (the parts Masthead needs) [types][run]

**Handshake:** `initialize {clientInfo:{name,title,version}, capabilities:{experimentalApi:true, requestAttestation:false}}`,
then the notification `initialized`. `experimentalApi` is needed for `dynamicTools`.

**Client requests** (out of about 120):
- `thread/start {model, cwd, approvalPolicy, sandbox, config:{dotted.key: value}, baseInstructions, developerInstructions, ephemeral, dynamicTools*}`
  → `thread.id`, plus `thread.path` (the rollout file).
- `thread/resume {threadId, …same overrides}`
- `turn/start {threadId, input:[UserInput], effort, model, cwd, approvalPolicy, sandboxPolicy, …}` → `turn.id`.
  Overrides apply "for this turn and subsequent turns".
- `turn/steer {threadId, expectedTurnId, input}`
- `turn/interrupt {threadId, turnId}`
- `thread/compact/start`
- `model/list`
- `account/read`
- `account/rateLimits/read`

(* = experimental.)

**Notifications** seen in runs:
- Turn and thread state: `thread/started`, `thread/status/changed` (`idle`, or `active` with flags
  such as `waitingOnApproval`), `turn/started`, `turn/completed {turn:{status: completed|interrupted|failed, error:{message, codexErrorInfo}}}`.
- Items: `item/started` and `item/completed` with `item.type` in `userMessage`, `agentMessage`
  (`phase`: `commentary` | `final_answer`), `reasoning`, `commandExecution`, `fileChange`,
  `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `plan`, ….
- Deltas: `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`,
  `item/commandExecution/outputDelta`.
- Usage and limits: `thread/tokenUsage/updated` and `account/rateLimits/updated`, both after every
  model call.
- Other: `mcpServer/startupStatus/updated`, `serverRequest/resolved`, `error`, `warning`,
  `thread/compacted`, `thread/queue/changed`.

**Server requests** (the host must answer):
- Approvals: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`.
- Host tools: `item/tool/call` (dynamic tools).
- Questions: `item/tool/requestUserInput`.
- MCP: `mcpServer/elicitation/request`.

**Token usage** [run]:

```
"tokenUsage":{"total":{"totalTokens":75419,"inputTokens":75307,"cachedInputTokens":55808,…},
              "last":{"totalTokens":18961,"inputTokens":18925,"cachedInputTokens":18688,"outputTokens":36,…},
              "modelContextWindow":258400}
```

- `last.inputTokens` is the context in use and `modelContextWindow` is the window size; together
  they give Masthead's context gauge.
- There is no cost in dollars; the ChatGPT plan bills in usage percent.

**Rate limits** [run]:

```
"rateLimits":{"limitId":"codex","primary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":1796364996},
              "secondary":null,"credits":{…},"planType":"pro","rateLimitReachedType":null}
```

`resetsAt` is in seconds, the same unit as Claude Code's.

**Errors:**
- `codexErrorInfo` includes `usageLimitExceeded`, `rateLimitExceeded`, `contextWindowExceeded`,
  `serverOverloaded`, `unauthorized`, `activeTurnNotSteerable`, `sandboxError`, ….
- When overloaded the server answers JSON-RPC `-32001` [docs].
- The usage-limit turn itself was not seen (unverified).

## 2. Messages arriving mid-turn

**Verified [run].** `turn/steer` was sent 2.5 s into a turn:

- The reply was `{"result":{"turnId":"01a21ba6-6e30-…"}}`.
- The steered text showed up as a `userMessage` item inside the same turn.
- The final answer obeyed it: `"…DONE STEERED"`.

Masthead mapping:
- **Turn active:** steer with `expectedTurnId`. If the turn just ended the request fails (by
  precondition), so fall back to `turn/start`.
- **No turn active:** `turn/start`.
- The id bookkeeping is simpler than Claude Code's: each `turn/completed` ends exactly one turn, and
  steered input belongs to it. Masthead can drop the `unanswered`-uuid logic for Codex. It still has
  to handle the race between steering and turn end. `clientUserMessageId` exists on start and steer
  and comes back as `userMessage.clientId`; it can tie items to Masthead's messages.
- Some turns refuse steering: `activeTurnNotSteerable {turnKind}`. Queue the message for the next
  `turn/start` instead.
- `codex queue --thread <id> --message` exists for sessions held by the shared daemon. It is not
  needed with our own app-server.

**Interrupt, verified [run]:** `turn/interrupt` → `{}` → `turn/completed` with `status:"interrupted"`
2.5 s later.

## 3. Team tools

**A. `dynamicTools` on `thread/start` (recommended; experimental API).** Verified [run]:

```
thread/start … "dynamicTools":[{"type":"function","name":"ping","description":"…","inputSchema":{…}}]
<< {"method":"item/tool/call","id":0,"params":{"threadId":"…","turnId":"…","callId":"exec-36bf…","namespace":null,"tool":"ping","arguments":{"note":"hi"}}}
>> {"id":0,"result":{"contentItems":[{"type":"inputText","text":"TOOL-OK from host"}],"success":true}}
<< item/completed {"type":"dynamicToolCall",…,"status":"completed","success":true,"durationMs":1}
```

- The tools run inside the Masthead process, as the in-process MCP server does today, and the
  schemas are plain JSON Schema.
- Specs also allow `{"type":"namespace"}` and `deferLoading`. Masthead wants them always loaded, so
  leave `deferLoading` off.
- No approval request was raised for the dynamic tool call.
- `success:false` is the error flag.
- A result can carry `inputImage` items.

**B. An MCP server per thread** through `thread/start.config` (unverified for HTTP).
- Keys [docs]: `mcp_servers.<id>.{command,args,env}` for stdio, or `{url, bearer_token_env_var,
  http_headers, env_http_headers}` for streamable HTTP, plus `startup_timeout_sec`,
  `tool_timeout_sec`, `enabled_tools`, `disabled_tools`, `enabled`.
- Masthead would serve a localhost MCP endpoint with a per-agent bearer token.
- Use B only if dynamic tools are removed.

**Per-thread config without touching `~/.codex/config.toml`:**
- `thread/start.config` takes dotted keys, the same as `-c`.
- Verified [run]: `{"mcp_servers.blender.enabled":false,"mcp_servers.node_repl.enabled":false,"features.apps":false}`
  stopped those servers for that thread. Without it, the person's `cua_repl`, `codex_apps`, `blender`
  and `node_repl` all started.
- `cua_repl` kept starting. It looks plugin-provided; how to drop it is unknown.
- `features.goals=false` and `features.image_generation=false` removed those tools. That was judged
  from the model's own list of its tools, which is weak evidence.
- This gives a "lean" mode: list the person's servers (`mcpServerStatus/list` or `config/read`) and
  disable each one.

**Codex's own sub-agents: NOT solved.**
- The models declare `multiAgentVersion: "v2"` (`model/list`).
- With `features.multi_agent=false`, `features.multi_agent_v2=false` and `agents.max_depth=0`, the
  model still listed `collaboration.spawn_agent`, `collaboration.send_message`,
  `collaboration.list_agents`, `collaboration.wait_agent`, `collaboration.interrupt_agent` and
  `collaboration.followup_task` [run]. This is self-reported by the model; the actual tool list was
  not captured.
- Effort `ultra` is described as "Maximum reasoning with automatic task delegation". Never send it.
- Mitigations to evaluate live:
  1. Find the real switch: ask OpenAI, or look in `config/read` and the config schema.
  2. Forbid it in `developerInstructions`.
  3. Treat any `item/started` with `type:"collabAgentToolCall"` as a violation: interrupt the turn
     and tell the agent to use `spawn_agent`.
  4. Check whether such calls pass through an approval request we can decline (unknown).

## 4. Approvals and sandbox

Verified [run], with `approvalPolicy:"untrusted"`, `sandbox:"read-only"` and the prompt
"run `touch approval-test.txt`":

```
<< thread/status/changed {"type":"active","activeFlags":["waitingOnApproval"]}
<< {"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"…","turnId":"…","itemId":"exec-29c7…",
    "command":"/usr/bin/bash -lc 'touch approval-test.txt'","cwd":"/tmp/codex-exp","commandActions":[…],
    "proposedExecpolicyAmendment":["touch","approval-test.txt"],
    "availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{…}},"cancel"]}}
>> {"id":0,"result":{"decision":"decline"}}
<< serverRequest/resolved; item/completed commandExecution "status":"declined"
```

**Decisions.**
- Commands: `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment` (an "always" rule),
  `applyNetworkPolicyAmendment`, `decline`, `cancel` (cancel also stops the turn).
- File changes: `accept`, `acceptForSession`, `decline`, `cancel`, plus `grantRoot`.
- Permissions: a `GrantedPermissionProfile` with a scope.
- `availableDecisions` tells the card which buttons to show.
- `decline` was accepted even though it wasn't listed.

**Policies and modes.**
- `approvalPolicy` is one of `untrusted`, `on-request`, `never` or `{granular:{…}}`. The docs call
  `untrusted` "unsupported", yet it asked here.
- `sandbox` is one of `read-only`, `workspace-write` or `danger-full-access`.
- `approvalsReviewer: user | auto_review | guardian_subagent`. Masthead must force `user` so that
  approvals reach the cards; `auto_review` runs another model.

**Mapping to Masthead's cards.**
- Allow → `accept`; Always → `acceptForSession` or the amendment; Deny → `decline`.
- On Stop: answer `cancel` for pending requests, then `turn/interrupt`.
- A request has no abort signal; `serverRequest/resolved` says when Codex withdrew one.

**"Inherit" for Codex** means not sending `approvalPolicy`, `sandbox` or `approvalsReviewer`. Then
the person's config.toml applies; this machine has `approval_policy`, `sandbox_mode` and
`approvals_reviewer` set. Risk: if the person uses `auto_review` or `never`, Masthead's cards never
appear. That matches what inherit means for Claude Code today.

## 5. Models, effort, instructions, cwd, environment

`model/list {includeHidden:false}` [run], not hard-coded:

| id | display | efforts | default effort | note |
|---|---|---|---|---|
| gpt-6.2-sol | GPT-6.2-Sol | low…ultra | low | `isDefault`; "Fast, go-to model for coding" |
| gpt-6.2-astra | GPT-6.2-Astra | low…ultra | low | "Our most capable model" |
| gpt-6.1-terra | GPT-6.1 Terra | low…ultra | low | "visual understanding and computer use" |
| gpt-6-luna | GPT-6-Luna | low…max | medium | "Fast and affordable model for easier tasks" |
| + gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-5.6-sol/terra/luna (legacy); hidden: gpt-reserve, codex-auto-review | | | | |

So the person's "Astra, Sol, Terra, Luna" are real families on this account.

**Suggested default tiers (the person decides):**
- lead: newest Astra
- second tier (opus slot): newest Sol
- third tier (sonnet slot): newest Terra or Sol at lower effort
- leaf tier (haiku slot): newest Luna

Pick the newest by `model/list` order, not by hard-coded name.

**Effort mapping.** Masthead's low, medium, high and xhigh map one-to-one. Never send `max` (the
project rule) or `ultra` (auto-delegation). Check each model's `supportedReasoningEfforts` and clamp
to it. Effort changes per turn with `turn/start {effort}`; no restart is needed. Model also changes
per turn, so the lead's model setting can apply to its next turn.

**System prompt.**
- `developerInstructions`, on `thread/start` and `thread/resume`, "injected into the session"
  [docs], appends to Codex's own instructions. Verified: the run with it followed it.
- `baseInstructions` and `model_instructions_file` would *replace* the built-in instructions;
  Masthead should not use them.
- The person's AGENTS.md files are loaded as usual. This machine has `~/.codex/AGENTS.md`.

**Working folder and environment.**
- `cwd` on `thread/start` (and per turn). Verified: `environments[0].cwd`.
- The app-server process inherits the environment Masthead gives it. Strip any Claude-specific
  session variables, as `agentEnv()` does.

**Baseline cost:** a trivial turn is about 16–19k input tokens (Codex's own prompt plus tools).
Leaner config (apps and MCP off) should lower it; not measured.

## 6. Sessions

- Stored at `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl` (`thread.path`
  [run]), with an index and SQLite state in `~/.codex/`. `ephemeral:true` writes nothing.
- Resume: `thread/resume {threadId}`. Verified for a missing thread:
  `{"error":{"code":-32600,"message":"no rollout found for thread id 00000000-…"}}`. That is a
  clean, typed failure; Masthead's "start fresh" rule maps to this error code plus the message.
- Compaction:
  - Automatic, controlled by `model_auto_compact_token_limit` and related keys [docs].
  - Manual: `thread/compact/start`, then the notification `thread/compacted`.
  - `contextWindowExceeded` is the failure case.
- Sessions Masthead creates appear in the person's own Codex history (`codex resume` picker). Name
  them with `thread/name/set` (for example "masthead: bravo") or accept the clutter. They can be
  archived or deleted with `thread/archive` and `thread/delete`.

## 7. Images

- **In:** `UserInput` `{type:"localImage", path}` or `{type:"image", url}` (data URLs:
  unverified). Verified: an 8×8 red PNG was answered "Red". Every listed model has
  `inputModalities:["text","image"]`.
- **Tool results:** `DynamicToolCallOutputContentItem` `{type:"inputImage", imageUrl}` (unverified).
- **Out:** Codex has image generation (`features.image_generation`, items under
  `~/.codex/generated_images`). Masthead should turn it off per thread or show it as a file.

## 8. Terms

- Not established.
- The docs found only say that signing in with ChatGPT puts use under the ChatGPT Terms and Privacy
  Policy, and that Codex usage shares the plan's pool with other agentic features.
- No page was found on third-party apps driving a person's signed-in CLI.
- app-server is documented for embedding ("inside your own product"). Its docs include a WebSocket
  transport and `--analytics-default-enabled` "for first-party use cases like the VSCode IDE
  extension". Analytics are off by default for app-server.
- Masthead runs the person's own CLI and own sign-in and never touches `~/.codex/auth.json`. That
  matches its Claude Code stance. Have the person read the terms before release.

## 9. Detection

- The binary is `codex` on PATH; allow a `MASTHEAD_CODEX` override, as with Claude.
- `codex --version` prints `codex-cli 0.172.0`.
- Signed in: `codex login status` prints "Logged in using ChatGPT". Over RPC, `account/read` gives
  `account.type` and `planType`, and the notification `account/updated {authMode:"chatgpt"}`
  arrives. Never read auth files.
- Minimum version: pin to 0.172.x for 0.2.0, since the protocol types were generated from it. Warn
  on other versions.

## Recommended integration

1. **Process.** Run one `codex app-server` process per Masthead server, lazily started and
   restarted if it dies. The person's own daemon is not used: avoid `--remote` and the shared
   daemon, so Masthead's threads, approvals and limits stay its own. Run each agent as one thread on
   it.
   - Fallback if one process proves fragile: one app-server per agent, which looks like today's one
     Claude Code process per agent (cost: about 0.2–1 s start-up and the MCP start-up per agent).
   - Unverified: whether one app-server handles many concurrent active turns well (`-32001`
     overload exists).
2. **Starting a thread:** `thread/start` with:
   - `model`, `cwd`, `developerInstructions` (`systemAppend`) and `dynamicTools` (the six team
     tools).
   - `approvalsReviewer:"user"`, plus `approvalPolicy` and `sandbox` unless the setting is inherit.
   - `config`: lean overrides (`features.apps=false`, `features.image_generation=false`,
     `features.goals=false`, each of the person's MCP servers disabled for lean tiers,
     `features.multi_agent=false`).
3. **Delivering:** `turn/start` when idle and `turn/steer` while active; images as `localImage` from
   a temp file or as an `image` data URL.
4. **Turn end:** on `turn/completed`, the outcome text is the last `agentMessage` with
   `phase:"final_answer"` (Masthead's run-text joining still applies).
   - `status:"interrupted"` → interrupted.
   - `failed` with `usageLimitExceeded` → usageLimit, `resetsAt` from the latest
     `account/rateLimits/updated`.
5. **Effort:** `set_effort` and `set_agent_effort` take effect at the next `turn/start {effort}`. A
   change in the middle of a turn waits for the next turn; Claude applies it live with
   `applyFlagSettings`.
6. **Resume:** `thread/resume`. On `-32600 "no rollout found"`, start fresh, the same as the Claude
   rule.
7. **Mapping events to Masthead items:**

   | Codex | Masthead |
   |---|---|
   | `agentMessage` deltas | draft text |
   | `reasoning` summary deltas | draft thinking |
   | `item/completed` `agentMessage` | text item |
   | `reasoning` | thinking item |
   | `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall` | tool items (the result is `aggregatedOutput`, `changes` or `result`) |
   | `thread/tokenUsage/updated` | usage |
   | `account/rateLimits/updated` | the rate-limit banner (`usedPercent` → utilization) |

## Minimal backend interface (both Claude Code and Codex)

Derived from what `server/agent.ts` uses today. Echo owns the full design in `backends.md`; this is
the Codex view of it.

```ts
interface Backend {
  readonly kind: 'claude' | 'codex';
  detect(): Promise<{ path: string | null; version: string | null; signedIn: boolean | null; error?: string }>;
  listModels(): Promise<Array<{ id: string; label: string; efforts: Effort[]; isDefault: boolean }>>; // Claude: from settings
  capabilities: {
    liveEffort: boolean;        // Claude yes (applyFlagSettings); Codex next turn
    steerMidTurn: boolean;      // Claude: input stream; Codex: turn/steer
    costUsd: boolean;           // Claude yes; Codex no (usage percent only)
    backgroundTasks: boolean;   // Claude background_tasks_changed; Codex unknown
    nativeSubagentsOff: boolean;// Claude yes (disallowedTools); Codex NO (see risks)
    contextUsage: boolean;      // both
  };
  open(opts: SessionOpts, sink: SessionEvents): Session;
}
interface SessionOpts {
  resumeId: string | null; model: string; effort: Effort; cwd: string; env: Record<string,string|undefined>;
  systemAppend: string; tools: TeamToolSpec[];  // name, description, JSON schema, handler(args) => {text, isError}
  permission: 'inherit' | PermissionChoice; lean: boolean;
}
interface Session {
  send(content: Content, id: string): void;   // queued, or steered mid-turn; id echoed in the turn outcome
  interrupt(): Promise<void>;
  setEffort(e: Effort): void; setModel(m: string): void;
  contextUsage(): Promise<{ used: number; max: number } | null>;
  close(mode: 'graceful' | 'now'): void;
}
interface SessionEvents {
  sessionId(id: string): void;                 // Claude system/init; Codex thread.id
  turnStarted(): void;
  draft(kind: 'text'|'thinking', text: string): void;
  item(i: NewItem): void; itemDone(id: string, patch: Partial<Item>): void;
  usage(u: { context?: number; contextMax?: number; output?: number; costUsd?: number }): void;
  rateLimit(n: RateLimitNotice & { reached: boolean; resetsAtMs?: number }): void;
  approval(req: ApprovalRequest): Promise<ApprovalDecision>; // allow | always | deny | cancel
  turnEnded(o: { text: string; answeredIds: string[]; error?: string; interrupted: boolean; usageLimit?: { resetsAt?: number } }): void;
  background(running: boolean): void;
  lost(o: { message: string; missingSession: boolean; usageLimit?: { resetsAt?: number } }): void;
}
```

Masthead's `Agent` then holds the state that is common to both backends: slots and generation,
held messages, run texts, pause, wait, effort reset. It stops parsing SDK messages; each backend
translates its own.

## Risks

1. **Codex's own sub-agents cannot be turned off** (§3). The tier rule "agents never get the CLI's
   own sub-agent tools" breaks unless a switch is found or enforcement by interrupt is acceptable.
   This is the biggest blocker.
2. **The protocol is experimental and changes per version**, and `dynamicTools` is explicitly
   experimental. Pin the version, vendor the generated types, feature-detect at `initialize`, and
   keep MCP over HTTP as a fallback for team tools.
3. **Inherited settings can bypass the cards.** The person's `approvals_reviewer` (auto review) or
   `approval_policy=never` would hide approvals. Masthead must force `approvalsReviewer:"user"` or
   say plainly that inherit means Codex's own reviewer.
4. **Usage-limit behaviour is unseen.** The `usageLimitExceeded` path, and whether the thread stays
   usable after it, are untested. `resetsAt` arrives in seconds, as with Claude.
5. **One shared app-server** is a single point of failure for every Codex agent. Load with many
   active threads is untested.
6. **Clutter and cost.** Every agent's thread lands in the person's Codex history. The baseline is
   about 16–19k input tokens per turn before Masthead's own text.
7. **Terms for third-party drivers are unknown** (§8).

## Must be tested live before 0.2.0 ships

- A full team (lead Astra, then Sol, then Luna) through Masthead: spawn, report, `send_message`
  `wait:true`, stop, and stop-everything across Codex threads.
- **Steer races:** steer arriving at turn end (expect a precondition failure, then fall back to
  `turn/start`); steer during an approval; `activeTurnNotSteerable` turns.
- **Sub-agent enforcement:**
  - Does any config remove the `collaboration.*` tools? Capture the real tool list with the
    notification `rawResponse/completed` or `experimentalRawEvents`.
  - Does a `collabAgentToolCall` go through approval?
  - Does interrupting cleanly stop a spawned Codex sub-agent?
- **Approvals:** file change, permissions, network amendment, `acceptForSession`, cancel on Stop,
  and `serverRequest/resolved` when Codex withdraws a request.
- **Usage limit:** the turn status, `codexErrorInfo` and the rate-limit notification at a real
  limit, and resuming afterwards.
- **Sessions:** resume after an app-server restart, missing rollout file → fresh start, compaction
  on a long thread, `thread/name/set` naming.
- **Lean config:** which of the person's servers and plugins can be disabled per thread
  (`cua_repl` could not), and the token saving.
- **Background commands:** `commandExecution` with a long-running process; what Codex reports
  (`process/*`, `terminalInteraction`) and whether a turn starts by itself when it ends.
- **Images:** data URL input, and image output from a dynamic tool.
- **Concurrency:** 10+ active threads on one app-server (overload `-32001`), and the process dying
  mid-turn.

## Sub-agents: settled

Added 2026-11-27 by bravo. The test agents ran on `gpt-6-luna` at low effort with ephemeral sessions; `~/.codex/sessions` has no files for the day afterwards.

### The real tool list

`codex debug prompt-input [-c …] "hi"` prints the model-visible input as JSON without calling the model, so it costs nothing. Its first item is `{"type":"additional_tools","role":"developer","tools":[…]}`, which is the real tool list. With the default catalog and `model="gpt-6-luna"` it contains:

```
functions.{exec,wait,request_user_input,request_user_input_async}  clock.sleep
collaboration.{followup_task,interrupt_agent,list_agents,send_message,spawn_agent,wait_agent}  mcp__cua_repl.{js,js_reset}
```

(`tool_mode: code_mode_only`: other tools are reached from inside `functions.exec`.) The names were extracted with `/tmp/codex-exp/names.py`.

### Switches tried (6 = all collaboration tools present)

| Switch | collaboration.* |
|---|---|
| none | 6 |
| `--disable multi_agent` / `multi_agent_v2` / both / `--enable multi_agent_v2` | 6 |
| `-c agents.max_depth=0` | 6 |
| `-c agents.max_concurrent_threads_per_session=1` | 6 |
| `-c agents.max_concurrent_threads_per_session=0` | error: "must be at least 1" |
| `--disable collaboration_modes`, `runtime_agent_instances`, `code_mode_host`; `--enable code_mode_only`; `-c tools.collaboration=false` | 6 |
| `-c model="gpt-5.6-luna"` (catalog `multi_agent_version` v1) | 0 |
| **`-c model_catalog_json="/path/catalog.json"`**, a copy of `codex debug models` with `multi_agent_version: null` (or `"none"`) on every model | **0** |

These tools come from the model catalog (`multi_agent_version: "v2"` on current models), not from features. `codex debug models` shows the field.

### Proof in app-server

Run: `codex app-server -c model_catalog_json='"…/cat-nomulti.json"'`, with the prompt "Call the tool collaboration.list_agents once".

- **Default catalog:** the model calls it and answers "OK".
- **Override:** the model answers "I couldn't find `collaboration.list_agents` in the available tools."

### Recommended switch (process-level)

1. At start-up, run `codex debug models`.
2. Set `multi_agent_version` to null on every entry and write the result to Masthead's own data folder.
3. Start `codex app-server -c model_catalog_json="<that file>"`.
4. Never send the `ultra` effort.

The catalog comes from the person's own account, so model access is unchanged.

Unverified:

- Whether the override also works per thread (`thread/start.config`). Assume it works only per process.
- Whether the frozen catalog misses later server-side catalog updates. Regenerate it each time the app-server starts.
- Whether a future CLI renames the field. Check at start-up that the debug prompt input of a test thread holds no `collaboration.*`, and fall back to enforcement if it does.

### Fallback if the switch ever fails

What a native spawn emits, observed with the prompt "spawn a helper, wait, report":

```
item/started {"type":"subAgentActivity","kind":"started","model":"gpt-6-luna","agentThreadId":"01a21bb5-…"}
turn/started for a NEW threadId (the child), its own items, turn/completed
item/started {"type":"collabAgentToolCall","tool":"wait","senderThreadId":…}
item/started {"type":"subAgentActivity","kind":"completed","agentThreadId":…}
```

- **No approval request was raised.** There is no `requestApproval` for collab calls, so a host cannot decline them; the approval path is not an option.
- **Enforcement:**
  - On any `subAgentActivity` (kind started) or `collabAgentToolCall` item, `turn/interrupt` both the parent turn and the child thread (by `agentThreadId`).
  - Then steer or start a turn in the parent: "Codex's own sub-agents are not allowed; use spawn_agent."
- **Cost:** the child's first model call is already spent. In the test the child reached `turn/started` 0 s after the parent's spawn item (child id `…1335`), and the whole child turn took about 3.7 s. Each violation is roughly one wasted child turn plus one corrective parent turn.

### Side answers

**Background commands.** Asked to start `sleep 10; echo BG-DONE` in the background:

- The model ran `nohup sh -c '…' > bg-done.log &` as an ordinary `commandExecution`, which completed at once with exit 0.
- The turn completed, and no further turn or `process/*` event followed in the next 20 s.
- So Codex does not track detached work and does not wake the agent. Masthead needs no background-wait state for Codex, and the agent must be told to poll if it cares.

**Several active threads in one app-server process: yes.**

- Two threads were started together; both emitted `turn/started` at 0.5 s.
- One finished at 4.0 s while the other ran a command and finished at 6.9 s, with events interleaved by `threadId`.
- In the sub-agent run, parent and child threads were also active at the same time.

Load at 10 or more threads is untested.
