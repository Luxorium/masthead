# server/app/clients.ts and shared/protocol-v2.ts

**Role:** the browser tabs and what each one is sent. [App](Source-App.md) publishes version 1 events to the `Hub` in `server/app/clients.ts`, and the Hub hands each tab the form it asked for. The file comment puts it this way:

- a version 1 tab (a 0.1.x page, or one that has not said hello with protocol 2) gets events unchanged;
- a version 2 tab always gets list-level events. It gets a conversation's detailed events (agents, items, drafts as deltas, full approval requests) only while subscribed to it, each with a per-conversation `seq` so it can resync after a reconnect.

Every message a tab sends passes `admit()` first. That is the one place a remote device's role is enforced. `shared/protocol-v2.ts` holds the version 2 types and limits shared with the page. The message list itself is on [Browser/server protocol](Browser-Server-Protocol.md).

> Checked against the 0.2.0 source on branch `next`. Behaviour described here is read from the code, not run. Where a test in `test/protocol-v2.test.ts` covers a point, its name is given; the tests were not run for this page.

## shared/protocol-v2.ts

The file comment says it holds the messages that are new or changed from version 1 (`shared/protocol.ts`), kept separate while that file was being reworked. The comment says the two merge into one file before 0.2.0; in the 0.2.0 source they are still two files. It must not import Node or DOM APIs.

| Export | Value or meaning |
|---|---|
| `PROTOCOL_VERSION` | `2`. |
| `Capability` | `'drafts-delta' \| 'items-paging' \| 'blobs' \| 'resync'`: what a version 2 page says it can handle. The Hub stores them but does not branch on them (read from the code, not run). |
| `ErrorCode` | `'protocol' \| 'refused' \| 'not_found' \| 'too_large' \| 'invalid'`. |
| `CLIP_CHARS` | 16 × 1024 characters. Live `item` events clip tool input and output past this; `item_full` fetches the rest. |
| `RING_SIZE` | 500: events kept per conversation for resync. |
| `BackendModelV2` | A model a backend offers: `id`, `label`, `efforts`, `nativeEffort`, optional `contextWindow`, `default`, `description`, `order`. A copy of `ModelInfo` in `server/backends/types.ts`. |
| `BackendStatusV2` | An agent program on this computer: `id`, `label`, `available`, `path`, `version`, `signedIn`, optional `minVersion`, `error`, `warning`, and its `models`. A copy of `BackendStatus` in `server/backends/registry.ts`. |
| `ApprovalSummary` | `{id, convId, agentName, kind}`: who is asking, without the request itself, for badges on every conversation. |
| `ClientMsgV2` | Version 1's messages plus `hello` with `protocol` and `caps`, `subscribe {convId, since?}`, `unsubscribe`, `draft_sync {convId, agentId}`, `item_full {convId, agentId, itemId}`, paged `items {before?, limit?}`, `send` with an optional `profile`, `check_backends`, the remote-access messages (`remote_settings`, `device_decision`, `device_revoke`, `device_role`, `remote_audit`, `forget_me`), and the team-compaction messages (`compact_answer`, `compact_cancel`, `archive_items`, `restore_agent`, `auto_compact`). |
| `Sequenced<T>` | `T & {seq: number}`. |
| `ServerMsgV2` | `state` with `protocol: 2` and summarised `pending`; the `conversation` snapshot (with `drafts` and `seq`); sequenced `agent`, `item` (with `truncated?`), `draft` (with `dseq` and `append` or `text`), `draft_end` and `permission_request`; `approval`; `resync`; `item_full`; paged `items` (with `cursor` and `more`); `error` with a `code`; `compact` (a conversation's compaction state, or null); `archived` and `archive_items` (archived agents and their paged items); `backends`; `remote` (local tabs only); and `remote_audit` entries. |

The types also list `epoch` on `state` and on `subscribe`, `itemId` on `draft_end`, `lastItemIds` on the `conversation` snapshot, and optional `blobToken`, `backends` and `problems` (`{what: 'settings' | 'devices', message}`) inside the version 2 `state`.

## Client and HubHost

- `Client` (re-exported by `app.ts` as its `Client`): `send(msg)`, an optional `blobToken` (the socket's token for `/blob/<conv>/<hash>?t=`, set by [`attach()`](Source-Http.md#attachapp-ws-tokens-remote)), an optional `role`, and an optional `deviceId` (the device's Tailscale node id). The transport sets `role` and `deviceId` only for a remote device. **No role means the local browser.**
- `HubHost`: what the Hub needs from App.
  - `snapshot(convId)`: the conversation's meta, agents, full pending requests, and `lastItemIds` (each agent's newest stored item, so a reconnecting page fetches only newer ones). Null when the conversation does not exist.
  - `fullItem(convId, agentId, itemId)`: one stored item, unclipped.
  - `state(client)`: the `AppState` for that tab.

## Errors: ClientError and codeOf(e)

- `ClientError(code, message)`: an `Error` carrying an `ErrorCode`. App throws it where the code matters.
- `codeOf(e)`: the code for any error. A `ClientError` gives its own code. A plain `Error` is classified by its text: "no longer exists" gives `not_found`; "too long", "larger than", "at most" or "too large" gives `too_large`; anything else `invalid`.
- `Hub.error(client, e, ref?)`: sends `{t: 'error', message, ref?}`. Only a local version 1 tab gets that old shape; every other tab, including a remote device that has not said hello yet, also gets `code`.

## Sessions: version 0, 1 and 2

The Hub keeps a `Session` per client: `version`, `caps`, and the set of `subscribed` conversation ids.

- `add(client)`: a client with a `role` (a remote device) starts at **version 0**: it is sent nothing until it says hello with protocol 2. A local client starts at **version 1**. As the comment says, the version 1 adapter is for the local browser only.
- `greets(client)`: true for version 1. App sends the version 1 `state` on connect only then.
- `isV2(client)`, `clients()`, `remove(client)`.

### intercept(client, raw)

Handles the version 2 messages about the connection itself and returns true; anything else returns false and goes on to App.

- **`hello`**: with no `protocol` it returns false, and App answers it as a version 1 hello. A `protocol` other than 2 throws a `protocol` error ("This Masthead speaks protocol 2. Reload the page."). With 2, the session becomes version 2, keeps the string entries of `caps`, and is sent `stateV2()`. Covered by "v2: hello negotiates the version; a wrong one is a protocol error; state carries summaries".
- **`subscribe {convId, since?, epoch?}`**: needs version 2. If `snapshot()` is null it throws `not_found`. It adds the id to `subscribed`, then:
  - If `epoch` is given and is not this server's `epoch`, it sends `resync` and then a snapshot. A `seq` from another server start is never replayed ("review: a seq from another server start is never replayed").
  - If `since` is a number with `oldest - 1 <= since <= ring.seq`, where `oldest` is the oldest kept event's `seq`, it replays every kept event after `since` and sends no snapshot.
  - Otherwise it sends `resync` (only when `since` was given and differs from the current `seq`), then a snapshot.
  - Covered by "v2: resync replays from the ring, or says resync and sends a snapshot when too old".
- **`unsubscribe {convId}`**: needs version 2; drops the id.
- **`draft_sync {convId, agentId}`**: needs version 2. It throws `not_found` when there is neither a ring nor a snapshot for the conversation. If the agent has an open draft, it sends `{t: 'draft', dseq, kind, text, seq}` with the whole text; if not, `{t: 'draft_end', seq}`. `seq` is the ring's current number, and these replies are not recorded in the ring.
- **`item_full {convId, agentId, itemId}`**: needs version 2; sends `{t: 'item_full', item}` from `host.fullItem()`, or throws `not_found`.

`requireV2()` throws a `protocol` error, "Say hello with protocol 2 first.", for a session below version 2.

### admit(client, msg): the gate

Called by `App.handle()` for every message, before anything else. It throws, and App turns that into an error reply:

1. A version 0 session may send only `hello` (`protocol`, "Say hello with protocol 2 first.").
2. `allowedMessage(client.role ?? 'local', msg.t)` from `server/remote/authorise.ts` must allow the type (`refused`, "This device may not do that."). `forget_me` is the one exception to the order below: any device may send it, whatever its role, and the local browser may not. Otherwise the local browser may send anything. No device may send `device_decision`, `device_revoke`, `device_role`, `remote_settings`, `remote_audit` or `shutdown`. `full` may send everything else. `approve` may send the read set plus `permission`, `interrupt`, `stop_agent`, `stop_all`, `check_backends`, `compact_answer` and `compact_cancel`. `read` may send `hello`, `open`, `items`, `subscribe`, `unsubscribe`, `draft_sync`, `item_full` and `archive_items`. `restore_agent`, `auto_compact`, `delete_profile` and `reset_profile` therefore need `full` (or the local browser).
3. A version 2 session may send `open`, `items`, `item_full`, `draft_sync`, `archive_items`, `compact_answer`, `compact_cancel`, `restore_agent` or `auto_compact` only for a conversation it is subscribed to (`refused`, "Subscribe to that conversation first.").

Covered by "v2: errors carry codes; roles are enforced at the gate; …" and "review: a remote tab gets nothing before hello, and cannot read a conversation it has not subscribed to".

## Rings: seq, byte cap and epoch

- `epoch`: 6 random bytes as hex, made when the Hub is created, so it changes on every server start. It is sent in the version 2 `state`.
- Each conversation has a `Ring {seq, bytes, events}`, created on first use.
- `record(convId, msg)`: copies the message with `seq: ++ring.seq`, measures it as the length of its JSON text, and appends it. It then drops the oldest events while there are more than `RING_SIZE` (500), or while the total is over `RING_BYTES` (8 MiB) and more than one event is left. The newest event is always kept. Covered by "review: rings are capped by bytes as well as count; …". The "bytes" are JSON string length in UTF-16 units, not encoded bytes.
- A `deleted` event removes the conversation's ring, open drafts, pending draft ends and final item ids.

## Drafts: deltas and draft_end

App reports each draft whole (`{t: 'draft', draft}` or `draft: null`). `draftEvent(convId, agentId, draft)` turns that into the version 2 event, keyed by `<convId>/<agentId>`:

- **Draft grows** (same `kind`, new text starts with the old text): `{t: 'draft', dseq: +1, kind, append}` with only the new part. Equal text gives nothing.
- **New or replaced draft** (no draft before, other kind, or text that does not extend the old): `{t: 'draft', dseq: 1, kind, text}` with the whole text. If an earlier draft of the same agent was still waiting for its item, that wait ends now with an unnamed `draft_end`, so the wait cannot end this new draft ("review: a draft waiting for its item cannot end the next draft").
- **Draft ends** (`null`, and there was one):
  - If its final `text` or `thinking` item already arrived while the draft was open (kept in `finals`), the event is `{t: 'draft_end', itemId}`.
  - Otherwise, because some backends end the draft before the final item, it waits up to 1.5 s (`ending`). If a `text` or `thinking` item for that agent arrives in time, `publish()` sends the item first and then `draft_end` with that item's `itemId`. If none comes, an unnamed `draft_end` is sent when the timer fires.
  - Covered by "v2: a draft that ends before its item waits for it, or ends unnamed after a moment".

Drafts are never saved; `dseq` counts within one draft so the page can spot a gap (for example one dropped by [back-pressure](Source-Http.md#attachapp-ws-tokens-remote)) and ask with `draft_sync`. Covered by "v2: drafts become deltas; a replacement restarts dseq; draft_sync gives the whole text; the end is said once".

## clipItem(item)

For the live stream only. A `tool` item's `result` string longer than `CLIP_CHARS` is cut to that length. Its `input`, if its JSON is longer than `CLIP_CHARS`, is replaced by `{clipped: <first 16 KiB of the JSON>}`. Either sets `truncated`. Other items pass unchanged. The stored transcript is not clipped, and `item_full` returns the whole item. Covered by "v2: heavy tool fields are clipped live and fetched whole on request".

## publish(msg) and sendTo()

`publish()` is how App broadcasts. `convOf(msg)` finds the conversation of a detailed event: `agent` (from `agent.convId`), `item`, `draft` and `permission_request`. Other types are list-level.

- `draft` goes through `draftEvent()` and, if it yields an event, `record()`.
- `item` is clipped and recorded, with `truncated: true` when clipped. It also feeds the `draft_end` logic above.
- Other detailed events are recorded as they are.

`sendTo()` then delivers:

- version 0: nothing;
- version 1: the original version 1 message, unchanged ("v1 adapter: a tab that never says hello 2 gets every event unchanged");
- version 2:
  - a `permission_request` first sends every version 2 tab `{t: 'approval', summary}`, whatever it is subscribed to;
  - a list-level event (such as `conversations`, `settings`, `deleted`, `rate_limit`, `backends`) is sent as is. A `deleted` also removes that id from the tab's subscriptions;
  - a detailed event is sent only to subscribers, in its recorded form with `seq`.

`emit(convId, event)` records an event the Hub makes itself (the delayed `draft_end`) and sends it to version 2 subscribers only.

Covered by "v2: detailed events only for subscribed conversations, list-level events always, each with seq".

## publishLocal(msg)

Sends to every client without a `role`, whatever its version, and never to a remote device. App uses it for `{t: 'remote', remote}` whenever remote access changes, so only the local browser sees pairing requests, devices and the switch.

## stateV2(client)

`{t: 'state', protocol: 2, epoch, state}`, where `state` is `host.state(client)` with `pending` reduced to `ApprovalSummary` entries. A version 2 page gets full requests only in a subscribed conversation's snapshot and events.

## The snapshot

`snapshot(convId, snap)` (private) is `{t: 'conversation', ...snap, drafts, seq}`: the host's snapshot, the conversation's open drafts with their `dseq` (keyed by agent id), and the ring's current `seq`.

## Related pages

[Browser/server protocol](Browser-Server-Protocol.md) · [Security model](Security-Model.md#input-checks-and-error-codes) · [Remote access](Remote-Access.md) · [server/app/app.ts](Source-App.md) · [server/transport/http.ts](Source-Http.md) · [server/transport/remote.ts](Source-Transport-Remote.md) · [shared/protocol.ts](Source-Shared-Protocol.md)
