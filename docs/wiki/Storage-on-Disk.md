# Storage on disk

Masthead keeps two kinds of files: the **settings**, and **conversations** (each with its agents and their transcripts). This page lists where they are, what is in them, and how they are written safely. Code: `server/config.ts` (paths, settings, `writeFileAtomic`) and `server/store.ts` (`Store`).

## Where

Locations follow the XDG base directory convention, a Linux standard for where programs keep files:

| What | Path | Constant |
|---|---|---|
| Settings | `$XDG_CONFIG_HOME/masthead/settings.json`, default `~/.config/masthead/settings.json` | `SETTINGS_FILE` |
| Conversations | `$XDG_DATA_HOME/masthead/conversations/`, default `~/.local/share/masthead/conversations/` | `CONVERSATIONS_DIR` |

Claude Code's own session files (the actual model conversation history that `resume` uses) are **not** Masthead's; Claude Code keeps them in its own place. Masthead stores only the `sessionId` that points at them.

## Layout

```text
~/.local/share/masthead/conversations/
  <conversation id>/              one folder per conversation (id is a UUID)
    conversation.json             the conversation and all its agents
    items/
      <agent id>.jsonl            one transcript per agent, one item per line
```

### `conversation.json`

A `StoredConversation` (in `server/store.ts`):

- `meta`: `ConversationMeta`: `id`, `title`, `cwd` (the folder agents work in), `createdAt`, `updatedAt`, `leadId`. The `busy` flag the page receives is computed and not stored.
- `agents`: a list of `StoredAgent`, each with:
  - `info`: the full `AgentInfo` (name, tier, parent, task preview, status, model, effort, usage, …).
  - `sessionId`: the Claude Code session to resume, or null if it never started.
  - `owesReport`: whether it still owes its parent a report (not used when loading; see below).
  - `seed` (only present for an agent that never started): its task, so a later wake-up still has it.

It is written as compact JSON (no indentation).

### `items/<agent>.jsonl`

JSON Lines: one `Item` as JSON per line. The file is **append-only**. When an item changes (a tool call gets its result), a new line with the **same id** is appended. When the file is read (`Store.loadItems()`), the last line for each id wins, while the item keeps the position where its id first appeared, so the transcript stays in order. (This relies on a JavaScript `Map` keeping a key's original position when it is set again.) A line that cannot be parsed, such as a half-written last line after a crash, is skipped.

Image data is never stored: a `user` item records only how many images were attached.

## When things are written

| Event | Write |
|---|---|
| Transcript item added or updated | Appended immediately (`App.itemChanged` → `Store.appendItem`), unless the conversation has been deleted. |
| Agent info or conversation meta changed | `conversation.json` rewritten, debounced: the first change starts a 400 ms timer and the save happens when it fires, with the state at that moment (`App.scheduleSave`). |
| App shutdown | All pending saves are written at once (`App.flush`). |
| Settings changed | `settings.json` rewritten at once (`saveSettings`). |
| Conversation deleted | Its whole folder is removed (`Store.deleteConversation`). |

## Writing safely

- `writeFileAtomic(path, data)` writes to `<path>.<pid>.tmp` and then renames it over the real file. A rename is atomic on Linux, so a crash leaves either the old file or the new one, never half of one. Used for `settings.json` and `conversation.json`.
- Files are created with mode `0600` (only the owner can read or write), and folders Masthead creates with mode `0700` (only the owner can enter), including the settings folder.
- Every conversation id and agent id used in a path must match `^[A-Za-z0-9_-]{1,64}$` (`assertId`), so a crafted id cannot point outside the conversations folder.

## Reading back

At start-up, `App`'s constructor calls `Store.loadAll()`, which reads every folder whose name is a safe id and whose `conversation.json` parses and has a matching `meta.id`. Anything unreadable is skipped so one bad file does not stop the app. Each is rebuilt with `Conversation.restore()`, which ignores the stored `owesReport` (nobody is waiting for a report after a restart) but restores `seed`; see [Restarting with saved conversations](Walkthrough-Restarting-the-App.md).

Transcripts are not loaded at start-up. They are read from disk each time a tab asks for one (`{t:'items'}`).

## Related pages

[server/store.ts](Source-Store.md) · [server/config.ts](Source-Config.md) · [Configuration and settings](Configuration-and-Settings.md)
