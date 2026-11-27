# 0.2.0: the agent backend layer

> **History.** This plan was built in 0.2.0. It is kept as the record of the design and the evidence; where it
> differs from the code, the code and `docs/wiki/` are right.

Status: design, 2026-11-27, by echo. It has not been built or tested. It covers how Masthead runs one agent on
more than one backend: Claude Code today (`server/agent.ts`), and the OpenAI Codex CLI next. The team
core (state machine, tiers, storage, protocol) is in [core.md](core.md) by foxtrot; the facts about Codex are
in [codex.md](codex.md) by bravo. The core/backend seam below was agreed with foxtrot by message, and the names
match core.md. Where a Codex fact is needed, this page says what it relies on, and §11 lists what is still
open.

## 1. Layers

```
Conversation (core: team rules, statuses, slots policy, pause decisions, report delivery)
   │  owns one per agent
AgentRuntime (generic, backend-agnostic: message ids, unanswered, held, generation, run texts,
   │          background grace, fresh-session retry, usage-limit rule, items/activity/drafts)
   │  talks only to
Session  ← opened by → Backend (one adapter per CLI: claude-code, codex; plus fake for tests)
```

- **Core** knows teams and nothing about any CLI.
- **AgentRuntime** knows one agent's conversation with one session, and nothing about CLIs or teams. It is
  today's `Agent` minus SDK parsing and option building. Every rule that was worked out against the real
  Claude Code in 0.1.1–0.1.4 and is not specific to it lives here, once, for all backends.
- A **Backend adapter** turns one CLI's protocol into the neutral events below, and back. It holds no team
  state and decides nothing about when a run is over.

## 2. File layout

```
server/backends/
  types.ts            Backend, Session, SessionSpec, SessionEvents, BackendCaps, ModelInfo, PermissionAsk …
  registry.ts         the list of adapters; detect all at start; pick by id
  runtime.ts          AgentRuntime (from agent.ts)
  tools/
    defs.ts           ToolDef: name, description, JSON schema (from zod), run(input) bound to one agent
    sdk-transport.ts  ToolDef[] → createSdkMcpServer (in-process, Claude Code)
    http-transport.ts ToolDef[] → streamable-HTTP MCP endpoint on 127.0.0.1, per-session token (Codex)
  claude-code/
    index.ts          detect(), models(), caps, open()
    session.ts        query() lifecycle, input Channel, close/interrupt/setEffort/setModel
    events.ts         SDKMessage → SessionEvents (init, stream, assistant, user tool results,
                      result, rate_limit_event, background_tasks_changed, …)
    options.ts        SessionSpec → Options (lean → strictMcpConfig, deny list, canAskPerson, effort map)
    errors.ts         MISSING_SESSION text match, stderr tail
  codex/              (after the migration; same four files)
test/
  fake-backend.ts     FakeBackend/FakeSession: scripted events, records sends (replaces the host.query seam)
  backend-conformance.ts  shared suite run against each adapter (fake always, real ones in live runs)
```

## 3. The interface

```ts
// server/backends/types.ts
import type { Effort } from '../../shared/protocol.js';

export type BackendId = 'claude-code' | 'codex' | (string & {});

export interface BackendInfo {
  id: BackendId;
  label: string;                 // "Claude Code", "Codex"
  path: string | null;           // the binary found
  version: string | null;
  signedIn: boolean | null;      // null = could not tell
  account?: string;              // plan or organisation as the CLI reports it; never credentials
  minVersion: string;
  error?: string;                // shown on the page when unusable (missing, too old, signed out)
}

export interface BackendCaps {
  midTurnDelivery: boolean;      // a message can join the running turn (Claude: yes)
  consumedIds: boolean;          // a turn result names the message ids it consumed
  background: boolean;           // reports background tasks (Claude: background_tasks_changed)
  liveEffort: boolean;           // effort can change on a live session
  liveModel: boolean;            // model can change on a live session
  resume: boolean;               // a session can be resumed by id after its process ends
  images: boolean;               // image input
  interrupt: boolean;
  approvals: 'callback' | 'mode-only' | 'none';  // can ask the host per tool call
  approvalsAlways: boolean;      // "allow always" exists
  questions: boolean;            // the agent can ask the person a multiple-choice question
  contextUsage: boolean;         // real context size can be read
  lean: boolean;                 // can run with only Masthead's tools (no user connectors)
}

export interface ModelInfo {
  id: string;                    // passed back in SessionSpec.model
  label: string;
  efforts: Effort[];             // Masthead levels this model supports (subset of low..xhigh)
  nativeEffort: Partial<Record<Effort, string>>;  // Masthead level → the backend's own value
  contextWindow?: number;
  isDefault?: boolean;
}

export interface Backend {
  readonly id: BackendId;
  readonly caps: BackendCaps;
  detect(): Promise<BackendInfo>;
  models(): Promise<ModelInfo[]>;          // cached by the registry; refreshed on demand
  open(spec: SessionSpec, events: SessionEvents): Session;
}

export interface SessionSpec {
  resume?: string;               // backend session id
  model: string;
  effort: Effort;                // adapter maps through ModelInfo.nativeEffort
  cwd: string;
  env: Record<string, string | undefined>;   // agentEnv(): no credentials added or removed
  instructions: string;          // Masthead's system-prompt addition (prompts.ts)
  tools: ToolDef[];              // bound to this agent; see §5
  permissionMode: 'inherit' | 'default' | 'acceptEdits' | 'bypassPermissions';
  canAskPerson: boolean;         // false for non-leads (Claude: disallow AskUserQuestion)
  lean: boolean;                 // only Masthead's tools, no user MCP connectors
}

export type Content = string | Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string }>;

export interface Session {
  /** Queue a message. With caps.midTurnDelivery false the runtime only calls this between turns. */
  send(id: string, content: Content): void;
  interrupt(): Promise<void>;
  setEffort(effort: Effort): Promise<void>;          // rejects if !caps.liveEffort
  setModel?(model: string): Promise<void>;           // only if caps.liveModel
  contextUsage?(): Promise<{ used: number; max: number }>;
  close(how: 'graceful' | 'now'): void;              // graceful: end input, let it finish
}

export interface SessionEvents {
  sessionStarted(id: string): void;                  // Claude: system/init session_id
  turnStarted(): void;                               // Claude: init or first stream/assistant frame
  draft(d: { kind: 'text' | 'thinking'; append: string } | { reset: true } | null): void;
  text(text: string, isError: boolean): void;        // a final text block
  thinking(text: string): void;
  toolStarted(t: { id: string; name: string; input: unknown }): void;
  toolFinished(t: { id: string; result: string; isError: boolean; images?: number }): void;
  usage(u: { context?: number; outputDelta?: number; costUsd?: number }): void;
  rateLimit(n: { status: 'allowed' | 'allowed_warning' | 'rejected'; type?: string; utilization?: number; resetsAtMs?: number }[]): void;
  background(activeTaskIds: string[]): void;         // full set, replace semantics, non-ambient only
  compacted(): void;
  activity(text: string | undefined): void;          // backend-specific states, e.g. "Compacting"
  turnEnded(r: {
    consumed: string[] | null;   // null = this backend cannot tell (runtime applies the fallback rule)
    text: string;                // the turn's final text
    error?: string;
    apiError?: 'rate_limit' | 'overloaded' | 'auth' | 'billing' | 'other';
    interrupted: boolean;
    selfStarted: boolean;        // no message of ours started it (Claude: origin task-notification)
  }): void;
  exited(r: { failure?: string; sessionMissing?: boolean; startupReason?: string }): void;
  askPermission(ask: PermissionAsk): Promise<PermissionDecision>;
}
```

The core talks to the runtime, never to a `Session`: `runtime.send(content, { urgent? })` (while paused it
holds the message unless `urgent`, i.e. the person's own), `pause()`, `resume(note)`, `dropHeld()`,
`interrupt()`, `end(status)`, `applySettings(s)`, and reads `busy`, `hasBackgroundWork`, `inTurn` (set by
`turnStarted()`, which the core uses for "already in a turn"). The core keeps `pausedUntil` and pause counts
(core.md §2.4).

`Backend.open()` must not throw for an ordinary failure; it reports `exited({ failure })` instead, so the
runtime has one failure path. Adapters never call core, never see `Agent`, `Tier` or names.

## 4. Where everything `Agent` does today lands

| Today in `server/agent.ts` | Lands in | Notes |
|---|---|---|
| `Channel<T>` input stream, streaming input mode | claude-code/session.ts | Codex adapter does its own queueing |
| message `uuid` per send; `unanswered` set; `busy` | runtime | ids are the runtime's; Claude uses them as SDK `uuid` |
| consumed-id rule (named ids; none named = self-started or old CLI; `namesConsumed` fallback) | runtime | adapter passes `consumed` or `null`; with `caps.consumedIds` false the runtime treats the batch it sent for that turn as consumed |
| `backlog`, `seed`, `pendingSeed` | runtime | |
| `generation` ghost-start guard, slot acquire/wait for `exited` | runtime | slot policy stays in core's Scheduler |
| `launch()` settings read: lead model, effort cap/auto | runtime (policy) + options.ts (mapping) | runtime builds `SessionSpec`; adapter maps effort through `nativeEffort` |
| `DISALLOWED` list, `AskUserQuestion` for non-leads | claude-code/options.ts | generic intent in spec: tools are Masthead's only way to start work, `canAskPerson` |
| `strictMcpConfig` lean mode | claude-code/options.ts from `spec.lean` | `caps.lean` false = page says connectors stay loaded |
| `systemPrompt.append` | spec.instructions → options.ts | Codex: its instructions/developer-message slot (codex.md) |
| `canUseTool` → host.askPermission | adapter → `events.askPermission` (neutral) | §6 |
| stderr tail; `MISSING_SESSION` text | claude-code/errors.ts → `exited({ sessionMissing })` | the match is backend-specific |
| fresh-session retry once, note to agent, re-send unanswered | runtime | triggered by `sessionMissing` before `sessionStarted` |
| `init` → session id, status running unless paused | adapter: `sessionStarted` + `turnStarted`; runtime: status | the `pausedUntil` guard is runtime/core |
| stream events → draft (70 ms throttle), usage | adapter emits deltas; runtime throttles | throttling is UI policy, generic |
| assistant blocks → text/thinking/tool items, `turnText`, `turnError` | adapter → `text`/`thinking`/`toolStarted`; runtime builds Items | `describeTool()` stays generic |
| tool results → item done, clip 12,000, activity cleared | adapter `toolFinished`; runtime clips and clears | |
| `rate_limit_event` + `unifiedWindows` (seconds → ms) | adapter parses to neutral list; runtime keeps `rejected` | units fixed in the adapter |
| usage-limit rule (latest rejected + rate-limit error), close at the limit, `held`, `dropHeld`, `backgroundStopped`, repeat results | runtime | one rule for all backends; needs `apiError` and `rateLimit` from the adapter |
| `background_tasks_changed` set; 3 s grace; `backgroundIdle` | adapter emits set; runtime runs grace | `caps.background` false = never waiting on background |
| run texts (8 turns / 60k), "(earlier text not shown)" | runtime | |
| `applySettings`: effort cap, lead model via `setModel`, stale → relaunch between turns | runtime | uses `caps.liveEffort/liveModel`; falls back to stale relaunch when not live |
| `interrupt()`, `end()`, `dispose()` | runtime → `Session.interrupt/close` | `end('done')` with background → `close('now')` |
| `refreshContext()` at every turn end | runtime → `Session.contextUsage?` | skipped when `caps.contextUsage` false |
| `compact_boundary` notice, compacting activity | adapter `compacted()`/`activity()` | |
| `host.query` test seam | removed: FakeBackend | §8 |

## 5. Team tools: one implementation, two transports

`server/tools.ts` today builds an SDK MCP server per agent with zod schemas. In 0.2.0:

- `tools/defs.ts`: `teamToolDefs(agent, team): ToolDef[]`, `ToolDef = { name, description, schema (zod), run(input): Promise<{ text: string; isError: boolean }> }`. `run` closes over the calling agent, so the
  caller is never named in a request and cannot be forged by the model.
- `sdk-transport.ts` (Claude Code): `createSdkMcpServer({ name: 'masthead', tools })`, as today, in process.
- `codex/tools.ts` (Codex, preferred): `thread/start` takes `dynamicTools`; Codex sends the server request
  `item/tool/call {threadId, turnId, callId, tool, arguments}` over the same stdio JSON-RPC pipe and the host
  answers `{contentItems:[{type:'inputText',text}], success}` (bravo verified it, 1 ms round trip; experimental
  API). The `threadId` selects the session's `ToolDef[]`, so the caller is tied by the pipe itself: no port, no
  token. This is the plan of record for Codex.
- `http-transport.ts` (fallback only, if `dynamicTools` is removed from the experimental API): one streamable-HTTP MCP endpoint in the Masthead server, bound to 127.0.0.1
  on its own random port (never the page's port, never 7717). Each session gets a random 256-bit token;
  the server maps token → that session's `ToolDef[]`. The adapter passes the URL and an
  `Authorization: Bearer` header in the session's MCP config. A request without a valid token gets 401. The
  token dies with the session. The endpoint checks `Host` like http.ts does and accepts no browser `Origin`.
  Codex's config reference lists `mcp_servers.<id>.url` with `http_headers` / `bearer_token_env_var` (not
  tested live). A further fallback is a stdio child
  (`masthead mcp-bridge --token …`, our own script) that relays to the same endpoint over a Unix socket in
  the data folder (mode 0600): same tool code, transport only.
- Masthead's own tools are always allowed without asking the person (today's `mcp__masthead__` check moves
  into the runtime: a `PermissionAsk` for a tool in `spec.tools` is answered allow without the page).

Rejected: running the Codex agent's tools by parsing its text output (fragile, no schema); one shared token for
all agents (any agent could act as another); a public port or 0.0.0.0 (other machines).

## 6. Approvals: one shape

```ts
export interface PermissionAsk {
  kind: 'command' | 'file' | 'tool' | 'question';
  toolName: string;                 // as the backend names it, for display
  input: unknown;
  title?: string;
  description?: string;
  canAlways: boolean;               // backend offers a remembered rule
  questions?: Question[];           // kind 'question' (shared/protocol.ts shape)
  signal: AbortSignal;              // backend withdrew the request
}
export interface PermissionDecision {
  decision: 'allow' | 'always' | 'deny';
  answers?: Record<string, string>;
  message?: string;
}
```

`app.ts` keeps the pending map and the page protocol unchanged (`PermissionRequest` gains `backend`). Claude
adapter: `canUseTool` → `PermissionAsk` (`AskUserQuestion` → question; `suggestions` → `canAlways`, kept in
the adapter to send back as `updatedPermissions` on `always`). Codex adapter maps its command/patch approval
requests to the same shape: `item/commandExecution/requestApproval` → `kind: 'command'`,
`item/fileChange/requestApproval` → `kind: 'file'`, `item/tool/requestUserInput` → `kind: 'question'`; `allow`
→ `accept`, `always` → `acceptForSession` (when listed in `availableDecisions`), `deny` → `decline`, withdrawal
→ `cancel` (codex.md). With `approvals: 'mode-only'` the
page shows the backend's mode (e.g. read-only/workspace-write/full) instead of per-call cards.

## 7. Models, efforts, detection, health

- **Catalogue.** `Backend.models()` returns what the signed-in user can use. Claude Code:
  `Query.supportedModels()` (`ModelInfo.value`, `displayName`, `supportedEffortLevels`; sdk.d.ts) from a
  short-lived streaming-input session that is sent no message, cached for the run and refreshed from the
  settings page. Not yet tried: whether `supportedModels()` answers before any message is sent; if it
  does not, read it from the first real session and cache it.
  Codex: `model/list` (`id`, `displayName`, `supportedReasoningEfforts`, `defaultReasoningEffort`,
  `inputModalities`, `isDefault`, `hidden`; hidden ones left out). Settings store `{ backend, model }` per tier; a saved model that is no longer listed is
  shown as unavailable instead of silently replaced.
- **Effort.** Masthead keeps four levels (no `max`). Claude Code: identity map, filtered by
  `supportedEffortLevels`. Codex: identity for `low|medium|high|xhigh` where `supportedReasoningEfforts`
  lists them; Codex's `max` and `ultra` are never offered (`ultra` is "maximum reasoning with automatic task
  delegation", a route round the tiers). A level a model lacks is
  capped to the nearest lower one, and the page says so.
- **Detection.** `detect()`: binary search as `findClaude()` does (env override `MASTHEAD_CLAUDE`,
  `MASTHEAD_CODEX`, PATH, known install paths), `--version`, compare with `minVersion`, signed-in check
  (Claude: `accountInfo()` from the catalogue session; Codex: `account/read` over app-server, or
  `codex login status`), never reading token files. Codex minimum: pin 0.172.0 and vendor the protocol types
  generated by `codex app-server generate-ts`, since the protocol is generated per version and marked
  experimental.
  Run at start and on "Check again" in settings. `AppState.claude` becomes `AppState.backends: BackendInfo[]`
  (keep `claude` one release for old pages).
- **Page.** A missing or signed-out backend greys out its models in tier settings with the `error` text and
  the command to fix it (`claude` / `codex login`); conversations whose lead uses it cannot start. A tier set
  to an unavailable backend fails a spawn with a clear error to the parent, as an Off tier does today.

## 8. Testing

- **FakeBackend** (`test/fake-backend.ts`): implements `Backend`; `open()` returns a FakeSession that records
  `send` calls and exposes `emit.*` for every `SessionEvents` method, plus `caps` set per test. It replaces
  the `host.query` seam and the SDK-shaped fake in `test/agent.test.ts`; those tests are ported to drive the
  runtime through neutral events (same assertions). Core tests (`conversation.test.ts`) can then run real
  runtimes on a fake backend instead of calling `turnEnded` by hand.
- **Scripted fake for whole-app runs** (`server/backends/fake/`, Node, no shell, so it runs on Windows): an
  in-process `Backend` registered only when `MASTHEAD_FAKE_BACKEND=1` is set, never in a normal start. It
  answers by rules on the message text: plain reply, `[[tool:spawn_agent {...}]]` calls a team tool through
  the real `ToolDef`, `[[background 2s]]` reports a background task and a self-started turn, `[[limit 60s]]`
  produces a usage-limit turn, `[[ask]]` a permission request. Used by `ui.e2e.mjs` and CI smoke tests
  without any account (distribution.md).
- **Adapter unit tests**: `claude-code/events.ts` is pure (SDKMessage in, events out), tested with recorded
  real message sequences (the ones captured in 0.1.2–0.1.4: background, missing session, rate-limit events).
- **Conformance suite** (`test/backend-conformance.ts`): `runConformance(backendFactory, { live })`. Cases:
  start and answer; resume by id; missing session → `exited({ sessionMissing })` before `sessionStarted`;
  send during a turn (if `midTurnDelivery`) consumed by the next result; interrupt; close graceful/now;
  tool call through `spec.tools` with the right caller; permission ask round trip; images (if `images`);
  setEffort/setModel (if live); background set and self-started turn (if `background`); context usage.
  Runs against FakeBackend in `npm test`, against each real adapter in `npm run test:live -- --backend=…`
  with the cheapest model.
- **Live**: today's `test/live.e2e.ts` scenarios parameterised by backend for lead and tiers; a mixed team
  (lead on one backend, a tier on the other) once Codex exists.

## 9. Migration, each step keeping `npm test` (118), the live run and `ui.e2e.mjs` green

| # | Step | Behaviour change | Estimate |
|---|---|---|---|
| 1 | Add `backends/types.ts` and `test/fake-backend.ts`; no callers yet | none | 0.5 d |
| 2 | Extract `claude-code/events.ts`: move the SDK-message switch out of `Agent.handle()` into a pure translator that calls neutral events; `Agent` implements `SessionEvents` | none; recorded-sequence tests added | 1 d |
| 3 | Extract `claude-code/session.ts` + `options.ts` + `errors.ts`: `query()`, Channel, options, stderr, close/interrupt/setEffort/setModel behind `Session`; `Agent` calls `backend.open()`; `host.query` kept as a thin shim | none | 1 d |
| 4 | Rename `Agent` → `AgentRuntime` in `backends/runtime.ts` (re-export `Agent` for one step); port `agent.test.ts` to FakeBackend; delete `host.query` | none | 1 d |
| 5 | Tools: `tools/defs.ts` + `sdk-transport.ts`; `teamTools()` becomes defs + transport | none | 0.5 d |
| 6 | Approvals: neutral `PermissionAsk`; `askPermission` translation moves from `app.ts` into the Claude adapter | none | 0.5 d |
| 7 | Detection/registry: `detect()` replaces `findClaude()`; `AppState.backends` added beside `claude` | page shows the same | 0.5 d |
| 8 | Catalogue: `models()` via `supportedModels()`; settings validated against it; tier settings list real models | tier model picker from data | 1 d |
| 9 | Conformance suite against FakeBackend and (live) Claude Code | none | 1 d |
| 10 | (only if needed) `http-transport.ts`, proven first with Claude Code (`McpHttpServerConfig` has `type: 'http'`, `url`, `headers` in sdk.d.ts) behind a dev flag, so the transport is tested before Codex | none by default | 1 d |
| 11 | Codex adapter over `app-server` with `dynamicTools`, vendored generated types, then a Codex live run and conformance | new backend | 4–5 d |

Steps 1–9 are a refactor of about 7 days; nothing a person sees changes except the model picker (step 8).

## 9a. Codex mapping (from bravo's research, codex-cli 0.172.0)

| Interface | Codex `app-server` (JSON-RPC 2.0, NDJSON over stdio; one process can serve many threads) |
|---|---|
| open / resume | `initialize` + `initialized`; `thread/start {config, dynamicTools, …}` → `thread.id`; `thread/resume {threadId}`; missing thread = error -32600 "no rollout found for thread id" → `exited({ sessionMissing })` |
| lean | per-thread `config` with `mcp_servers.<name>.enabled=false` for the user's servers (verified) |
| send (between turns) | `turn/start {threadId, input, model?, effort?}` |
| send (mid-turn) | `turn/steer {threadId, expectedTurnId, input}` (verified); `activeTurnNotSteerable` → queue for the next `turn/start` |
| consumed ids | not reported; the runtime counts the ids it put into each `turn/start`/`turn/steer` as that turn's (caps.consumedIds false) |
| events | `turn/started` → turnStarted; `item/agentMessage/delta`, `item/reasoning/*Delta` → draft; `item/completed` agentMessage (final_answer) → text, reasoning → thinking, commandExecution/fileChange/mcpToolCall/dynamicToolCall → toolStarted/Finished; `turn/completed {status, error.codexErrorInfo}` → turnEnded; `thread/tokenUsage/updated` → usage + context; `thread/compacted` → compacted |
| usage limit | `account/rateLimits/updated` (primary/secondary `{usedPercent, resetsAt (s)}`) → rateLimit; `codexErrorInfo: usageLimitExceeded` → `apiError: 'rate_limit'` (not seen for real) |
| interrupt / close | `turn/interrupt {threadId, turnId}`; close = end the thread's use (one shared process per backend, killed when no threads remain) |
| live effort / model | per `turn/start`; a mid-turn change applies from the next turn (caps.liveEffort and liveModel true, between turns only) |
| images | `UserInput {type:'localImage', path}` (written to a temp file in the data folder) or data URL |
| background | unknown (`process/*`, `terminalInteraction` seen): caps.background false until proven |
| questions | `item/tool/requestUserInput` → question (lead only; refused for others) |
| caps | midTurnDelivery true (steer), consumedIds false, background false, liveEffort/liveModel true, resume true, images true, interrupt true, approvals 'callback', approvalsAlways true, questions true, contextUsage true, lean true |

Collaboration tools (`collabAgentToolCall`, `ultra` effort) are Codex's own sub-agents: the adapter turns
them off in the thread config so the tiers stay Masthead's (exact keys to confirm in codex.md).

## 10. Alternatives rejected

- **Keep `Agent` as is and add `if (codex)` branches.** Every rule (usage limit, held messages, background
  grace) would be written twice and drift; the 0.1.x bugs were exactly in these rules.
- **Adapters own "turn finished".** The consumed-id, self-started and older-CLI rules took four releases to
  get right; they belong in one place. Adapters report facts only.
- **Adapters emit protocol `Item`s.** It would tie every adapter to the page format and let an adapter shape
  UI; neutral events keep the page's look in one place.
- **A generic "agent framework" dependency** (LangChain-style or an SDK abstraction): Masthead runs the
  person's own CLIs unmodified; a framework would add a layer between us and the CLI semantics we depend on.
- **Driving Codex through a terminal (pty) and screen-scraping.** No structured events, no ids; rejected in
  favour of whatever structured interface codex.md finds.

## 11. Risks and open questions

- **Codex `app-server` is marked experimental**, and `dynamicTools` is in its experimental API: a CLI update
  can break the adapter. Pin a tested version range, vendor generated types, run Codex conformance on every
  Codex upgrade, and keep the HTTP MCP transport as the fallback for tools.
- **Not yet seen for real on Codex**: the usage-limit turn (`usageLimitExceeded`), background commands, HTTP
  MCP with headers, and how to turn off its collaboration sub-agents.
- **No mid-turn delivery** on a backend changes team feel: reports to a busy parent wait for its turn to
  end. The runtime batches them; the core may want to say so in `list_agents`.
- **`supportedModels()` needs a running Claude Code session**: a catalogue refresh costs a process start
  (no model request). Acceptable at start-up and on demand; not per page load.
- **Mixed teams and limits**: usage limits are per backend; a Codex limit must not pause Claude agents. The
  runtime's rule is per session already; core must key `usage` notices by backend.
- **Security of the HTTP transport**: loopback only, per-session token, Host check, no CORS; covered by unit
  tests like `http.test.ts` and by the conformance "caller" case.
- **Behaviour drift in the refactor**: mitigated by steps that change no behaviour and by recorded real
  message sequences as fixtures.
