# shared/protocol.ts

**Role:** the types and small helpers that the server and the browser share. The file's first comment sets its one rule: nothing in it may import Node or browser (DOM) APIs, so both sides can import it. Every message on the WebSocket is defined here, so the compiler catches any mismatch between the page and the server.

The message types themselves (`ClientMsg`, `ServerMsg`, `Item`) are explained on [Browser/server protocol](Browser-Server-Protocol.md). This page covers the rest.

## Version

`VERSION = '0.1.1'`. Used by the health endpoint, the launcher, `AppState`, the `CLAUDE_AGENT_SDK_CLIENT_APP` variable (`agentEnv()` in `server/config.ts`) and the team-tool server's version (`server/tools.ts`).

## Tiers

- `Tier` = `'lead' | 'opus' | 'sonnet' | 'haiku'`. `TIERS` lists them from the top down.
- `CHILD_TIER`: which tier each one may start (lead → opus → sonnet → haiku → `null`).
- `TIER_LABEL`: fixed display names: "Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5". The only remaining use is in the accessible labels of the team panel's +/− buttons (`web/src/lib/TeamPanel.svelte`). Everything else shows names made by `modelLabel()`.
- `modelLabel(model)`: turns a model id into the name people use. `claude-opus-5-5` becomes "Opus 5.5", `claude-opus-5` becomes "Opus 5", and `claude-sonnet-4-5-20250929` becomes "Sonnet 4.5". It recognises the families fable, mythos, opus, sonnet and haiku; any other id is shown unchanged. Because of this, the tier names in prompts, tool replies and on the page follow whatever model the settings name.

## Agent names

Agents are not named by whoever starts them. Each conversation hands out names in order from the radio spelling alphabet:

- `AGENT_NAMES`: `alpha`, `bravo`, `charlie`, … `xray`, `yankee`, `zulu`. The code uses the common English spellings `juliet` and `xray`, which are easy to type.
- `agentName(n)`: the name of the nth agent in a conversation. 0 is the lead, so the lead is always `alpha`. After `zulu` (n = 25) a round number is added: `alpha-2`, `bravo-2`, …, then `alpha-3`.
- `displayName(name)`: the form people see, with a capital first letter ("Bravo").

The person and the agents can then refer to any agent by a short name they can say. See [Team rules](Team-Rules.md#names-and-titles).

## Effort

- `Effort` = `'low' | 'medium' | 'high' | 'xhigh'`. `EFFORTS` holds them in order and `EFFORT_LABEL` gives the display names (`xhigh` is shown as "Extra"). There is deliberately no `max` level. A comment saying so sits just above `modelLabel()`'s comment in the file, away from the `Effort` type it describes.
- `effortRank(e)`: the level's position (0–3), used for comparisons.
- `capEffort(wanted, ceiling)`: the lower of the two levels.

See [Thinking effort](Thinking-Effort.md).

## Settings

- `TierSettings`: `model`, `effort` (a ceiling or a fixed level, depending on `autoEffort`) and `max` (ignored for the lead).
- `PermissionChoice` / `PERMISSION_CHOICES`: `inherit`, `default`, `acceptEdits`, `auto`, `bypassPermissions`.
- `Settings`: `tiers`, `permissionMode`, `autoEffort`, `leanSubagents` (Sonnet and Haiku skip the person's own MCP servers), `leanOpus` (Opus agents skip them too), `collapseReports` (reports are shown folded shut until the person opens them), `defaultCwd`.
- `MAX_PER_TIER = 12`: the highest allowed `max`.

See [Configuration and settings](Configuration-and-Settings.md).

## Agents

- `AgentStatus`: `queued`, `running`, `waiting`, `idle` (lead only), `done`, `failed`, `stopped`. `LIVE_STATUSES` is the first three. See [Agent life cycle](Agent-Life-Cycle.md).
- `AgentUsage`: `context` (tokens in the context window at the latest request), `contextMax`, `output` (output tokens so far), `costUsd`, `turns`.
- `AgentInfo`: everything the page knows about an agent:
  - `id`, `convId`, `name`, `tier`, `parentId` (null for the lead);
  - `title`: a few words on its job, given by whoever started it (empty for the lead);
  - `task`: the first part of its task;
  - `status`, `model`, `effort`, `createdAt`, `endedAt?`, `usage`;
  - `activity?`: one line on what it is doing right now;
  - `error?`.

  The server's `Agent` object keeps one of these as `agent.info` and broadcasts it every time it changes.

## Transcripts

- `Item`, `NewItem`: see [Browser/server protocol](Browser-Server-Protocol.md#transcript-items-item). `NewItem` uses a conditional type to remove `id` and `ts` from each variant of `Item` separately. A plain `Omit` on the union would merge the variants.
- `Draft`: `{kind: 'text' | 'thinking', text}`, the block being streamed right now.

## Conversations, approvals and other shapes

- `ConversationMeta`: `id`, `title`, `cwd`, `createdAt`, `updatedAt`, `leadId`, and `busy?`, which is true while any agent in the conversation is live. `busy` is filled in by `App.metas()` when the list is sent and is never stored.
- `Question`, `QuestionOption`, `PermissionRequest`: see [Permissions and questions](Permissions-and-Questions.md).
- `ImageAttachment`: `mediaType` (PNG, JPEG, GIF or WebP) and the base64 `data`, without a `data:` prefix.
- `RateLimitNotice`: `status`, `type?`, `utilization?`, `resetsAt?` (seconds since 1970; the page multiplies it by 1000).
- `AppState`: `version`, `settings`, `conversations`, `claude` (`path`, `version`, `error?`), `home`, `pending` (every approval request and question still open, in any conversation) and `usage` (the latest `RateLimitNotice` of each limit type Claude Code has reported since Masthead started). The page uses `home` to show paths with `~` (`shortPath()` in `web/src/lib/store.svelte.ts`).
- In `ClientMsg`, `send` has an optional `ref`; in `ServerMsg`, both `created` and `error` carry `ref?`, so the browser can match a reply, or a refusal, to its own request.

## Related pages

[Browser/server protocol](Browser-Server-Protocol.md) · [shared/toolline.ts](Source-Shared-Toolline.md) · [Glossary](Glossary.md)
