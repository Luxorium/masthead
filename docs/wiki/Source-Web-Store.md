# Web store (web/src/lib/store.svelte.ts)

**Role:** everything the page knows, kept in step with the server over one WebSocket. Its class comment: "The server owns the truth; this is a view of it, rebuilt from scratch whenever the connection comes back." There is one instance, `store`, imported by every component. `AGENTS.md` names this file as the place the page's state lives.

The `.svelte.ts` extension lets the file use Svelte runes outside a component. Every field marked `$state` redraws whatever reads it when it changes.

## State

| Field | Meaning |
|---|---|
| `connected` | Whether the socket is open. |
| `app`, `settings`, `conversations` | From `state`, `settings` and `conversations` messages. |
| `convId` | The open conversation, or null for the new-conversation screen. |
| `agents` | `AgentInfo` by id, for the open conversation only. |
| `viewAgentId` | The agent whose chat is shown; null means the lead. |
| `items`, `drafts` | Transcripts and live drafts by agent id, only for agents that have been loaded. |
| `pending` | Open approval requests (all conversations). |
| `view` | `'chat'` or `'map'`. |
| `newCwd`, `dirs` | The folder chosen for a new conversation, and the folder picker's current listing. |
| `error`, `rateLimit` | The toast message, and the usage-limit notice (cleared when the status is `allowed`). |
| `creating` | True between sending the first message of a new conversation and the server's `created`. |

Derived values (recomputed automatically):

- `conv`: the open conversation's meta.
- `agentList`: agents sorted by creation time.
- `lead`.
- `viewAgent`: the viewed agent, else the lead.
- `viewItems`, `viewDraft`.
- `convPending`: requests for the open conversation.
- `liveCount`: live sub-agents, shown on the "Team map" tab.

## Connecting

`connect()` opens `ws://<page host>/ws` (`wss` on https). If the socket closes, it tries again after 400 ms, doubling each time up to 5 seconds. On reconnect, the server's `state` message makes the store reopen the current conversation, so nothing stays stale.

`send(msg)` refuses with the toast "Not connected to Masthead. Is it still running?" when the socket is not open, and returns false so callers can keep what the person typed.

## Receiving (`receive()`)

| Message | What the store does |
|---|---|
| `state` | Stores the app state, settings and list. Sets `newCwd` to the default folder if empty. Reopens the current conversation, or the one in the URL hash if it exists; otherwise shows the new-conversation screen. |
| `conversations` | Replaces the list. |
| `conversation` | Ignored unless it is for the open conversation. Replaces `agents`, merges in its pending requests, keeps the viewed agent if it still exists, and loads that agent's transcript. |
| `created` | If `ref` matches its own request, clears `creating` and opens the new conversation. |
| `deleted` | Drops its pending requests; returns to the new-conversation screen if it was open. |
| `items` | Stores the transcript and draft (open conversation only). |
| `agent` | Updates the agent if it belongs to the open conversation. |
| `item` | Replaces the item with the same id, or appends it. Ignored if that transcript was never loaded. |
| `draft` | Stores it (open conversation only). |
| `permission_request` / `permission_resolved` | Adds or removes the request. |
| `settings` | Replaces the settings. |
| `rate_limit` | Keeps the notice unless the status is `allowed`. |
| `dirs` | Stores the listing for the folder picker. |
| `error` | Clears `creating` and shows the toast. |

## Actions

- `open(convId, agentId?)`: clears the agent data, sets the URL hash to `#/c/<id>` and sends `open`.
- `newConversation()`: clears everything and removes the hash.
- `loadItems(agentId)`: sends `items` if that transcript is not loaded yet.
- `viewOf(agentId)`: shows that agent's chat (null for the lead) and loads its transcript.
- `sendMessage(text, images)`:
  - On the new-conversation screen, it sends `send` with `convId: null`, the chosen folder and a fresh `ref`, and sets `creating`.
  - Otherwise it sends to the open conversation, with `agentId` when a sub-agent's chat is open.
- `saveSettings(next)`: updates the local copy immediately and sends `settings`.
- `answer(requestId, decision, answers?)`: sends `permission` and removes the card at once.
- `childrenOf(id)`, `pathTo(id)`: tree helpers for the map, the panel and the breadcrumbs.

## Helpers exported with it

- `fmtTokens(n)`: "850", "12k", "1.25M".
- `shortPath(path, home)`: replaces the home folder with `~`.
- `STATUS_LABEL`: the words shown for each status: Queued, Working, Waiting on its agents, Idle, Done, Failed, Stopped.

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web components](Source-Web-Components.md) · [Browser/server protocol](Browser-Server-Protocol.md)
