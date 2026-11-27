# server/app.ts

**Role:** the whole application behind the web page: settings, conversations, the slot scheduler, connected browser tabs and open approval requests. Its class comment states the key idea: browser tabs are views onto this state, and closing a tab stops nothing. `App` implements `ConversationHost`, so conversations report every change to it, and it saves and broadcasts.

## `Client`

`interface Client { send(msg: ServerMsg): void }`: a connected tab. `server/http.ts` creates one per WebSocket. Keeping it this small means `App` knows nothing about sockets (and a test could pass a fake client).

## Constants

`IMAGE_TYPES` (PNG, JPEG, GIF, WebP), `MAX_IMAGES = 8`, `MAX_TEXT = 400_000` characters, `SAVE_DELAY_MS = 400`.

## Construction

`new App({ store?, claude?, settings?, settingsFile? })`: remembers `settingsFile` (default `SETTINGS_FILE`), loads settings from it (`loadSettings()`), finds Claude Code (`findClaude()`), opens the `Store`, creates the `Scheduler` with a limit function reading current settings, then restores every saved conversation with `Conversation.restore()`. Each option can be supplied instead; the constructor comment says tests pass their own `settingsFile` so they never touch the person's real settings (`test/live.e2e.ts` does exactly that). All later settings changes are written to `settingsFile`.

## `ConversationHost` implementation

| Method | Does |
|---|---|
| `settings()`, `claudePath()` | Current values. |
| `agentChanged(conv, agent)` | Broadcast `{t:'agent'}`; schedule a save of the conversation; and if the conversation's `busy()` value differs from the last one recorded in the private `busy` map, record it and broadcast the `{t:'conversations'}` list, so the page can show which conversations are working. |
| `itemChanged(conv, agent, item)` | Ignore it if the conversation is no longer the one registered under its id (it was deleted and its processes are winding down); otherwise append the item to disk and broadcast `{t:'item'}`. |
| `draftChanged(conv, agent, draft)` | Broadcast `{t:'draft'}` (never saved). |
| `metaChanged(conv)` | Schedule a save; broadcast the full `{t:'conversations'}` list. |
| `rateLimit(notice)` | Broadcast `{t:'rate_limit'}`. |
| `askPermission(...)` | Allow `mcp__masthead__*` tools at once; otherwise create a `PermissionRequest`, store it in `pending`, broadcast it and return a promise settled by the person's answer, by the SDK's abort signal, or by cancellation. See [Permissions and questions](Permissions-and-Questions.md). |
| `cancelPermissions(agentId)` | Deny every pending request from that agent ("The agent was stopped."). |

## Saving

- `scheduleSave(conv)`: if no save is pending for the conversation, start a 400 ms timer; when it fires, save `conv.toStored()` if the conversation still exists. Further changes during those 400 ms are included because the state is read when the timer fires.
- `flush()`: write all pending saves now.
- `shutdown()`: deny all pending approvals ("Masthead is shutting down."), `shutdown()` every conversation, `flush()`.

## Tabs

- `connect(client)`: add it and send `{t:'state'}`. `disconnect(client)`: remove it.
- `broadcast(msg)`: send to every tab.
- `metas()`: each conversation's meta with `busy: conv.busy()` added, sorted by `updatedAt` (newest first).
- `state()`: `AppState` with the version, settings, `metas()`, Claude Code info and home folder.
- `handle(client, raw)`: run `dispatch()`; any thrown error becomes `{t:'error'}` to that tab.
- `conv(id)`: look up a conversation or throw "That conversation no longer exists."

## `dispatch()`

One `switch` on `msg.t`. Every case is described on [Browser/server protocol](Browser-Server-Protocol.md#browser--server-clientmsg). The non-obvious parts:

- **`send` with `convId: null`** creates the conversation, then compares the chosen folder with `defaultCwd` and saves it as the new default if different (so the next new conversation starts where the last one did). `created` goes only to the requesting tab, with its `ref`.
- **`delete`** runs `stopAll()` then `shutdown()` on the conversation, cancels its pending save timer, forgets it (and its `busy` entry), deletes its folder, and broadcasts `deleted` and the new list.
- **`settings`** goes through `sanitizeSettings()` and then `updateSettings()`, which saves to `settingsFile`, calls `scheduler.limitsChanged()`, and broadcasts.

## Validation helpers

- `checkImages(images)`: not an array → none; more than 8 → error; each must have an allowed type and base64 characters only. Returns clean copies.
- `checkDir(path)`: expands a leading `~`, resolves to an absolute path, and checks it is a folder; otherwise "… is not a folder."
- `listDirs(path)`: non-hidden sub-folders (and symbolic links to folders) sorted by name, plus the parent path (null at `/`); a read error is returned in `error` rather than thrown.
- `isDir(path)`: true if the path is a folder, following links.

## Points to be aware of

- Broadcasts are not filtered per conversation; every tab receives every conversation's events.
- `findClaude()` runs synchronously in the constructor and can take up to 15 seconds if `claude --version` hangs.

## Related pages

[Architecture](Architecture.md) · [Browser/server protocol](Browser-Server-Protocol.md) · [server/conversation.ts](Source-Conversation.md) · [server/http.ts](Source-Http.md)
