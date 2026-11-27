# Web store (web/src/lib/store.svelte.ts)

The store is everything the page knows, kept in step with the server over one WebSocket. The server owns the truth; the store is a view of it. It is one class, `Store`, with Svelte 5 runes for state, and one shared instance, `store`, that every component imports. It holds no secret of its own: the sign-in key and device token live in `signin.ts` ([Signing in](Source-Web-Front-End.md#signing-in)). This page describes Masthead 0.2.0.

The 0.2.0 plan (`docs/plans/0.2.0/web.md` section 2) proposed splitting the store into `net/`, `state/` and `composer` modules. That split was not made: the store is still one file, about 870 lines. Only the pure helpers moved out, to `state/pure.ts` (below).

The store speaks two protocol versions on the same socket. Version 2 is what a 0.2.0 server speaks; version 1 is kept for an older server. The messages themselves are on [Browser/server protocol](Browser-Server-Protocol.md) and in `shared/protocol.ts` and `shared/protocol-v2.ts` ([Shared protocol](Source-Shared-Protocol.md)).

## Types and constants

- `ComposerImage`: one picture in the message box. It extends `ImageAttachment` (`mediaType`, `data` as base64) with `url` (an object URL for the preview), `name`, `size`, and for an existing chat `ref` (the `BlobRef` the upload returned), `uploading` and `error`. See [Images](Source-Web-Images.md).
- `ComposerDraft`: `{ text, images }`, the unsent contents of one message box.
- `Sent` (private): a message handed to the socket and not yet accepted: `ref`, the composer `key`, `convId`, `text`, `images`. Kept so a refusal can give it back.
- `DirListing`: one folder listing for the folder picker: `path`, `parent`, `entries`, `error?`.
- `MAX_REFUSALS = 3`: closes before the socket opened, in a row, before the page stops retrying by itself and shows the sign-in page.
- `Store.PAGE = 100`: items per transcript page asked from the server.

## State

Public `$state` fields:

| Field | What it holds |
|---|---|
| `connected` | The socket is open. |
| `app` | The last `AppState` (version, home, Claude Code info, settings, conversations…). |
| `settings`, `conversations` | From `state`, then from `settings` and `conversations` messages. |
| `convId` | The open conversation; `null` on the new-chat screen. |
| `agents` | The open conversation's agents by id. |
| `viewAgentId` | The agent whose transcript is shown; `null` means the main assistant (the `lead`). |
| `items`, `drafts` | Per agent id: loaded transcript items, and the streaming draft (`null` when none). |
| `pending` | Full approval requests (`PermissionRequest`) the page has. In version 2 only those of the open conversation. |
| `compact` | The open chat's team tidy-up (`CompactState`: id, phase, keeps, counts) while one is under way or just ended; `null` when none. From `conv.compact` in a `conversation` message, then `{t:'compact'}` ([Compact team](Compact-Team.md)). |
| `newCwd`, `newProfile` | Folder and team chosen on the new-chat screen. `newProfile = null` means the default team. |
| `dirs` | The last folder listing. |
| `error` | The toast text; cleared after 8 s by `fail()`. |
| `creating` | Between sending the first message of a new chat and the server's `created`. |
| `usage` | The latest `RateLimitNotice` per usage window type. |
| `signedOut` | Why the page cannot connect: `'nokey'`, `'refused'`, `'device'` (a remote device without an approved token) or `'withdrawn'` (the computer withdrew it). `null` when signed in. |
| `composer` | Unsent `ComposerDraft` per `composerKey`. |
| `approvals` | Version 2: approval summaries for every conversation (`{id, convId, agentName, kind}`), for the badges in the chat list. |
| `blobToken` | Version 2: the per-socket token for image URLs. |
| `clipped` | Ids of items that arrived clipped (`truncated`). |
| `pages` | Per agent: `{ cursor, more, loading }` for paged transcripts. |
| `remote` | `state.remote` and its `{t:'remote'}` updates. Only the local page gets it; `null` on a device or an older server. |
| `deviceRole` | On a remote device: `'full'`, `'approve'` or `'read'`; `null` on the computer's own page. |
| `backends` | `state.backends` and the reply to `check_backends`, kept raw; `settings/types.ts` reads it. |

`v2` is a plain field (not reactive): true once the server answered `hello` with protocol 2.

Derived values: `rateLimit` (the worst usage notice unless dismissed), `conv`, `agentList` (sorted by `createdAt`, archived helpers left out), `archivedAgents` (helpers a tidy-up archived, newest first; shown under "Archived helpers"), `lead` (the agent nobody started, `!parentId`; its tier id is `'lead'` only in Claude's built-in team, others use `<profile>:0`), `viewAgent` (falls back to the lead), `viewItems`, `viewDraft`, `canRun`, `convPending` (requests of the open chat), `liveCount` (helpers, i.e. agents with a `parentId`, queued, running or waiting) and `composerKey` (`"<convId or new>:<agentId or lead>"`).

`canRun` is true when any entry of `backends` has `available === true`, or when `app.claude` has a path, or a version without a path (the test-only fake backend). When it is false the page shows the first-run screen ([FirstRun](Source-Web-Components.md#firstrunsvelte)).

Private bookkeeping: the socket, the retry count, `errorTimer`, `pendingRef` (the `ref` of the new chat being created), `refusals`, the `sent` list, `wanted` (agents whose transcript the page asked for), `seq`, `epoch`, `subscribed`, `subscribedOnServer`, `dseq` (step number per streaming draft), `v1State`, `helloTimer`, `helloPending`, `forgetting`, `dismissedLimit` and the `listeners` map.

## Connecting

`connect()` is called once by `App.svelte` on mount.

**On this computer** (plain http):

1. `takeKey()` gives the key and whether it is an untried candidate. No key: `signedOut = 'nokey'`.
2. A socket to `ws://<host>/ws` (wss if the page is https) with the subprotocols `masthead` and `key.<secret>`. If the constructor throws (a key with characters a subprotocol cannot carry), a candidate is dropped in favour of a stored key; otherwise `signedOut = 'refused'`.
3. On open: a candidate becomes the stored key (`keepCandidate()`), the retry and refusal counts reset, and the page sends `hello` (below).
4. On close after it had opened: the page reconnects after a back-off (`later()`: 400 ms, doubling, at most 5 s).
5. On close before it opened, the page asks `/api/health` (`serverUp()`), which needs no key. Server down: keep retrying, and keep any candidate, for as long as it takes. Server up: it refused the key. A refused candidate with a stored key behind it is dropped and the page connects with the stored key, without the sign-in page, so a link to `…/#key=junk` cannot sign a browser out. Otherwise each refusal counts; after `MAX_REFUSALS` the page shows the sign-in page (`signedOut = 'refused'`).

`keyFromAddress()` runs on `hashchange`. When the new fragment (or query) carries `key=`, it takes the key as a candidate, closes the current socket and connects again. This is the sign-in address pasted into an open tab.

`retryConnect()` ("Try again") resets the counts and connects.

**On a remote device** (the page is https, `isRemoteDevice()`), `connect()` calls the private `connectDevice()`:

- No stored device token: `signedOut = 'device'` (the pairing screen).
- The socket opens with the subprotocols `masthead` and `device.<token>`, never a key.
- On open it sends `hello` and asks `whoami()`. An approved answer sets `deviceRole`. The comment says the role only decides what the page offers; the server enforces it either way.
- Close code `4001` means the computer withdrew access: the token is forgotten and `signedOut = 'withdrawn'`. If the person chose Forget this device (`forgetting`), the close is expected and leads to `'device'` instead.
- Refused before it opened: the page asks `whoami()`. Only `unknown` or `refused` forget the token. Anything else retries with back-off, so a brief refusal (remote access switched off and on, the listener restarting) does not cost the token.
- There is no refusal limit for devices.

`forgetThisDevice()` sends `{t:'forget_me'}`, forgets the token and any pairing request (`forgetDevice()`), clears `deviceRole`, and closes the socket after 1.5 s if the server has not closed it already. `deviceApproved(token)` saves a token from the pairing screen and connects.

**Roles.** `mayAct` is true on the computer's own page and for a `full` device. `mayStop` and `mayAnswer` are true everywhere except a `read` device. Components hide controls with them: the composer, New chat, delete, rename (the title is plain text otherwise), Restore for an archived helper, the team panel's controls and the settings fieldset need `mayAct`; the per-agent ■ Stop (`StopControl`) needs `mayStop`; the tidy-up card's answers and progress controls need `mayAnswer`.

A device without `mayAct` sees a role line in place of the composer (what its role may do, and how to get more). For an `approve` device it also holds the stops the composer would have had: Stop reply (`interrupt`) while the lead runs, and Stop all while helpers are live. Approval cards show on every device; `PermissionCard` tells a read-only device it cannot answer.

## Protocol version 2

### Hello and capabilities

On every open the page sends `{t:'hello', protocol: 2, caps: ['drafts-delta','items-paging','blobs','resync']}` and sets `helloPending`. A server sends a version 1 `state` on connect. While the hello is unanswered, that `state` is kept in `v1State` and not applied. A 0.2.0 server answers with `{t:'state', protocol: 2, epoch, state}`: the page sets `v2 = true` and applies it. An older server ignores the hello; after 2 s the timer applies the kept version 1 state. Once `v2` is set, a `state` without `protocol` is ignored.

`receiveV2()` handles what is new or different in version 2 and returns true when it handled the message; anything else falls through to the version 1 handler, since most messages are the same in both.

### Global stream

The version 2 `state` carries, for the whole app: conversations, settings, usage, backends, `blobToken`, and approval **summaries** in `pending`. The summaries go to `approvals`; the state is then passed on with `pending: []`, so the version 1 code never treats a summary as a full request. Later `{t:'approval', summary}` messages add summaries; `permission_resolved` and `deleted` remove them. `waitingIn(convId)` counts `approvals` in version 2 and `pending` in version 1.

`remote` and `backends` messages are handled first, in either version.

### Subscribe, seq and epoch

`open(convId)` clears the conversation's state, writes `#/c/<id>` into the address with `replaceState`, and in version 2 unsubscribes from the previous chat and sends `{t:'subscribe', convId}`. The server then sends a `conversation` snapshot and that chat's events only. Version 1 sends `{t:'open'}` instead. `newConversation()` unsubscribes and clears.

Every per-conversation event carries `seq`. `receiveV2()` raises `seq` to the highest it has seen for the subscribed chat (including `agent` events, which carry the conversation in `agent.convId`). A version 2 `conversation` snapshot sets `seq` to its own value and fills in drafts in progress with their step numbers.

`epoch` marks one run of the server. After a reconnect, the new `state` is compared with the last epoch: a different epoch means the server restarted, so `seq` resets to 0 and nothing is replayed.

When the state arrives after a reconnect, `receiveState()` checks: version 2, the same chat as before, and `seq > 0`. Then it sends `{t:'subscribe', convId, since: seq, epoch}` (`resubscribe()`) and keeps everything loaded; the server replays the missed events. Otherwise it opens the chat afresh. When the server is too far behind to replay, it sends `{t:'resync', convId}`; the store clears items, drafts, pages and step numbers for that chat, and the snapshot that follows reloads the shown transcript.

The plan says the page should, after a snapshot, fetch only items newer than its last item id. The snapshot does carry `lastItemIds`, but the store does not read it; after `resync` it fetches the newest page again.

### Draft deltas

A version 2 `draft` carries `dseq` (the step number) and either `text` (the whole draft, sent once when joining mid-draft or after a `draft_sync`) or `append`:

- `text` present: the draft is replaced.
- `append` with `dseq` one more than the last step: appended.
- `dseq === 1`: a new draft starts.
- Anything else means a step was missed: the page sends `{t:'draft_sync', convId, agentId}` once and waits for the whole text.

`draft_end` clears the draft and its step number. It names the item that replaces it (`itemId`); the store does not use that field. A `draft` without `dseq` is version 1 (the whole draft each time) and is handled by the version 1 code.

### Paged transcripts

`loadItems(agentId)` marks the agent as wanted and, if its items are not loaded, sends `{t:'items', convId, agentId, limit: 100}` (version 1 sends no limit). The reply carries `cursor` and `more`; they go into `pages[agentId]`. `loadEarlier(agentId)` sends `before: cursor` for the next older page and sets `loading`. A reply while `loading` is put in front of the loaded items, skipping ids already there (the copy already loaded is newer). An `items` reply for an agent no longer wanted is dropped: the team outline's hover preview may have closed before its reply came ([TeamOutline](Source-Web-Components.md#teamoutlinesvelte)). For an archived helper `loadItems` asks with `{t:'archive_items', convId, agentId, limit}` instead; the reply is handled as an `items` page with no draft, and the chat is shown read-only. `dropItems(agentId)` forgets a transcript fetched only for a preview, unless it is the one on screen.

The transcript component pages its own rendering as well; see [Rendering speed](Source-Web-Front-End.md#rendering-speed).

### Clipped items

Live `item` events with tool input or result over 16 KiB (`CLIP_CHARS` in `shared/protocol-v2.ts`) arrive clipped, with `truncated: true`. The store records the id in `clipped`. `fetchFull(agentId, itemId)` sends `{t:'item_full', …}` when the item is clipped; `ToolItem` calls it when the person opens the tool line. The `item_full` reply replaces the item and clears the mark.

### Approval requests

Full requests come with the subscribed chat: in the `conversation` snapshot (`pending`, which replaces that chat's entries) and as `permission_request` events. `answer(requestId, decision, answers?)` sends `{t:'permission', …}` and removes the request at once. `decision` is `'allow'`, `'always'` or `'deny'`.

### listen and request

For messages the store itself does not use:

- `listen(t, fn)` calls `fn` for every server message of type `t`, after the store has handled it. It returns the function that stops listening. Used for `backends` (end of "Checking…"), `remote_audit` and `error` in the settings pieces.
- `request(msg)` sends any message; when offline it shows `T.errors.notConnected` and returns false. Used for `check_backends`, `reset_profile`, `delete_profile`, `remote_settings`, `device_decision`, `device_role`, `device_revoke`, `remote_audit`, `forget_me`, and the store's own `compact_answer`, `compact_cancel`, `restore_agent` and `archive_items`.

## Receiving (`receive()`)

`receive(msg)` is public so tests can drive the store without a socket. It calls the private `handle()`, then the listeners. `handle()` deals with `remote` and `backends`, then `receiveV2()`, then the version 1 cases:

- `state` → `receiveState()`: sets `app`, `remote`, `backends`, `settings`, `conversations`, `pending`, `usage`; ends `creating`; sets `newCwd` to the default folder if empty; then reopens the chat named by `convId` or by `#/c/<id>` (`idFromHash()`), or shows the new-chat screen.
- `conversations`: replaces the list.
- `conversation`: only for the open chat. Replaces `agents` and that chat's `pending`, takes `seq` and drafts from a version 2 snapshot, keeps the agent on screen if it still exists, and loads its items.
- `created`: accepts the sent message; if it is the new chat being created, opens it.
- `deleted`: drops its requests and summaries; if it was open, goes to the new-chat screen.
- `items`, `item`, `draft`, `agent`: transcript and agent updates for the open chat. An `item` for an agent whose items are not loaded is ignored; they are fetched when the agent is opened. A `user` item accepts the sent message with the same chat and text.
- `permission_request`, `permission_resolved`: add and remove requests.
- `settings`, `rate_limit` (into `usage`), `dirs`.
- `compact` (into `compact`, for the open chat), `archived` (the agents a tidy-up archived or restored, merged into `agents`) and `archive_items` (an archived helper's transcript page).
- `error`: with a `ref`, gives that message back to its composer and ends `creating` if it was the new chat. Without one it still ends `creating`, so the composer is not stuck on "Starting…". Then shows the message with `fail()`.

## Actions

- `send(msg)`: sends a protocol message. When the socket is not open it shows "Not connected to Masthead. Is it still running?" and returns false. (This text is written inline, unlike `request()`, which uses `T.errors.notConnected`.)
- `fail(message)`: shows a toast for 8 s.
- `sendMessage(key)`: sends what is in the composer for `key` and empties it. A new chat sends `{t:'send', convId: null, cwd, text, images, ref, profile?}` with pictures inline as base64. An existing chat sends references to uploaded pictures in `blobs`, plus `agentId` when a helper is on screen. The text and pictures go into `sent` until the server accepts them (`created`, or the `user` item comes back). A refusal (`error` with the `ref`) or a dropped socket (`dropped()`) puts them back with `giveBack()`, unless the person has typed something new there.
- `composerFor(key)`: the `ComposerDraft` for a key, created if missing.
- `updateSettings(change)`: changes a deep copy of the settings, shows it at once and sends only the fields that changed (`settingsPatch`). The server merges a partial update, so a tab with stale settings cannot put back an old folder or limit.
- `answer(...)`, `viewOf(agentId)` (shows an agent's transcript), `open`, `newConversation`, `loadItems`, `loadEarlier`, `fetchFull`, `dropItems`, `waitingIn`.
- `answerCompact(keep, accept)`: answers the tidy-up card with `{t:'compact_answer', convId, id, keep, accept}`. `cancelCompact()` sends `compact_cancel`. `restoreAgent(agentId)` sends `restore_agent`, which brings an archived helper back into the team.
- `dismissLimit()`: hides the usage banner until the worst notice changes.
- `childrenOf(agentId)` and `pathTo(agentId)` (the chain from the lead down, for the breadcrumbs).

## Pure helpers (`web/src/lib/state/pure.ts`)

Kept apart so they can be tested without Svelte ([Page tests](Source-Web-Tests.md)):

- `settingsPatch(before, next)`: the fields of `next` that differ from `before`. Objects such as the profile list are compared by their JSON, because a deep copy is never the same object. Legacy `tiers` fields are compared one by one.
- `limitKey(notice)`: `type|status|resetsAt`. A change in any of these brings a dismissed banner back.
- `worstLimit(usage)`: any `rejected` notice, else any `allowed_warning`, else `null`.

## Helpers exported with it

`store.svelte.ts` re-exports `STATUS_LABEL`, `fmtTokens`, `shortPath`, `shortReason` and `statusWords` from `words.ts`, because components used to import them from here ([Words](Source-Web-Text.md#wordsts)).

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web components](Source-Web-Components.md) · [Images](Source-Web-Images.md) · [Settings and remote access](Source-Web-Settings-and-Remote.md) · [Browser/server protocol](Browser-Server-Protocol.md) · [Shared protocol](Source-Shared-Protocol.md) · [Page tests](Source-Web-Tests.md)
