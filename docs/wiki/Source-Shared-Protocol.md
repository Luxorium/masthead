# shared/protocol.ts and shared/protocol-v2.ts

**Role:** the types and small helpers that the server and the page share. Neither file may import Node or browser (DOM) APIs, so both sides can import them. Every WebSocket message is typed here, so the compiler catches a mismatch between page and server.

- `shared/protocol.ts`: the base types (tiers, team profiles, settings, agents, items, conversations, approvals) and the **version 1** messages `ClientMsg` / `ServerMsg`.
- `shared/protocol-v2.ts`: the messages that are new or changed in **protocol version 2**. Its header says it is kept separate while `protocol.ts` is being reworked and that "the two merge into one file before 0.2.0".

How the messages are used, step by step, is on [Browser/server protocol](Browser-Server-Protocol.md). This page lists what each file defines.

## shared/protocol.ts

### Version

`VERSION = '0.2.0-beta.2'`, the same as `package.json` on branch `next`. It is used by `server/main.ts` (the start-up line and `--version`), `AppState.version`, the `CLAUDE_AGENT_SDK_CLIENT_APP=masthead/<VERSION>` variable (`server/backends/claude/env.ts`) and the version of the team-tool MCP server (`server/backends/claude/mcp.ts`). `server/settings/settings.ts` imports it but does not use it.

### Tiers (the Claude shape)

- `Tier` = `'lead' | 'opus' | 'sonnet' | 'haiku'`, and `TIERS` lists them from the top down. These are now the ids of the built-in `claude` profile's tiers, kept as a type for code and pages that still use the 0.1.x shape.
- `CHILD_TIER`: which of these tiers each one may start (lead → opus → sonnet → haiku → `null`). For any profile, the general rule is `childTierOf()` below.
- `TIER_LABEL`: fixed names "Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5".
- `modelLabel(model)`: turns a model id into the name people use. `claude-opus-5-5` gives "Opus 5.5", `claude-opus-5` gives "Opus 5" and `claude-sonnet-4-5-20250929` gives "Sonnet 4.5". It recognises the families fable, mythos, opus, sonnet and haiku; any other id (a Codex model, for example) is shown unchanged.

### Team profiles

See [Team profiles and settings](Team-Profiles-and-Settings.md) for what these mean.

- `TierId = string`. Ids are unique across all profiles: `lead`/`opus`/`sonnet`/`haiku` for `claude`, `<profileId>:<index>` for the others.
- `PALETTE`: `amber`, `violet`, `blue`, `teal`, `rose`, `green`, `slate`, `orange`. These are colour slots; the page owns the real light and dark colours. `PaletteColour` is the union.
- `TierSpec`: `id`, `label`, `backend`, `model`, `effort` (the ceiling with automatic effort, the fixed level without), `max` (agents of the tier running at once, app-wide; ignored for the first tier), `lean` (skip the person's own MCP servers), `colour`.
- `TeamProfile`: `id`, `label`, `description?` (at most 200 characters), `builtIn`, `tiers` (index 0 is the lead; tier i starts tier i+1; the last starts nothing).
- `MAX_TIERS = 5`, `CLAUDE_PROFILE = 'claude'`.
- `profileOfTier(s, tier)`: the profile that holds the tier id.
- `findTier(s, tier)`: the `TierSpec` with that id, in any profile.
- `childTierOf(s, tier)`: the id of the next tier in the same profile, or null for the last tier or an unknown one.
- `isLeadTier(s, tier)`: whether the id is the first tier of its profile.

### Agent names

- `AGENT_NAMES`: `alpha`, `bravo`, `charlie`, … `zulu`. The spellings `juliet` and `xray` are used because they are easy to type.
- `agentName(n)`: the name of the nth agent in a conversation, where 0 is the lead (always `alpha`). After `zulu` a Roman-numeral round is added: `alpha-ii` … `zulu-ii`, then `alpha-iii`, and so on.
- `displayName(name)`: the form people see: "Bravo", "Alpha II".

See [Team rules](Team-Rules.md).

### Effort

- `Effort` = `'low' | 'medium' | 'high' | 'xhigh'`. `EFFORTS` holds them in order. `EFFORT_LABEL` gives the names shown, and `xhigh` appears as "Extra". There is deliberately no `max` level; the comment that says so sits just above `modelLabel()`.
- `effortRank(e)`: the level's position, 0–3.
- `capEffort(wanted, ceiling)`: the lower of the two.

### Settings

- `TierSettings`: `{ model, effort, max }`, the shape of one entry in the compatibility view `Settings.tiers`.
- `PermissionChoice` / `PERMISSION_CHOICES`: `inherit`, `default`, `acceptEdits`, `auto`, `bypassPermissions`.
- `Settings`: `version: 2`, `profiles`, `defaultProfile`, `tiers` (compatibility view of the `claude` profile), `permissionMode`, `autoEffort`, `leanSubagents` and `leanOpus` (compatibility view), `collapseReports`, `keepAwake`, `autoCompact` (tidy the team automatically; see [Compact team](Compact-Team.md)), `maxRunMinutes`, `defaultCwd`. Every field is explained on [Configuration and settings](Configuration-and-Settings.md).
- `MAX_PER_TIER = 12`.
- `SettingsPatch`: what a page sends in `{t:'settings'}`. Any field except `version`, with `tiers` allowed to be partial at both levels. The server merges it with `sanitizeSettings()` ([settings code](Source-Settings.md)).

### Agents

- `AgentStatus`: `queued`, `running`, `waiting`, `idle` (lead only), `done`, `failed`, `stopped`. `LIVE_STATUSES` is the first three. See [Agent life cycle](Agent-Life-Cycle.md) and [State machine](State-Machine.md).
- `AgentUsage`: `context`, `contextMax`, `output`, `costUsd`, `turns`.
- `AgentInfo`: `id`, `convId`, `name`, `tier` (typed as `Tier`, but for a non-claude profile it holds a `<profile>:<index>` string; `Conversation.create` casts it with `as Tier`), `parentId`, `title`, `task`, `status`, `model`, `effort`, `createdAt`, `endedAt?`, `usage`, `activity?`, `error?`, `waitingFor?` (the agent it is waiting to hear from), `pausedUntil?` (paused at a usage limit until about this time, in ms since 1970), `archived?` (ms since 1970: archived by a team compaction; such a helper cannot be woken, its chat stays readable through `read_archive` and the Archived helpers row, and the person may restore it).

### Transcripts

- `Item`: `user` (`text`, and `images?`, which is a **count** in 0.1.x files and a `BlobRef[]` from 0.2.0), `text`, `thinking`, `tool` (`name`, `input`, `result?`, `isError?`, `done`, `images?: BlobRef[]`), `inbound` (`via: 'task' | 'report' | 'message'`, `from`, `text`, `status?`), `notice` (`level: 'info' | 'error'`, `text`). Each item has an `id` and a `ts`.
- `NewItem`: an `Item` without `id`/`ts` (`id` optional). It is built with a conditional type so that each variant loses those fields separately; a plain `Omit` on the union would merge the variants.
- `Draft`: `{ kind: 'text' | 'thinking', text }`, the block being streamed now.

### Conversations, approvals and images

- `ConversationMeta`: `id`, `title`, `cwd`, `createdAt`, `updatedAt`, `leadId`, `profileId?` (0.2.0; missing in 0.1.x files, which means `claude`), `team?` (the profile's tiers copied when the conversation was created), and four fields for [team compaction](Compact-Team.md), all optional:
  - `compactSuggested?: boolean`: with automatic tidying off, the lead has been told once that it may suggest `/compact`; it is not told again.
  - `autoCompact?: false`: the person switched automatic tidying off for this conversation only. Absent means "follow the setting"; `true` is never stored (`Conversation.setAutoCompact(true)` removes the field).
  - `compactMark?: { finished, memoryArmed }`: the cool-down. `finished` is how many helpers had finished when tidying last fired (it fires again only after 15 more); `memoryArmed` is false until the lead's memory has dropped back below the 70 % mark.
  - `compact?: CompactState`: a compaction under way or just ended, saved so a restart carries on.

  And `busy?` (filled in when the list is sent, never stored).
- `CompactKeep`: `{ name, why, forced? }`, one helper the compaction keeps. `forced` marks helpers kept whatever the lead said: one still working (`why` "still working"), or one above a kept helper ("started bravo, which stays").
- `CompactState`: `id`, `phase` (`'asked' | 'proposed' | 'archiving' | 'compacting' | 'done' | 'cancelled'`), `auto` (automatic tidying was on when it started: no card), `reason?` ("the team has 16 finished helpers"), `askedAnswered?` (the lead has had a turn since being asked; if it ends another without choosing, the flow is cancelled), `keep: CompactKeep[]`, `archive: string[]` (names to archive, or archived), `note`, `pending: string[]` (agents still to compact, the lead last), `failed: Array<{ name, why }>`, `startedAt`. The phases are explained on [Compact team](Compact-Team.md).
- `QuestionOption`, `Question`, `PermissionRequest` (`kind: 'permission' | 'question'`, `canAlways`, `questions?`, …). See [Permissions and questions](Permissions-and-Questions.md).
- `BlobRef`: `{ blob, mediaType, w, h, bytes }`, an image stored on the server. `server/storage/blobs.ts` declares the same shape.
- `ImageAttachment`: `{ mediaType, data }`, the image as base64 without a `data:` prefix (images sent inline with a message).
- `RateLimitNotice`: `status`, `type?`, `utilization?`, `resetsAt?`.
- `AppState`: `version`, `settings`, `conversations`, `claude` (`path`, `version`, `error?`), `home`, `pending`, `usage`, and `blobToken?` (per socket; images load from `/blob/<convId>/<hash>?t=<blobToken>`).

### Version 1 messages

`ClientMsg` (page → server): `hello`, `open`, `items` (with optional paging `before`/`limit`; without `limit` the whole transcript comes back), `send` (`convId` null for a new conversation, `cwd?`, `text`, `images?`, `agentId?`, `ref?`, `blobs?` for images already uploaded, `profile?` for a new conversation), `interrupt`, `stop_agent`, `stop_all`, `permission`, `settings`, `reset_profile`, `rename`, `delete`, `dirs`.

`ServerMsg` (server → page): `state`, `conversations`, `conversation`, `created`, `deleted`, `items` (`cursor?`, `more?` when paged), `agent`, `item`, `draft` (whole text), `permission_request`, `permission_resolved`, `settings`, `rate_limit`, `dirs`, `error` (`code?` of `too_large`, `invalid`, `not_found`, `refused`, `protocol`, and `ref?`).

`server/app/app.ts` also sends and accepts messages that are only in the version 2 unions (`remote`, `check_backends`, and the compaction messages below). Those belong to [Remote access](Remote-Access.md) and the backend pages.

## shared/protocol-v2.ts

### Constants and small types

- `PROTOCOL_VERSION = 2`.
- `Capability`: `'drafts-delta' | 'items-paging' | 'blobs' | 'resync'`, what a version 2 page says it can handle.
- `ErrorCode`: `protocol`, `refused`, `not_found`, `too_large`, `invalid`.
- `CLIP_CHARS = 16 * 1024`: live `item` events clip tool input and output beyond this many characters; the page asks for the rest with `item_full`.
- `RING_SIZE = 500`: events kept per conversation so a reconnecting page can resync.
- `ApprovalSummary`: `{ id, convId, agentName, kind }`, enough for a badge on every conversation without sending the request itself.
- `Sequenced<T>` = `T & { seq: number }`: a per-conversation event with its sequence number.

### `ClientMsgV2` (page → server, in addition to version 1's)

| Message | Meaning |
|---|---|
| `{t:'hello', protocol, caps?}` | Says the page speaks protocol 2. A remote socket gets nothing until it has said this. |
| `{t:'subscribe', convId, since?}` | Start receiving one conversation's events. `since` is the last `seq` the page has, to replay from. |
| `{t:'unsubscribe', convId}` | Stop. |
| `{t:'draft_sync', convId, agentId}` | There was a gap in a draft's `dseq`; send the whole text once. |
| `{t:'item_full', convId, agentId, itemId}` | The whole of an item that arrived clipped. |
| `{t:'items', convId, agentId, before?, limit?}` | Paged transcript, newest page first; `before` is the previous page's `cursor`. |
| version 1 `send` plus `profile?` | Team profile for a new conversation. |
| `{t:'compact_answer', convId, id, keep: string[], accept}` | The person's answer to the compaction card: the helper names to keep, and go ahead or not. |
| `{t:'compact_cancel', convId}` | Cancel the compaction under way. |
| `{t:'archive_items', convId, agentId, before?, limit?}` | Paged transcript of an archived agent, like `items`. |
| `{t:'restore_agent', convId, agentId}` | Bring an archived helper back into the team. |
| `{t:'auto_compact', convId, on: boolean}` | Automatic tidying on or off for this conversation (`meta.autoCompact`). |

Starting a compaction has no message of its own: the page sends `/compact` as a `send` to the lead.

Every version 1 `ClientMsg` is also accepted.

### `ServerMsgV2` (server → page)

| Message | Meaning |
|---|---|
| `{t:'state', protocol: 2, state}` | Version 1's state, but `pending` holds `ApprovalSummary`s, plus `blobToken?`. |
| `{t:'conversation', conv, agents, pending, drafts, seq}` | Snapshot on subscribe, or when `since` is too old to replay. `drafts` carry their `dseq`. |
| `Sequenced` `agent`, `permission_request` | As in version 1, with `seq`. |
| `Sequenced` `item` (`truncated?`) | `truncated`: tool `input`/`result` were clipped. |
| `Sequenced` `draft` (`dseq`, `kind`, `append?` or `text?`) | A draft grew by `append`, or was replaced whole by `text`. `dseq` counts within one draft. |
| `Sequenced` `draft_end` | The draft ended; its text arrives as an item. |
| `{t:'approval', summary}` | Sent to every page, for badges. |
| `{t:'resync', convId}` | The events could not be replayed; the page reloads the conversation, and a snapshot follows. |
| `{t:'item_full', …, item}` | Answer to `item_full`. |
| `{t:'items', …, cursor?, more?}` | Answer to `items`. |
| `{t:'error', code, message, ref?}` | `code` is required in version 2. |
| `{t:'compact', convId, compact: CompactState \| null}` | The compaction state of a conversation, on every change; `null` when none. |
| `{t:'archived', convId, agents: AgentInfo[]}` | The conversation's archived agents, sent after each `compact`. |
| `{t:'archive_items', convId, agentId, items, cursor?, more?}` | Answer to `archive_items`. |

Every version 1 `ServerMsg` is also part of the union.

### Who uses it

`server/app/clients.ts` (the hub that turns `App`'s version 1 events into what each tab asked for: unchanged for version 1 tabs, with subscriptions, `seq` and draft deltas for version 2 tabs), `web/src/lib/store.svelte.ts` and `test/protocol-v2.test.ts`.

Not verified by running: this page was written from the code.

## Related pages

[Browser/server protocol](Browser-Server-Protocol.md) · [shared/toolline.ts](Source-Shared-Toolline.md) · [Team profiles and settings](Team-Profiles-and-Settings.md) · [Glossary](Glossary.md) · [Compact team](Compact-Team.md)
