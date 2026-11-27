# Storage format 2: server/storage/migrate.ts, transcript.ts, atomic.ts and store.ts

**Role:** how 0.2.0 reads and writes conversations: the format version and its migration from 0.1.x, a store-wide format marker, paging a transcript from the end, and renames that survive Windows. The layout is on [Storage on disk](Storage-on-Disk.md). The parts of `server/storage/store.ts` that did not change from 0.1 (`loadItems`, `appendItem`, id safety) are on [server/storage/store.ts](Source-Storage.md); images are on [Images](Source-Blobs.md).

## migrate.ts

`FORMAT = 2`.

`migrateConversation(raw)` brings a parsed `conversation.json` up to `FORMAT`. A file without a numeric `format` is format 1 (every 0.1.x file). Format 1 has the same shape as format 2, so the step only sets `format: 2`. It returns `{value, from}`, where `from` is the format the file was in, or **`null` for a file newer than this version can read**. Later formats are meant to add one step each here.

Tested by "migration: a newer format is left alone; format 1 becomes 2".

## store.ts: the format-2 parts

### `StoredConversation.format`

Optional on read (absent in 0.1.x files); always written as `FORMAT` by `saveConversation`.

### Format marker

The `Store` constructor writes a store-wide marker so a later version can tell what it is opening without reading every file. When the root folder is named `conversations` (the real data folder) the marker is `<data folder>/format`; for any other root (a test's temporary folder) it is `<root>/.format`. If the marker is missing or lower than 2 it is written as `2\n` with `writeFileAtomic`; a marker from a newer Masthead is left as it is. A read-only data folder still loads (tested in `test/storage.test.ts`).

### `loadAll()` with migration

As before, each safe-id folder's `conversation.json` is kept only if `meta.id` matches the folder and `agents` is an array. Then `migrateConversation` runs. A conversation written by a newer Masthead (`null`) is skipped and its file left alone. One from an older format is loaded and its id remembered in `needsBackup`.

### `saveConversation()` and the `.v1.bak` backup

Before the first rewrite of a conversation loaded from an older format, the old file is copied to `conversation.json.v1.bak`, the way back to 0.1.x. **It is written once:** only if no `.v1.bak` exists yet and the old file does, and the id is then dropped from `needsBackup`. The file is written with `writeFileAtomic` as `{...conv, format: 2}`.

Tested by "migration: the 0.1 fixtures load as format 2, back up once, and re-save in the new format", which loads 0.1 fixture files.

### `readItems(convId, agentId, {before, limit})`

One page of a transcript, through `readPage` below. `App` uses it to send pages to the browser and to read an agent's newest item.

### `referencedBlobs(convId)`, `collectBlobs(convId)` and `deleteConversation(convId)`

`referencedBlobs` reads every `items/*.jsonl` of the conversation with `loadItems` and collects `blobsOf` each item. `collectBlobs` removes the images not in that set. `deleteConversation` removes the folder, images included, with `rmSync` retrying up to 5 times 100 ms apart for Windows. Tested by "store: readItems pages a stored transcript; delete removes images too".

## transcript.ts: `readPage(file, {before, limit})`

Reads a transcript (`items/<agent>.jsonl`, one item per line, the last line for an id wins) a page at a time, **newest first**, reading backwards in 64 KB chunks so a long transcript is never read whole.

- `before` is a byte offset; absent or `null` means the end of the file (an offset past the end is clamped).
- It walks complete lines from the back of each chunk. The first line of a chunk may be cut, so it is carried over and joined to the next (earlier) chunk.
- Empty lines, lines that do not parse (a torn line from a crash) and items without a string `id` are skipped.
- An item seen more than once keeps the **newest** version (the first one met going backwards) at the position of its **oldest** line seen, which is its place in the transcript.
- When `limit` distinct items have been found and a new id comes up, it stops. The **cursor** is the byte offset just after that line, so passing it as `before` starts the next older page with that item.
- Returns `{items, cursor, more}`: items oldest first within the page; `cursor` is `null` and `more` is `false` once the start of the file is reached. A missing file gives `{items: [], cursor: null, more: false}`.

An item written both inside and before a page boundary can appear again on an older page in an older version. The comment on `readPage` says the reader keeps the item it already holds, which is the newer one.

Tested by "transcript: pages newest first, in order, with updates resolved and torn lines skipped" and "transcript: a long file is paged across chunk boundaries without losing or repeating items".

## atomic.ts

### `renameRetry(from, to, platform?, rename?)`

On Windows, another program (antivirus, the search indexer) can briefly hold the target and make a rename fail. There, on `EPERM`, `EBUSY` or `EACCES`, it retries up to ten tries in all, waiting 20, 40, … ms between them (about a second in total) with a blocking `Atomics.wait`. On any other platform, or any other error, it throws at once. The platform and the rename function can be passed in for tests.

Tested by "atomic: renames retry on Windows while the target is busy, and nowhere else" (with a fake rename; not run on Windows).

### `writeFileAtomic(path, data)`

Creates the parent folder (`0700`), writes `<path>.<pid>.tmp` with mode `0600`, and moves it into place with `renameRetry`, so a crash never leaves half a file. Used for `conversation.json`, the format marker and the remote access config; the device registry's `devices.json` uses `renameRetry` the same way (see [server/remote/registry.ts](Source-Remote-Registry.md)).

## Tests

`test/storage.test.ts`; all its tests passed when this page was written (`node --import tsx --test test/remote.test.ts test/storage.test.ts`, 35 tests).

## Related pages

[Storage on disk](Storage-on-Disk.md) · [server/storage/store.ts](Source-Storage.md) · [Images](Source-Blobs.md) · [server/app.ts](Source-App.md)
