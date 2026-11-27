# Storage on disk

Masthead writes two kinds of files: the **settings** (in the config folder) and the **data**: conversations, their agents, transcripts and images, plus the local secret and the remote-access records (in the data folder). This page lists where these files are, what is in them, how they are written safely, and what a 0.1.x install keeps. Code: `server/paths.ts`, `server/settings/settings.ts` ([settings code](Source-Settings.md)) and `server/storage/` ([storage code](Source-Storage.md)).

## Where

| What | Linux (default) | macOS | Windows |
|---|---|---|---|
| Config folder (`CONFIG_DIR`) | `~/.config/masthead` | `~/Library/Application Support/Masthead` | `%APPDATA%\Masthead` |
| Data folder (`DATA_DIR`) | `~/.local/share/masthead` | same as config | `%LOCALAPPDATA%\Masthead` |

`XDG_CONFIG_HOME` / `XDG_DATA_HOME` replace the base folder on every platform. `MASTHEAD_CONFIG_DIR` / `MASTHEAD_DATA_DIR` replace the whole path and win over everything else (`appDirs()`). See [Configuration and settings](Configuration-and-Settings.md#environment-variables).

## Layout

```text
<config>/
  settings.json                 settings, format version 2
  settings.json.v1.bak          the 0.1.x settings file, copied once before migration
<data>/
  format                        "2": whole-store format marker
  secret                        the local server's secret (mode 0600)
  remote/                       remote access: devices.json, audit.jsonl (see Remote access)
  conversations/
    <conversation id>/          one folder per conversation (id is a UUID)
      conversation.json         the conversation and all its agents, format 2
      conversation.json.v1.bak  the 0.1.x file, copied once before the first rewrite
      items/
        <agent id>.jsonl        one transcript per agent, one item per line
      blobs/
        <sha256>.<png|jpg|gif|webp>   images, named by the hash of their bytes
```

A backend's own session files are not Masthead's. Claude Code and Codex keep the actual model history that a resume uses in their own folders. Masthead stores only the `sessionId` that points to it.

## Format 2

There are two version markers:

- **The whole-store marker** `<data>/format` holds `2` and a newline. `new Store()` writes it when it is missing or different. A store in a temporary folder whose name is not `conversations`, as in the tests, keeps it inside as `.format`. Today nothing reads it to make a decision. It is there so that a later version can tell what it is opening without reading every file.
- **Per file**: `conversation.json` carries `"format": 2`. A file without `format` is a 0.1.x file and counts as format 1 (`migrateConversation()` in `server/storage/migrate.ts`). A file with a format higher than 2 was written by a newer Masthead; it is skipped and left untouched.

### `conversation.json`

A `StoredConversation`, written as compact JSON:

- `format`: 2.
- `meta`: `id`, `title`, `cwd` (the folder the agents work in), `createdAt`, `updatedAt`, `leadId`, `profileId` (the team profile, new in 0.2.0; missing means `claude`), `team` (the profile's tiers copied at creation), and the optional [team-compaction](Compact-Team.md) fields described below (`compact`, `compactMark`, `compactSuggested`, `autoCompact`). `busy` is never stored.
- `agents`: one `StoredAgent` each: `info` (the full `AgentInfo`), `sessionId` (or null), `owesReport` (saved, but ignored on load: after a restart nobody is waiting for a report), and `seed` (only for an agent that never started, so a later wake-up still has its task).
  An archived helper is an ordinary entry here whose `info.archived` holds when it was archived (ms since 1970). On load, `Conversation`'s state for it is rebuilt with `archived` set, so it stays out of the team, cannot be woken and is left out of the "closed while working" note.
- `stoppedByPerson` (since 0.1.4): ids of agents the person stopped, which other agents may not wake.
- `agentMessages` (since 0.1.4): how many messages the agents have sent each other, counted against the limit of 1000.

### Team compaction (new in 0.2.0)

What [Compact team](Compact-Team.md) saves, all in `conversation.json` and all optional:

| Field | Holds | Written when |
|---|---|---|
| `agents[].info.archived` | When the helper was archived. Removed (`undefined`) when the person restores it. | Archiving (`Conversation.archiveAndCompact()`), restoring (`restoreAgent()`). |
| `meta.compact` | The `CompactState` of the flow under way or last ended: `phase`, `auto`, `reason`, `keep`, `archive`, `note`, `pending`, `failed`, `startedAt`, `askedAnswered`. A finished flow stays as `done` or `cancelled` until the next one replaces it. | Every phase change (`setCompact()`). |
| `meta.compactMark` | `{finished, memoryArmed}`: the cool-down for automatic tidying. | When automatic tidying fires, when the person types `/compact`, and when memory drops back under 70 %. |
| `meta.compactSuggested` | `true` once the lead has been told it may suggest `/compact` (automatic tidying off). | That one time. |
| `meta.autoCompact` | `false` when the person switched automatic tidying off for this conversation; absent otherwise. | The `auto_compact` message. |

These go through the same delayed save as any other meta or agent change (`App.metaChanged()` / `agentChanged()` → `scheduleSave`). **Transcripts are untouched**: archiving writes nothing to `items/`, and an archived helper's `.jsonl` stays where it was, read by `read_archive` and `{t:'archive_items'}`. Compacting an agent's memory happens in the backend's own session (Claude Code or Codex), not in Masthead's files.

On start-up `Conversation.resumeCompact()` carries on from the saved phase: `asked` becomes `cancelled` with a note to type `/compact` again; `archiving` runs the archiving again (it is idempotent); `compacting` continues with `pending`; `proposed` keeps its card.

**Older builds.** 0.2.0-beta.1 does not know these fields. Read from its code (`Conversation.restore()` at tag `v0.2.0-beta.1` copies `meta` and each `info` whole): it keeps them and writes them back, but ignores them, so archived helpers show up again as ordinary finished helpers and a flow under way is not resumed. Going forward again to beta.2 finds the fields still there. Not tried with a beta.1 build.

### `items/<agent>.jsonl`

JSON Lines: one `Item` per line. The file is **append-only**. When an item changes (for example, a tool call gets its result), a new line with the **same id** is appended. On reading, the last line for each id wins, and the item keeps the position where its id first appeared. A line that does not parse, such as a half-written last line after a crash, is skipped.

Images are **not** written into the jsonl. A `user` or `tool` item carries `images: BlobRef[]` (`{ blob, mediaType, w, h, bytes }`) that point to files in `blobs/`. In 0.1.x files a `user` item's `images` is just a count; it is read as it is.

### Images (`blobs/`)

- Each file is named `<sha256 of the bytes>.<ext>`, so the same image is stored once per conversation.
- The type comes from the bytes (`sniffImage()`): only PNG, JPEG, GIF and WebP are accepted, and a declared type must match.
- Limits: at most 5 MB per image, 8192 pixels a side, 40 megapixels, and 500 MB of images per conversation.
- Images are written to a hidden temporary file and renamed into place.
- Unreferenced images are deleted when `App` loads each conversation at start-up (`Store.collectBlobs`): any file in `blobs/` that no item in any of the conversation's transcripts names.
- Deleting a conversation removes its images along with everything else.
- The page fetches them from `GET /blob/<convId>/<hash>?t=<token>` and uploads with `POST /blob?conv=<id>` ([Security model](Security-Model.md)).

## Paging

The page no longer needs a whole transcript at once. `{t:'items', limit, before}` returns the newest `limit` distinct items before byte offset `before` (`readPage()` in `server/storage/transcript.ts`), oldest first, with a `cursor` for the next older page and `more`. The file is read **backwards** in 64 KiB chunks, so a long transcript is never read in full. `App` clamps `limit` to 1–500. Without `limit`, the whole transcript is sent (the version 1 behaviour).

## Transcript compaction (not implemented)

Not to be confused with team compaction above. The 0.2.0 design (`docs/plans/0.2.0/core.md`, section 6) planned rewriting a transcript that holds more than twice as many lines as distinct ids, and optional `items/<agent>.idx` offset files. Neither exists in the code on `next`. Transcripts only grow, and the old lines of a changed item stay in the file.

## When things are written

| Event | Write |
|---|---|
| Transcript item added or changed | Appended at once (`App.itemChanged` → `Store.appendItem`). |
| Agent info or conversation meta changed (including archiving, restoring and each compaction phase) | `conversation.json` rewritten after 400 ms (`SAVE_DELAY_MS`), with the state at that moment (`App.scheduleSave`). |
| App shutdown | All pending saves are written at once (`App.flush`). |
| Settings changed | `settings.json` rewritten at once (`saveSettings`). |
| Image uploaded or sent | `blobs/<hash>.<ext>` written at once (`BlobStore.put`). |
| Conversation deleted | Its whole folder is removed (`Store.deleteConversation`, with retries for Windows). |

Writes go through `App.safely()`. A failure, such as a full disk, is logged once per kind (`transcript`, `conversation`, `settings`, `images`) until a write of that kind works again. It never stops the server.

## Writing safely

- `writeFileAtomic(path, data)` (`server/storage/atomic.ts`) writes `<path>.<pid>.tmp` and renames it over the real file, so a crash leaves either the old file or the new one. It is used for `settings.json`, `conversation.json` and the `format` marker. On Windows the rename is retried for about a second while another program (antivirus, the search indexer) holds the file (`renameRetry`).
- Files are created with mode `0600` and folders with mode `0700`. (On Windows these modes have little effect; the folders' default permissions apply.)
- Every conversation id and agent id used in a path must match `^[A-Za-z0-9_-]{1,64}$`, so a crafted id cannot point outside the conversations folder. Blob names must be 64 hex characters.

## Reading back

At start-up `App` calls `Store.loadAll()`. It reads every folder whose name is a safe id and whose `conversation.json` parses, has a matching `meta.id` and has a format this version can read. Anything else is skipped, so one bad file does not stop the app. Each conversation is rebuilt with `Conversation.restore()`. Agents that were working are marked stopped, and the lead gets a note naming them. See [Restarting with saved conversations](Walkthrough-Restarting-the-App.md).

Transcripts are not loaded at start-up. They are read when a page asks for them, plus one item per agent for the snapshot a subscribing page gets.

## What stays compatible with 0.1.x

- **0.2.0 reads 0.1.x data unchanged.** The Linux folders are the same. A conversation file without `format` is format 1, which has the same shape. Tier ids `lead`/`opus`/`sonnet`/`haiku` belong to the built-in `claude` profile. A `user` item's image count still loads. A settings file without `version` is migrated into the `claude` profile.
- **Backups before the first rewrite.** `settings.json.v1.bak` is copied when a 0.1.x settings file is loaded. `conversation.json.v1.bak` is copied when a 0.1.x conversation is first saved again. Neither backup is ever overwritten.
- **Going back.** 0.1.x does not know `format` 2, `profiles` or blob references. To downgrade, restore the `.v1.bak` files. Changes made under 0.2.0 after the backup are lost, and images added under 0.2.0 do not show. The transcript `.jsonl` files keep the same line format and have no backup. This page does not claim a 0.1.x build was tried against 0.2.0 data.

## Related pages

[Storage code](Source-Storage.md) · [Settings code](Source-Settings.md) · [Team profiles and settings](Team-Profiles-and-Settings.md) · [Configuration and settings](Configuration-and-Settings.md) · [Remote access](Remote-Access.md) · [Compact team](Compact-Team.md)
