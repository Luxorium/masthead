# server/app/app.ts

**Role:** the whole application behind the web page: settings, conversations, the slot scheduler, the agent backends, open approval requests, and, when offered, remote access. Its class comment states the key idea: browser tabs are views onto this state, and closing a tab stops nothing. `App` implements `ConversationHost`, so conversations report every change to it, and it saves and publishes. Which tab receives what, in which protocol version, is the [Hub](Source-Clients.md) in `server/app/clients.ts`.

> Checked against the 0.2.0 source on branch `next`. Behaviour described here is read from the code, not run. Where a test covers a point, its file and name are given; the tests were not run for this page.

## `Client`

Re-exported from `clients.ts` (see [Client and HubHost](Source-Clients.md#client-and-hubhost)). The transport creates one per WebSocket. A client with a `role` is a remote device; one without is the local browser.

## Constants

`IMAGE_TYPES` (PNG, JPEG, GIF, WebP), `MAX_IMAGES = 8`, the exported `MAX_IMAGE_BYTES` (5 MiB) and `MAX_TOTAL_IMAGE_BYTES` (30 MiB), the same limits as the page's composer per the comment, `MAX_TEXT = 400_000` characters, `SAVE_DELAY_MS = 400`.

## Construction

`new App({store?, claude?, settings?, settingsFile?, registry?, remote?, awake?})`:

1. Keeps `remote` (a `RemoteAccess`) and `awake` (the keep-awake helper), or null. If there is remote access, it subscribes to `remote.onChange()` and sends `{t: 'remote', remote: remote.state()}` to local tabs only (`hub.publishLocal()`), so pairing requests, devices and the switch never reach a device.
2. Remembers `settingsFile` (default `SETTINGS_FILE`) and loads settings from it. Tests pass their own file so they never touch the person's real settings.
3. Claude Code info: when `fakeBackendSelected(process.env)` (the scripted fake backend for the browser test and CI), a stand-in with no path. Otherwise `opts.claude`, or an empty one if a registry was passed, or `findClaude()`. That runs synchronously and can take as long as `claude --version` takes.
4. The `BackendRegistry` (given, or new). Only on a real start (neither `claude` nor `registry` given) it calls `registry.detectAll()` in the background and then `backendsDetected()`.
5. The `Store`, and a `Scheduler` whose limit for a tier is `tierLimit(settings, tier)`, which reads the tier's own team profile.
6. Every saved conversation is restored with `Conversation.restore()`. For each, `store.collectBlobs()` (through `safely('images')`) removes pictures no transcript refers to any more.

## `ConversationHost` implementation

| Method | Does |
|---|---|
| `backend(tier)` | The backend of the tier's profile entry (`findTier()`, default `claude-code`), if the registry has a usable one. |
| `backendsDetected()` | Adds generated team profiles (`withBuiltInProfiles()` with `registry.generatedProfiles()`, e.g. a Codex team when Codex is usable); calls `updateSettings()` only if that changed anything. |
| `settings()`, `claudePath()` | Current values. |
| `agentChanged(conv, agent)` | Broadcast `{t:'agent'}`; schedule a save; if the conversation's `busy()` differs from the last recorded value, record it, call `keepAwake()` and broadcast the `{t:'conversations'}` list. |
| `itemChanged(conv, agent, item)` | Ignored if the conversation is no longer the one registered under its id (it was deleted and its processes are winding down). Otherwise append the item to disk (through `safely('transcript')`) and broadcast `{t:'item'}`. |
| `draftChanged(conv, agent, draft)` | Broadcast `{t:'draft'}` (never saved). The Hub turns it into deltas for version 2 tabs. |
| `metaChanged(conv)` | Schedule a save; broadcast the list. |
| `rateLimit(notice)` | Keep it as the latest notice of its `type` (sent to later tabs in `AppState.usage`); broadcast `{t:'rate_limit'}`. |
| `askPermission(conv, agent, ask)` | Create a `PermissionRequest` (kind `question` or `permission`; `canAlways` only for a permission the backend says can be remembered), keep it in `pending`, broadcast it, and return a promise settled by the person's answer, by the ask's abort signal ("The request was cancelled."), or by cancellation. Settling removes it and broadcasts `permission_resolved`. See [Permissions and questions](Permissions-and-Questions.md). |
| `cancelPermissions(agentId)` | Deny every pending request from that agent ("The agent was stopped."). |

## Saving, shutdown and keeping awake

- `safely(what, write)`: runs a disk write. A failure is logged once per kind (`transcript`, `conversation`, `settings`, `images`) until one works again; the server carries on.
- `workingCount()`: how many conversations have `busy()` true. `/api/health` reports it as `busy`.
- `scheduleSave(conv)`: if no save is pending, start a 400 ms timer; when it fires, save `conv.toStored()` if the conversation still exists. Changes during those 400 ms are included because state is read when the timer fires.
- `flush()`: write all pending saves now.
- `keepAwake()` (private): `awake.set(true)` while the `keepAwake` setting is not `false` and `workingCount() > 0`, else `awake.set(false)`. It is called when a conversation's busy state changes, on delete, and on every settings update. (A stray doc comment, "Stops every agent and writes everything to disk.", sits above the `awake` field; it belongs to `shutdown()`.)
- `shutdown()`: `awake.stop()`, deny all pending approvals ("Masthead is shutting down."), `shutdown()` every conversation, `flush()`, and dispose the registry.

## For the transport

- `blobs`: the store's `BlobStore`, passed to both listeners' `/blob` routes.
- `hasConversation(convId)`: passed to the listeners as `convExists`, so uploads only go to real conversations.
- `storeImage(convId, data, mediaType)`: decodes base64 and puts it in the blob store. It returns `{ref}`, or `{error}` instead of throwing. Used for inline images in `send`, and through `Conversation.storeImage()` (`server/core/conversation.ts`) for images in tool results.

## Tabs

- `connect(client)`: `hub.add(client)`. If `hub.greets(client)` (a local tab, version 1 until it says otherwise), it sends `{t:'state', state: state(client)}` at once. A remote device gets nothing until its version 2 hello.
- `disconnect(client)`: `hub.remove(client)`.
- `broadcast(msg)`: `hub.publish(msg)`; the Hub decides which tab gets which form.
- `metas()`: each conversation's meta with `busy` added, newest `updatedAt` first.
- `state(client?)`: the `AppState`. It has the version, settings, `metas()`, Claude Code info, home folder, every open approval request and the kept usage notices. When a client is given it adds:
  - `remote` (from `remote.state()`) only for a local client, never for a device;
  - `backends` (`registry.status()`) only for a version 2 client;
  - `blobToken` when the client has one.
- The Hub's host functions: `snapshot(convId)` (meta, agents, that conversation's pending requests, and each agent's newest stored item id via `store.readItems(…, {limit: 1})`), `fullItem()` (one stored item, only if the agent belongs to the conversation), and `state(client)`.

## handle(client, raw): the gate

Every message from either listener arrives here. Nothing is thrown out of it.

1. Not an object with a string `t`: "Malformed message.".
2. `hub.admit(client, msg)`: the one gate for what a tab may send (role, version 0 before hello, subscription). See [admit](Source-Clients.md#admitclient-msg-the-gate).
3. `hub.intercept(client, msg)`: the connection messages (`hello` with protocol, `subscribe`, `unsubscribe`, `draft_sync`, `item_full`) end here.
4. A `hello` without protocol from a device: `protocol` error "Say hello with protocol 2.". A device never gets the version 1 state (test "review: a remote device sending a plain v1 hello gets a protocol error, never the v1 state").
5. A `hello` without protocol from a tab already on version 2: it gets `hub.stateV2(client)` again.
6. `remoteMessage()`, then `dispatch()`.

Any error becomes `hub.error(client, e, ref)`, where `ref` is the message's `ref` when it is a string, cut to 80 characters. Version 2 tabs and devices get a `code` ([errors](Source-Clients.md#errors-clienterror-and-codeofe)).

## remoteMessage(): remote access and profile messages

Returns true for the types it handles. The comment says these come from the local browser only, which the gate enforces, except `forget_me` and `check_backends`.

- **`remote_settings`** (`enabled?`, `port?`, `allowOtherTailnets?`, `allowTagged?`): `remote.configure(msg)` with the raw fields, which validates them. If `enabled` is a boolean it also calls `remote.setEnabled()` in the background. When that reports `ok: false`, the tab gets a `refused` error with the problem and, if given, "Run: <command>". Throws `not_found` "Remote access is not available here." when there is no remote access (`requireRemote()`).
- **`device_decision`** (`requestId`, `decision`, `role?`): `decision` must be `allow` or `deny` ("Allow or deny."). Calls `remote.decide(requestId, decision, role ?? 'full')`.
- **`device_revoke`** (`nodeId`): `remote.revoke(nodeId)`.
- **`device_role`** (`nodeId`, `role`): `remote.setRole(nodeId, role)`, which rejects an unknown device or role. The device's open sockets follow at once through [`setRole()`](Source-Transport-Remote.md#disconnectnodeid-and-setrolenodeid-role).
- **`reset_profile`** (`id`): reads the profile id from `msg.id`. Only a built-in profile may be reset (`not_found`, "Only a built-in team can be reset."). Then `updateSettings(resetProfile(settings, id, registry.generatedProfiles()))`. Covered by "reset_profile: a built-in team goes back to how it ships; others and lower roles are refused" in `test/protocol-v2.test.ts`.
- **`check_backends`**: re-runs `registry.detectAll()` in the background, then `backendsDetected()` and a broadcast of `{t:'backends', backends}` to every tab. The comment says any approved device may ask except `read` devices, because it runs programs to check versions.
- **`forget_me`**: a device removing its own approval. It needs `client.deviceId` (`refused`, "Only a paired device can forget itself.") and calls `remote.forget(deviceId)`, which revokes the device, writes a `forget` audit entry and ends its sockets. The gate refuses it from the local browser.
- **`remote_audit`**: sends this tab `{t:'remote_audit', entries: remote.audit()}`.
- **`delete_profile`** (`id`, `force?`): an unknown team is `not_found`. If chats use it (`chatsUsing()` over every conversation's `meta.profileId`) and `force` is not true, the tab gets `{t:'error', code:'refused', message, inUse: {id, chats}}` and nothing changes. Otherwise `updateSettings(deleteProfile(...))`; the built-in Claude team cannot be deleted (`refused`). Tested in `test/protocol-v2.test.ts`.
- **Team compaction** (foxtrot's flow in `server/core/conversation.ts`; tested in `test/compact-app.test.ts`):
  - **`compact_answer`** (`convId`, `id`, `keep`, `accept`): `conv.answerCompact(id, keep, accept === true)`; `keep` keeps only strings, at most 200.
  - **`compact_cancel`** (`convId`): `conv.cancelCompact()`.
  - **`restore_agent`** (`convId`, `agentId`): `conv.restoreAgent(agentId)`.
  - **`auto_compact`** (`convId`, `on`): `conv.setAutoCompact(on)`; a non-boolean `on` is `invalid`.
  - **`archive_items`** (`convId`, `agentId`, `before?`, `limit?`): like `items`, paged when `limit` is given, and only for an agent with `info.archived` set (`not_found` otherwise). Replies `{t:'archive_items', convId, agentId, items, cursor?, more?}`.

### `/compact` and the compaction hooks

- In **`send`** to an existing conversation, a message to the main assistant (no `agentId`, or the lead's) whose trimmed text is exactly `/compact` or `/compact <words>`, with no images, calls `conv.startCompact(words)` instead of `userSend()`. Anything else, including `/compact` to a helper, is chat.
- **`readItems(convId, agentId)`** (ConversationHost) returns the stored transcript (`store.loadItems`), for the `read_archive` tool.
- **`compactChanged(conv)`** (ConversationHost) broadcasts `{t:'compact', convId, compact: meta.compact ?? null}` and `{t:'archived', convId, agents}` (the agents with `archived` set) to every tab.

## dispatch(): the version 1 messages

One `switch` on `msg.t`. The message shapes are on [Browser/server protocol](Browser-Server-Protocol.md#page--server). Unknown types throw "Unknown request.".

- **`hello`** (version 1): `{t:'state', state: state()}`. It is called without the client, so this reply carries no `remote`, `backends` or `blobToken`, unlike the greeting sent on connect.
- **`open`**: `{t:'conversation'}` with the meta, agent infos and that conversation's pending requests.
- **`items`** (`convId`, `agentId`): the agent must exist (`not_found`).
  - With a numeric `limit` (version 2 paging), `limit` is clamped to 1–500. `before` is used when it is a number ≥ 0, else null. It answers `store.readItems()`: newest page first, with `cursor` (to pass as the next `before`) and `more`.
  - Without `limit`, it answers the whole transcript (`store.loadItems()`).
  - Both include the agent's current draft.
- **`send`**: see [below](#send).
- **`interrupt`**: `conv.interruptLead()`. **`stop_agent`**: `conv.stopAgent(agentId, 'Stopped by the person.')`. **`stop_all`**: `conv.stopAll()`.
- **`permission`**: `answerPermission()`.
- **`settings`**: `updateSettings(sanitizeSettings(msg.settings, current))`, so a partial update changes only the fields it names.
- **`rename`**: whitespace collapsed, trimmed, cut to 120 characters; an empty result changes nothing. Then `metaChanged()`.
- **`delete`**: `stopAll()` and `shutdown()` on the conversation, cancel its save timer, forget it and its busy entry, `keepAwake()`, delete its folder, and broadcast `deleted` and the new list. The Hub drops its ring and subscriptions.
- **`dirs`**: `listDirs(path)`.

`conv(id)` looks a conversation up or throws `not_found` "That conversation no longer exists.".

### send

1. `text` (a string, else empty) and `images` (inline base64, checked by `checkImages()`). `blobs` holds refs to pictures uploaded beforehand with `POST /blob`. A message with no text, no images and no refs is "The message is empty."; text over 400 000 characters is `too_large`.
2. **New conversation** (`convId` null or missing):
   - The folder is `cwd`, or the default folder, checked by `checkDir()`.
   - **Profile:** a string `profile` must name an existing team profile, else `not_found` "There is no team profile …". Without one, the settings' `defaultProfile` is used.
   - **Lead backend:** the backend of the profile's first tier must be usable, else an error with Claude Code's own error or `registry.unavailableReason()`.
   - The conversation is created and registered. If the folder differs from `defaultCwd`, it becomes the new default (through `updateSettings()`). `{t:'created', convId, ref}` goes to the requesting tab only.
   - Each inline image is stored with `storeImage()`, since there was no conversation to upload into beforehand; failures are skipped. `blobs` refs are not read for a new conversation.
3. **Existing conversation:** `checkRefs()` validates the uploaded refs against this conversation; uploaded and inline pictures together must stay within 30 MiB. Inline images are stored too and their refs put first. The agent gets the inline images plus the uploaded pictures read back as base64 (`imagesOf()`).
4. `conv.userSend(text, images, agentId?, refs?)`. The stored refs go on the person's transcript item; `images` (base64) is what the agent receives.

## Validation helpers

- `answerPermission(msg)`: settles a pending request; unknown ids are ignored (another tab may have answered). `deny` uses the given message or "The person declined this.". A question gets its string answers. `always` is honoured only when the request has `canAlways`; anything else is `allow`.
- `checkRefs(convId, raw, inline)`: null or missing gives none; not an array is `invalid` "Bad image list.". The refs and inline images together may be at most 8. Each ref's `blob` hash must be found in this conversation's store (`not_found` "That picture is not part of this conversation; attach it again."). The real file sizes are summed against 30 MiB. It returns clean refs with the stored media type, numeric `w`/`h` and the real byte count.
- `imagesOf(convId, refs)`: reads each stored picture as base64 for the agent.
- `checkImages(images)`: not an array gives none; more than 8 is `too_large`. Each must have an allowed type and base64 characters only ("Unsupported image."). Its decoded size is worked out from the base64 length less padding, and is limited to 5 MiB each and 30 MiB in total.
- `checkDir(path)`: `expandHome()`, `resolve`, and it must be a folder ("… is not a folder.").
- `listDirs(path)`: non-hidden sub-folders (and links to folders), sorted. The parent is null at `/`. On Windows, above a drive root the parent is the drive list `DRIVES`, and asking for `DRIVES` lists the drives that exist. A read error is returned in `error`, not thrown.
- `isDir(path)`: true for a folder, following links.

## Exported helpers

- `DRIVES` = `'drives:'`: the folder picker's name for the Windows drive list (not a path any folder can have).
- `expandHome(path, home, platform?)`: replaces a leading `~` (followed by the end or `/`, and on Windows also `\`) with `home`.
- `windowsDrives(exists)`: the roots `A:\` to `Z:\` for which `exists()` is true.

## Points to be aware of

- `remote_settings`, `device_*` and `remote_audit` are refused for devices only by the gate. `remoteMessage()` itself does not check `client.role` (read from the code, not run).
- In `send` to an existing conversation, uploaded and inline pictures share one 30 MiB cap, checked before anything is stored; the agent receives the inline pictures and every uploaded one, even if storing an inline copy failed (tested in `test/send-images.test.ts`).

## Related pages

[Architecture](Architecture.md) · [Browser/server protocol](Browser-Server-Protocol.md) · [Security model](Security-Model.md) · [Remote access](Remote-Access.md) · [server/app/clients.ts](Source-Clients.md) · [server/transport/http.ts](Source-Http.md) · [server/transport/remote.ts](Source-Transport-Remote.md) · [Permissions and questions](Permissions-and-Questions.md)
