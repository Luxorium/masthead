# Web store (web/src/lib/store.svelte.ts)

**Role:** everything the page knows, kept in step with the server over one WebSocket. Its class comment: "The server owns the truth; this is a view of it, rebuilt from scratch whenever the connection comes back." There is one instance, `store`, imported by every component. `AGENTS.md` names this file as the place the page's state lives.

The `.svelte.ts` extension lets the file use Svelte runes outside a component. Every field marked `$state` redraws whatever reads it when it changes. This page describes version 0.1.3.

Users: `App.svelte` and every component in `web/src/lib/` import `store`; `Transcript`, `TeamPanel`, `TeamMap` and `App` also use the exported helpers below.

## Types and constants

- `ComposerImage`: an `ImageAttachment` (`mediaType`, base64 `data`) plus `url` (an object URL for the thumbnail), `name` and `size` (bytes, for the 30 MB total).
- `ComposerDraft`: `{ text, images: ComposerImage[] }`, what the composer holds for one conversation and agent.
- `Sent` (not exported): a message handed to the server and not yet accepted: `ref`, the composer `key` it came from, `convId` (null for a new conversation), `text` and `images`.
- `DirListing`: the folder picker's listing (`path`, `parent`, `entries`, optional `error`).
- `KEY_STORAGE = 'masthead.key'`: the `localStorage` name of the sign-in key.
- `MAX_REFUSALS = 3`: closes in a row before the socket ever opened, after which the page stops retrying by itself.

## State

| Field | Meaning |
|---|---|
| `connected` | Whether the socket is open. |
| `signedOut` | `'nokey'` (no key in this browser), `'refused'` (three closes before the socket ever opened) or null. `App.svelte` shows the sign-in page when set. |
| `app`, `settings`, `conversations` | From `state`, `settings` and `conversations` messages. |
| `convId` | The open conversation, or null for the new-conversation screen. |
| `agents` | `AgentInfo` by id, for the open conversation only. |
| `viewAgentId` | The agent whose chat is shown; null means the lead. |
| `items`, `drafts` | Transcripts and live drafts by agent id, only for agents that have been loaded. |
| `pending` | Open approval requests in every conversation. Replaced from `state.pending` on every `state` message, so the sidebar counts are right after a reload or reconnect. |
| `view` | `'chat'` or `'map'`. |
| `newCwd`, `dirs` | The folder chosen for a new conversation, and the folder picker's current listing. |
| `error`, `rateLimit` | The toast message, and the notice the banner shows: the worst known usage window (`rejected`, else `allowed_warning`, else none). |
| `usage` | The latest notice per usage window (`five_hour`, `seven_day`, …), filled from `state.usage` and updated by each `rate_limit`. The server sends one notice per window. |
| `creating` | True between sending the first message of a new conversation and the server's `created`. Reset on `state`, on socket drop and on errors. |
| `composer` | Unsent text and images (`ComposerDraft`) per conversation and agent, keyed by `composerKey` (`<convId or 'new'>:<agentId or 'lead'>`). Kept while you switch around; lost on reload. |

Derived values (recomputed automatically):

- `conv`: the open conversation's meta.
- `agentList`: agents sorted by creation time.
- `lead`.
- `viewAgent`: the viewed agent, else the lead.
- `viewItems`, `viewDraft`.
- `convPending`: requests for the open conversation.
- `liveCount`: live sub-agents, shown on the "Team map" tab.
- `composerKey`: the key of the draft on screen now.

## Connecting

`connect()` first takes the sign-in key: from `?key=` in the address (saved to `localStorage` as `masthead.key` and removed from the address), else from `localStorage`, which is read again on every connect in case another tab was signed in with a newer key. With no key it sets `signedOut = 'nokey'` and stops. Otherwise it opens `ws://<page host>/ws` (`wss` on https) with the subprotocols `masthead` and `key.<secret>`.

If the socket closes, it tries again after 400 ms, doubling each time up to 5 seconds. Three closes in a row without the socket ever opening set `signedOut = 'refused'` and stop; `retryConnect()` (the Try again button) starts over. On reconnect, the server's `state` message makes the store reopen the current conversation, so nothing stays stale.

When a socket closes, messages sent but not yet accepted go back into the composer (see `sendMessage`).

Private fields behind this: `ws` (the current socket), `retry` (the back-off step), `refusals` (closes without an open, reset on open and by `retryConnect`), `errorTimer` (the toast's 8-second timer), `pendingRef` (the `ref` of the new-conversation send in flight) and `sent` (the `Sent` list).

Internal steps:

- **`dropped()`** runs when the current socket closes: clears `creating` and `pendingRef`, and gives every unaccepted `Sent` back.
- **`giveBack(s)`** puts a refused or unconfirmed message back into its draft (`composerFor(s.key)`), but only if that draft is empty; if the person has typed something new there, the old message is dropped and its image URLs revoked. Newer typing is never overwritten.
- **`accepted(match)`** removes the first `Sent` that matches and revokes its image object URLs.
- **`takeKey()`** (module function) reads `?key=` from the address: if present, saves it to `localStorage` (ignoring a storage error, such as private mode), removes it from the address with `history.replaceState` (path, other query and hash kept) and returns it. Otherwise it reads `localStorage` again, so a newer key written by another tab is picked up, and falls back to the key this page load already had (`pageKey`).
- **`idFromHash()`** (module function) returns the conversation id from `#/c/<id>` (letters, digits, `_` and `-` only), or null.

`send(msg)` refuses with the toast "Not connected to Masthead. Is it still running?" when the socket is not open and returns false, so callers can keep what the person typed. `fail(message)` shows the toast and clears it after 8 seconds, restarting the timer if another error comes first.

## Receiving (`receive()`)

| Message | What the store does |
|---|---|
| `state` | Stores the app state, settings and list; replaces `pending` and `usage`; clears `creating`. Sets `newCwd` to the default folder if empty. Reopens the current conversation, or the one in the URL hash if it exists; otherwise shows the new-conversation screen. |
| `conversations` | Replaces the list. |
| `conversation` | Ignored unless it is for the open conversation. Replaces `agents`, merges in its pending requests, keeps the viewed agent if it still exists, and loads that agent's transcript. |
| `created` | Marks the send with that `ref` as accepted. If `ref` matches its own new-conversation request, clears `creating` and opens the new conversation. |
| `deleted` | Drops its pending requests; returns to the new-conversation screen if it was open. |
| `items` | Stores the transcript and draft (open conversation only). |
| `agent` | Updates the agent if it belongs to the open conversation. |
| `item` | A `user` item marks the matching pending send (same conversation and text) as accepted. Then, for the open conversation, replaces the item with the same id or appends it; ignored if that transcript was never loaded. |
| `draft` | Stores it (open conversation only). |
| `permission_request` / `permission_resolved` | Adds or removes the request. |
| `settings` | Replaces the settings. |
| `rate_limit` | Stores the notice in `usage` under its window, and points `rateLimit` at the worst known window. |
| `dirs` | Stores the listing for the folder picker. |
| `error` | If `ref` names a pending send, gives it back to the composer (and clears `creating` if it was the new-conversation request). An error without `ref` clears `creating`. Shows the toast. |

## Actions

- `open(convId, agentId?)`: clears the agent data, sets the URL hash to `#/c/<id>` and sends `open`.
- `newConversation()`: clears everything and removes the hash.
- `loadItems(agentId)`: sends `items` if that transcript is not loaded yet.
- `viewOf(agentId)`: shows that agent's chat (null for the lead) and loads its transcript.
- `composerFor(key)`: the draft for a key, created empty if missing.
- `sendMessage(key)`: sends that draft with a fresh `ref` and empties it, keeping a copy until the server accepts it.
  - On the new-conversation screen, it sends `send` with `convId: null` and the chosen folder, and sets `creating`.
  - Otherwise it sends to the open conversation, with `agentId` when a sub-agent's chat is open.
  - Accepted means `created` with that `ref`, or the `user` item appearing. Refused (`error` with that `ref`) or a dropped socket puts the text and images back, unless the person has already typed something new in that draft.
- `dropItems(agentId)`: forgets a transcript fetched only for a team-map preview (never the one on screen).
- `updateSettings(change)`: clones the settings, applies `change`, and calls `saveSettings()`.
- `saveSettings(next)`: updates the local copy immediately and sends `settings`.
- `answer(requestId, decision, answers?)`: sends `permission` and removes the card, unless the send failed (not connected), in which case the card stays.
- `childrenOf(id)`: the agents whose `parentId` is `id`, in start order (from `agentList`). Used by the team panel tree, the team map and the transcript's "Waiting on N agents".
- `pathTo(id)`: the chain from the lead down to that agent, following `parentId`. Used by the breadcrumbs.
- `retryConnect()`: resets the refusal and back-off counters and connects again (the sign-in page's Try again).

## Helpers exported with it

- `fmtTokens(n)`: "850", "12k", "1.25M".
- `shortPath(path, home)`: replaces the home folder with `~`.
- `fmtTokens` and `shortPath` are used by `TeamPanel`, `TeamMap`, `Composer`, `App` and `FolderPicker`.
- `STATUS_LABEL`: the words for each status: Queued, Working, Waiting, Idle, Done, Failed, Stopped. "Waiting" covers both agents it started and a command left running in the background.
- `statusWords(agent)`: the one place a status becomes words for the panel and the map. It adds the sub-states: "Waiting for an answer from <Name>" when `waitingFor` is set, the activity while running, "Failed: <error>". A new sub-state is one line here. Agent names go through `displayName` from `shared/protocol.ts`, so "alpha-ii" reads "Alpha II" (0.1.3 names rounds after Zulu with Roman numerals). Used by `TeamPanel`, `TeamMap` and `Transcript`.

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web components](Source-Web-Components.md) · [Browser/server protocol](Browser-Server-Protocol.md)
