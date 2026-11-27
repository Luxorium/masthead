# Images: server/storage/blobs.ts, server/storage/images.ts, server/transport/blobs.ts

**Role:** stores the images of a conversation (the person's attachments and images from tool results) as files named by the hash of their bytes, and serves them over HTTP. `images.ts` decides what an image is from its bytes. `blobs.ts` stores, finds and removes them. `server/transport/blobs.ts` holds the upload and fetch routes and the tokens that guard fetching. The layout on disk is on [Storage on disk](Storage-on-Disk.md).

## images.ts: sniffing by magic bytes

`sniffImage(bytes)` returns `{mediaType, w, h}` or `null`. It uses no native library, only the few header fields it needs. The type always comes from the bytes, never from a name or a declared type. It tries, in order:

- **PNG:** the 8-byte signature `89 50 4E 47 0D 0A 1A 0A`, an `IHDR` chunk at byte 12; width and height are big-endian 32-bit at bytes 16 and 20.
- **JPEG:** `FF D8 FF`, then it walks the markers (skipping fill bytes, `D8`, `01` and the restart markers `D0`–`D7`) until a start-of-frame marker in `C0`–`CF` other than `C4`, `C8` and `CC`, and reads height then width from it. A marker that does not start with `FF`, or a length under 2, gives `null`.
- **GIF:** `GIF87a` or `GIF89a`; width and height little-endian 16-bit at bytes 6 and 8.
- **WebP:** `RIFF` … `WEBP`, then the `VP8 ` (lossy, with its `9D 01 2A` start code), `VP8L` (lossless, with its `2F` signature) or `VP8X` (extended) chunk, each read the way its format stores the size.

Anything else, or a width or height under 1, is `null`. `EXT` maps the four types to `png`, `jpg`, `gif`, `webp`; `TYPE_OF_EXT` maps back. Tested by "images: the type and size come from the bytes".

## blobs.ts

### Types and caps

- `BlobRef`, how an item refers to a stored image: `{blob, mediaType, w, h, bytes}`, where `blob` is the SHA-256 hex.
- `BlobError` with a `code` of `too_large`, `invalid` or `not_found`.

| Constant | Value | Where it is enforced |
|---|---|---|
| `MAX_BLOB_BYTES` | 5 MB | `BlobStore.put` and the upload route |
| `MAX_MESSAGE_IMAGE_BYTES` | 30 MB per message | Not referenced anywhere else in `server/`, `shared/`, `web/src/` or `test/` when this page was written. |
| `MAX_CONVERSATION_BLOB_BYTES` | 500 MB per conversation | `BlobStore.put` |
| `MAX_SIDE` | 8192 pixels a side | `BlobStore.put` |
| `MAX_PIXELS` | 40 000 000 (40 megapixels) | `BlobStore.put` |

### `class BlobStore`

`constructor(root)`: `root` is the conversations folder. Each conversation keeps its images in `<root>/<convId>/blobs/`, so they go when the conversation's folder is deleted. `Store` builds one as `store.blobs`. The private `dir(convId)` throws `BlobError('invalid')` unless the id matches `^[A-Za-z0-9_-]{1,64}$`.

**`put(convId, bytes, declared?)`** checks and stores, in order:

1. Empty → `invalid`. Over 5 MB → `too_large`.
2. `sniffImage` does not recognise it → `invalid` ("Only PNG, JPEG, GIF and WebP images can be stored.").
3. A declared type that differs from the sniffed one → `invalid`.
4. Wider or taller than 8192 pixels, or over 40 megapixels → `too_large`.
5. **Content addressing:** the file name is `<sha256>.<ext>`, so the same image is stored once. If the file already exists, nothing is written and the 500 MB check is skipped.
6. Otherwise, if the conversation's existing images plus this one exceed 500 MB → `too_large`. It creates `blobs/` with mode `0700`, writes a temporary `.<hash>.<random>.tmp` with mode **`0600`**, and moves it into place with `renameRetry`.

It returns the `BlobRef`. Tested by "blobs: stored once by hash, 0600, type from the bytes; mislabelled, polyglot and over-size files refused".

**`find(convId, hash)`** returns `{file, mediaType}` or `null`. **Path checks:** it returns `null` unless the id is a safe id and the hash is exactly 64 lower-case hex characters, then tries only `<hash>.png`, `.jpg`, `.gif` and `.webp` and accepts only a regular file. Only names Masthead wrote are ever looked up. Tested by "blobs: lookups refuse path tricks; garbage collection keeps only referenced blobs".

**`total(convId)`** adds up the sizes of the files whose names match `<64 hex>.(png|jpg|gif|webp)`.

**`collect(convId, referenced)`** deletes every such file whose hash is not in `referenced` and returns how many it removed. `Store.collectBlobs()` passes the hashes from `Store.referencedBlobs()`, and `App` runs it for each conversation it loads at start-up, wrapped in `safely()` (read from the code, not run).

### `blobsOf(item)`

Every blob hash an item refers to: the entries of `item.images` that have a 64-hex `blob`. Anything else, including the plain number `images` count of 0.1 items, gives nothing.

## server/transport/blobs.ts: the routes

`http.ts` (the local listener) and `server/transport/remote.ts` (the remote listener) do the `Host`/`Origin` checks and decide who the caller is; these handlers do the rest. No path from the client reaches the file system: the conversation id and hash are matched by pattern and then looked up with `find`.

### `class BlobTokens`

Per-socket tokens that let a plain `<img src>` fetch an image, since an image request cannot carry a header.

- `issue()` makes a 24-byte random token (base64url) and keeps only its SHA-256, valid until released. `attach()` in `http.ts` issues one per WebSocket and sends it to the page as `blobToken`; on close it calls `release`.
- `release(token)` keeps the token valid for a **60 s grace** period after the socket closes, so cached pages keep working across a quick reconnect.
- `check(token)` refuses anything that is not a string of 1–100 characters, drops expired entries, then compares the hash against **every** live entry with `timingSafeEqual`, without stopping at the first match, so the time taken does not depend on which token matched.

Each listener has its own `BlobTokens`, so a token from the local page does not work on the remote listener or the other way round. A token is not tied to a conversation: any live token can fetch any conversation's images (read from the code, not run).

### `handleBlobGet(req, res, url, {blobs, tokens})`: `GET /blob/<convId>/<sha256>?t=<token>`

Returns `false` for any path not starting with `/blob/`. Otherwise it handles the request:

- not `GET` or `HEAD` → 405;
- token from `?t=` fails `check` → 403;
- path does not match `^/blob/<safe id>/<64 hex>$`, or `find` finds nothing → 404;
- `HEAD` → 200 with the headers below and no body;
- `GET` → streams the file. Headers are sent only once the file has opened; an error before that gives 404, after it destroys the response.

**Headers on success:** `content-type` (the sniffed type), `x-content-type-options: nosniff`, `content-disposition: inline`, `content-security-policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox` (opened on its own, the response can run nothing), `cache-control: private, max-age=31536000, immutable` (safe because the name is the content's hash), `cross-origin-resource-policy: same-origin` and `referrer-policy: no-referrer`. Error answers are plain text with `nosniff` and `cache-control: no-store`.

### `handleBlobPost(req, res, url, {blobs, authorised, convExists})`: `POST /blob?conv=<convId>`

The body is the raw image bytes. Returns `false` unless the path is exactly `/blob`. Answers are JSON with `nosniff` and `no-store`:

- not `POST` → 405;
- `authorised` false → 403 `{code:'refused'}`. On the local listener `authorised` is the `x-masthead-key` check; on the remote listener it is true only for an approved device with role `full` (token in `x-masthead-device`);
- bad or unknown conversation id → 404;
- `content-length` over 5 MB → 413 at once; a body that grows past 5 MB while streaming → 413, and the rest is drained;
- otherwise `blobs.put` with the `content-type` as the declared type (`application/octet-stream` counts as undeclared): 200 with the `BlobRef`, or 413/400 from a `BlobError`, or 500.

Tested by "routes: upload checks the caller, the conversation, the type and the size" and "routes: fetch needs a live token and serves only stored blobs, with safe headers".

## Tests

`test/storage.test.ts`; all its tests passed when this page was written. The route tests use a local test server, not the remote listener.

## Related pages

[Storage on disk](Storage-on-Disk.md) · [Storage format 2](Source-Storage-Format.md) · [Security model](Security-Model.md) · [Remote access](Remote-Access.md) · [server/transport/http.ts](Source-Http.md) · [server/transport/remote.ts](Source-Transport-Remote.md)
