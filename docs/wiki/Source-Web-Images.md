# Images in the page (images.ts, images/)

How the page attaches, uploads and shows pictures in Masthead 0.2.0. Files: `web/src/lib/images.ts`, `web/src/lib/images/Thumbs.svelte`, `web/src/lib/images/ImageViewer.svelte`, and the picture handling in `Composer.svelte`, `UserItem.svelte` and `ToolItem.svelte`. The server side (storage, routes and tokens) is on [Images on the server](Source-Blobs.md).

The server stores a conversation's images as files named by the hash of their bytes. It accepts PNG, JPEG, GIF and WebP, at most 5 MB and 8192 px a side, and checks the type from the file itself. Items refer to an image by a `BlobRef`: `{blob, mediaType, w, h, bytes}`, where `blob` is the hash.

## `images.ts`

| Export | What it does |
|---|---|
| `MAX_UPLOAD_BYTES` | 5 MB, what the server accepts for one image. |
| `MAX_PICK_BYTES` | 40 MB, the largest file the page will try to shrink; anything bigger is refused at once. |
| `blobUrl(convId, ref, token)` | `/blob/<convId>/<hash>?t=<token>`. |
| `uploadImage(convId, data, mediaType)` | `POST /blob?conv=<convId>` with the bytes as the body; returns the `BlobRef`. Throws with the server's `message`, or "The picture could not be uploaded (<status>)." |
| `shrinkIfLarge(file)` | Makes a large photo smaller in the browser (below). |
| `toBase64(blob)` | Base64 without the `data:` prefix, for the first message of a new chat. |

### Blob token URLs

`<img>` elements cannot send a key or a header, so stored images are fetched with a token in the query. The server gives each socket its own `blobToken` in the version 2 `state`; the store keeps it in `store.blobToken`. The token is per socket and, per the comment in `ImageViewer.svelte`, stops working about a minute after that socket closes. After a reconnect the new state brings a new token and the thumbnails' URLs change with it.

### Upload

Uploads are plain `fetch` calls, not socket messages. The local page proves itself with its key in `x-masthead-key`; a remote device with its token in `x-masthead-device` ([Signing in](Source-Web-Front-End.md#signing-in)).

The Vite dev server proxies `/ws`, `/api` and `/blob` to the Masthead server, so with `npm run dev:web` pictures go through the same routes (read from `vite.config.ts`, not tried).

### Shrinking

`shrinkIfLarge(file)` returns `{blob, mediaType}`:

- GIFs are left alone (they may move), and so is everything when `createImageBitmap` is missing or cannot decode the file, or when the canvas gives no 2D context.
- A file of at most 2 MB whose longer side is at most 2560 px is returned as it is.
- Otherwise it is drawn on an `OffscreenCanvas` with its longer side at most 2560 px.
- A PNG of at most 10 MB stays PNG (screenshots and pictures with transparency), unless the result is over 5 MB; then it becomes JPEG. Everything else becomes JPEG at quality 0.85.

## Attaching pictures (`Composer.svelte`)

Pictures come from the + button (a file picker limited to the four types), from paste (files on the clipboard whose type starts with `image/`) and from drop (only a drag that carries files; dragged text drops into the box as usual, and a file dropped beside the box is stopped so the browser does not leave the app). For each file, in order:

1. Not one of the four types: "Only pictures can be attached (PNG, JPEG, GIF, WebP). For <name>, put it in the folder and mention it."
2. Over 40 MB: refused.
3. Already 8 pictures in the message: refused, and the rest of the batch is skipped.
4. Shrunk (if shrinking throws: "<name> could not be read."); still over 5 MB: "…still larger than 5 MB after shrinking it."
5. The count is checked again, because another paste or drop may have added pictures meanwhile.
6. **New chat:** there is no conversation to upload into yet, so the picture is read as base64 and goes inline in the first message. The message's pictures may total at most 30 MB ("…would take this message over 30 MB of pictures."), because base64 grows by a third and the server's socket limit is 48 MB. If reading it fails, its object URL is revoked and "<name> could not be read." is shown.
7. **Existing chat:** the picture is uploaded at once, so sending is instant and carries only references (`blobs` in the `send` message). The thumbnail shows "Uploading…" and then is ready, or shows "Upload failed" with the reason in its tooltip. Send waits while any picture is uploading and stays disabled until a failed one is removed.

Each picture has an object URL for its preview. It is revoked when the picture is removed, when the server accepts the message, or when a refused message cannot be given back because the person has typed something new. Otherwise a refused message comes back with its pictures ([Actions](Source-Web-Store.md#actions)).

## Showing pictures

### `Thumbs.svelte`

Props: `refs` (`BlobRef[]`) and `label` ("Picture you sent" or "Picture from a tool"). Shows up to four thumbnails as buttons; the fourth carries "+N" when there are more. Each `<img>` has its width and height, `loading="lazy"` and `decoding="async"`, and an empty `alt` because the button carries the label ("Open Picture you sent 1"). A click opens `ImageViewer` with every picture of the item, not only the four shown. Used by `UserItem` (the person's pictures) and `ToolItem` (tool images, shown even when the tool line is closed).

### `ImageViewer.svelte`

The picture at full size over the page. Props: `urls` (`{src, alt, w, h}[]`), `index` (the one clicked) and `onclose`. It is a `role="dialog"` with `aria-modal`. On mount it takes focus; on close focus returns to the element that had it (the thumbnail). Escape closes; ← and → move between the pictures of the same item, as do the ‹ › buttons. The bar shows "2 of 3" (only when there is more than one picture) and the pixel size, "Open in a new tab", and ×.

The "Open in a new tab" link carries the blob token into the new tab's history. The comment records this as accepted in the 0.2.0 security review, because the token is per socket and short-lived.

The transcript stays scrolled to the bottom when a picture finishes loading ([Transcript](Source-Web-Components.md#transcriptsvelte)). On the fake backend the browser test checks that a tool picture shows as a thumbnail, that a click opens the viewer, that Escape closes it with focus back on the thumbnail, and that an upload shows in the sent message ([Page tests](Source-Web-Tests.md#browser-test-testuie2emjs)). The arrow keys and the look of the viewer were not checked in a browser.

## Related pages

[Images on the server](Source-Blobs.md) · [Web store](Source-Web-Store.md) · [Web components](Source-Web-Components.md) · [Security model](Security-Model.md)
