# server/store.ts

**Role:** reads and writes conversations on disk. The layout, and the reasons behind it, are on [Storage on disk](Storage-on-Disk.md); this page is the code reference.

## Types

- `StoredAgent`, one per agent:
  - `info: AgentInfo`;
  - `sessionId: string | null`: the Claude Code session to resume;
  - `owesReport: boolean`;
  - optional `seed: string`: the task of an agent that never got to start, so the task is not lost if the agent is woken later. Written by `Conversation.toStored()` from `Agent.pendingSeed`.
- `StoredConversation`: `meta: ConversationMeta` and `agents: StoredAgent[]`. Produced by `Conversation.toStored()` and read back by `Conversation.restore()`.

## Id safety

`SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/`. `assertId()` throws `bad id: …` for anything else. Every path the store builds goes through it, so an id such as `../../x` can never reach the file system. A unit test checks this.

## `class Store`

`constructor(root = CONVERSATIONS_DIR)` creates the root folder with mode `0700`. Tests pass a temporary folder instead.

**State:** only `root`, the folder path. Nothing is cached in memory; every call reads or writes the files. The private helpers `dir(convId)` and `itemsFile(convId, agentId)` build the paths, both through `assertId()`.

| Method | Behaviour |
|---|---|
| `loadAll()` | For each entry in the root whose name is a safe id, reads its `conversation.json`. Keeps it if it parses, `meta.id` equals the folder name, and `agents` is an array. Unreadable ones are skipped without an error. |
| `saveConversation(conv)` | Creates the folder and `items/` (mode `0700`), then writes `conversation.json` atomically with `writeFileAtomic`. |
| `appendItem(convId, agentId, item)` | Appends one JSON line to `items/<agentId>.jsonl` (mode `0600`). If that fails, usually because the folder does not exist yet, it creates the folder and tries once more. |
| `loadItems(convId, agentId)` | Reads the file and parses each line. It keeps the **last** version of each id at the position where that id **first** appeared, and skips lines that do not parse. Returns `[]` if there is no file. |
| `deleteConversation(convId)` | Removes the conversation's folder and everything in it. |

## Callers

All calls in the server come from `App` in `server/app.ts`, which builds it as `opts.store ?? new Store()` and wraps `appendItem` and `saveConversation` in `safely()`, so a failing disk write is reported once rather than thrown (`loadItems` and `deleteConversation` are not wrapped):

- `loadAll`: in the constructor;
- `saveConversation`: from the delayed save and from `flush`;
- `appendItem`: from `itemChanged`, which skips conversations that have been deleted, so a deleted folder is not recreated by late events;
- `loadItems`: for `{t:'items'}`;
- `deleteConversation`: for `{t:'delete'}`.

The types are imported by `server/conversation.ts` (`StoredConversation` for `restore()` and `toStored()`). Tests that build an `App` (`test/app.test.ts`, `test/live.e2e.ts`) pass their own `Store` on a temporary folder. The page's `store` in `web/src/lib/store.svelte.ts` is a different class with the same name.

## Tests

`test/unit.test.ts` checks two things:

- A transcript keeps its order and the last version of each item.
- Conversations round-trip through save and load, bad ids throw, and delete removes the folder.

`test/app.test.ts` also saves conversations through a `Store` and checks what `loadAll()` returns after a delete.

## Points to be aware of

Transcript files are never compacted. A long transcript with many tool updates keeps every version of every item.

## Related pages

[Storage on disk](Storage-on-Disk.md) · [server/app.ts](Source-App.md)
