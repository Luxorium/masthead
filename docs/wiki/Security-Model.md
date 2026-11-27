# Security model

Masthead's server can run commands and edit files as the person, because the Claude Code agents it starts can. Anyone who can talk to the server can therefore act as the person. This page explains what the server does to limit who can reach it, and what it does not protect against. How the agents themselves are kept in hand is on [Safety model](Safety-Model.md). Code: `serve()` and `serveStatic()` in `server/http.ts`; the secret in `server/config.ts`; input checks in `server/app.ts` and `server/store.ts`. Everything here was read from the code at 0.1.4. The HTTP checks are exercised by `test/http.test.ts` and the sign-in file by `test/launcher.test.ts` (see [Tests](Source-Tests.md)); the rest was not verified by running.

## What it defends against

The main threat considered in the code is **a web page on another site** trying to use the person's browser to reach the local server. Browsers let any page send requests to `127.0.0.1`, so local servers need their own checks.

### 1. Listening only on the loopback address

`server.listen(port, '127.0.0.1')` in `serve()`. Other machines on the network cannot connect. Other user accounts on the same machine can connect to the port, which is why the secret below exists.

### 2. The Host header check (DNS rebinding)

**DNS rebinding** is a trick where an attacker's domain name is made to point at `127.0.0.1`, so the attacker's page becomes "same origin" with the local server in the browser's eyes. The browser still sends the attacker's name in the `Host` header. Every HTTP request and the WebSocket upgrade must therefore carry `Host: 127.0.0.1:<port>` or `localhost:<port>`, or get `403 Forbidden` (`hostOk()`).

In development mode (`MASTHEAD_DEV=1`, see [server/main.ts](Source-Main.md)) the list also contains `localhost:<dev port>` and `127.0.0.1:<dev port>`, the Vite development server that forwards the page's requests. The dev port is `MASTHEAD_DEV_WEB_PORT`, 7718 by default. The check itself is never switched off. `AGENTS.md` makes this a rule for anyone changing the code: the server binds to `127.0.0.1` and checks `Host` and `Origin`, and neither may be weakened.

### 3. The Origin check on the WebSocket

Browsers always send an `Origin` header naming the page that opened a WebSocket, and a page cannot fake it. The upgrade is refused unless the path is `/ws` and the Origin is `http://127.0.0.1:<port>` or `http://localhost:<port>` (plus the Vite development server's origins in development mode). So only Masthead's own page can open the socket, and the socket is where everything powerful happens.

### 4. The local secret

The Host and Origin checks stop web pages, not programs: a local program can send any headers it likes. So the socket and the shutdown endpoint also need a **secret** that only the person's own user account can read, and the launcher only sends that secret to a server that proves it knows it already.

- **Where it lives.** `<DATA_DIR>/secret`, by default `~/.local/share/masthead/secret` (`SECRET_FILE` in `server/config.ts`). `loadSecret()` creates it once, when it is missing: 32 random bytes written as 64 hex characters, mode `0600`, in a folder created with mode `0700`. The file is written to a temporary name and hard-linked into place, so a launcher and a server starting at the same moment end up with the same secret. An existing file that does not hold 64 hex characters is replaced; one with looser permissions is set back to `0600`. The secret is kept across restarts, so a signed-in browser stays signed in.
- **The server** (`masthead serve`) loads it at start-up (`secretOrExit()` in `server/main.ts`; it exits with code 1 if the file can be neither read nor created) and passes it to `serve()`. Comparisons use `timingSafeEqual` (`secretOk()` in `server/http.ts`).
- **Signing a browser in.** `masthead` (the `open` command) signs the browser in with `http://127.0.0.1:<port>/#key=<secret>` (`signInUrl()` in `server/cli.ts`). The key is in the URL fragment, which the browser never sends to the server, so it is not in a request, a server log or a `Referer` header. The key is never put on a command line either. `openSignedIn()` writes a small HTML file, `sign-in-<random>.html`, that sends the browser on to that address, and gives `xdg-open` (or `gio open`) only the file's path. See [Sign-in file](#sign-in-file) below. The page (`takeKey()` in `web/src/lib/store.svelte.ts`) reads `#key=` (and still accepts `?key=` from older launchers), saves the key in `localStorage` under `masthead.key`, which is per origin, and removes it from the address bar with `history.replaceState`, so it is not left in the address bar or in bookmarks (see the history caveat below). If storage is refused (private browsing), the key works for that page load only. A tab opened without a key and with none stored shows a signed-out screen asking the person to open Masthead with `masthead`.
- **The socket.** The page opens `/ws` offering two subprotocols: `masthead` and `key.<secret>`. The upgrade is refused with `403` unless the `key.` subprotocol carries the secret (`offeredKey()`). The server's answer names only `masthead` (`handleProtocols`), so the key is never echoed back.
- **Proof.** Before `masthead` (the `open` command) opens the sign-in file, and before `masthead stop` sends `x-masthead-key`, the launcher asks the server on the port to prove it knows the secret (`serverProves()` in `server/cli.ts`). It picks a fresh nonce, 32 random bytes as 64 lowercase hex characters, and sends `GET /api/proof?nonce=<nonce>`. The server answers `{"name":"masthead","proof":…}` (with `cache-control: no-store`), where the proof is HMAC-SHA256, keyed with the secret, over `masthead-proof\n<port>\n<nonce>` (`proofOf()` in `server/config.ts`); `<port>` is the port the server actually bound. The launcher computes the same value and compares in constant time (`proofOk()`). Asking needs no secret, and the answer reveals nothing about it. A nonce that is not 64 lowercase hex characters gets `400`; any method but `GET` gets `405`. A server that gives no answer, a wrong proof, or no `/api/proof` at all (another program, or a Masthead older than this check) fails, and the launcher prints `Another Masthead (or another program) is using port N: it did not prove it knows <secret file>, so it was not sent the key. …` and exits 1 without sending the key or opening the browser. What this protects against:
  - **Port squatting.** Another user on the machine can start a program on Masthead's port while Masthead is not running. Without the secret file it cannot answer the proof, so it never receives the key (in a request header or through the browser).
  - **Relay from another port.** A program on port N could pass the launcher's nonce on to a real Masthead on another port and return its answer. That answer is the HMAC for the other port, so it fails the check for port N.

  The endpoint and the check are tested in `test/http.test.ts` and `test/launcher.test.ts`; the whole launcher flow against an impostor server was not verified by running.
- **Shutdown.** `POST /api/shutdown` needs the header `x-masthead: 1` **and** `x-masthead-key: <secret>`. A page on another site cannot add custom headers to a cross-site request without a CORS "preflight" check, and this server never answers one with permission (it sends no CORS headers, and `OPTIONS` gets `405`). `masthead stop` reads the secret file, checks the server's proof (above), and only then sends both headers. If there is no secret file, or the proof fails, it stops there with exit 1 and sends nothing.
- **What needs no secret.** The page itself (HTML, scripts, styles) holds no secret and is served to anyone who passes the Host check. `GET /api/health` returns only `name`, `version`, `pid` and `busy`, the number of conversations with agents working (`App.workingCount()`). Any local program, including one run by another user, can read those four values. `masthead status` and `install.sh` rely on them.

In development mode the server prints the Vite page's address with its key (`http://localhost:<dev port>/#key=…`) to its own terminal; that page keeps the key in its own origin's storage.

#### Sign-in file

`writeSignInFile()` in `server/cli.ts` (read from the code and covered by `test/launcher.test.ts`):

- **Folder.** `signInDir()`: `$XDG_RUNTIME_DIR/masthead` when `XDG_RUNTIME_DIR` is set and absolute (a per-user tmpfs), else `<DATA_DIR>/open`. It is created with mode `0700` and then set to `0700` with `chmod`, in case it already existed with looser rights.
- **File.** `sign-in-<12 random hex characters>.html`, mode `0600`, created with the `wx` flag, so an existing file of that name is never written through. It holds `<meta name="referrer" content="no-referrer">`, a `<meta http-equiv="refresh">` to the sign-in address and a plain "Open Masthead" link, in case the refresh does not run. The address is HTML-escaped.
- **Removal.** After the opener exits with code 0, or is still running after 3 seconds (`OPENER_WAIT_MS`; some openers run the browser in the foreground), the launcher starts `sh -c 'sleep 60; rm -f -- "$1"'` in the background with the file's path. Each run also removes `sign-in-*` files older than two minutes (`SIGN_IN_STALE_MS`), in case that never ran. If the opener fails, the file is removed at once.
- **Fallback.** If there is no `xdg-open` or `gio`, the file cannot be written, or the opener fails, no file is left. The sign-in address is printed instead, but only when standard output is a terminal; otherwise the launcher prints only ``Could not open the browser. Run `masthead --no-browser` in a terminal to get the sign-in address.``, so the key never lands in a log. In a terminal the launcher always ends with `If the browser did not open signed in, run: masthead --no-browser`.
- **Browsers in a sandbox.** A snap or flatpak browser may be unable to read a file in `$XDG_RUNTIME_DIR` or `~/.local/share`. Then run `masthead --no-browser` in a terminal and paste the printed address into the browser.
- Whether a real browser follows the meta refresh from a `file://` page was not verified by running.

### 5. Headers on the page itself

`serveStatic()` sends with each file it serves:

- `Content-Security-Policy`: scripts, styles and connections only from the server itself (`default-src 'self'`), inline styles allowed, images also from `data:` and `blob:`, WebSockets only to `ws://127.0.0.1:*` or `ws://localhost:*`, and `frame-ancestors 'none'` so no other site can embed the page in a frame.
- The rest of the policy: `base-uri 'none'` and `form-action 'none'`.
- `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The referrer policy also keeps a `?key=` from an older launcher from being sent to any other site; a `#key=` fragment is never sent in a `Referer` anyway.
- `Cache-Control`: `no-cache` for the page, `public, max-age=31536000, immutable` for the hashed files under `/assets/`. API replies carry `no-store`.

Static paths are URL-decoded and normalised (`serveStatic()`). A malformed escape or a NUL byte gets `400`. A path that does not stay inside the web folder gets `403`; the check compares against the folder name plus a path separator, so a sibling folder whose name starts the same way does not count as inside. A missing file under `/assets/`, or any path with a file extension, gets `404`. Any other path gets `index.html`, because the page handles its own routes. A file that vanishes between the check and the read gets `404`, never a crash. Only `GET` and `HEAD` are served; other methods get `405`. Paths such as `/%2e%2e/…` and a sibling folder sharing the root's prefix are tested in `test/http.test.ts`.

Each socket is pinged every 30 seconds. One that did not answer the previous ping is closed (`attach()`), and a closed socket stops nothing: agents keep working.

### 6. Rendering agent output in the page

Agent text is Markdown written by a model, and could contain HTML. The page turns it into HTML with `marked`, whose `html` hook escapes any raw HTML the agent wrote, and then cleans the result with **DOMPurify**, a library that removes scripts and other dangerous markup (`renderMarkdown()` in `web/src/lib/markdown.ts`). It also forbids `style`, `form`, `input` and `iframe` tags and `style`, `id` and `name` attributes, keeps only the classes Masthead's own renderer and highlight.js produce, and makes links open in a new tab with `rel="noopener noreferrer"`. So agent text cannot restyle the page, for example to draw a fake "Allow" button. Other text (the person's own messages, tool input and output, notices) is inserted as plain text by Svelte. See [Rendering Markdown safely](Source-Web-Front-End.md#rendering-markdown-safely-markdownts).

### 7. Input checks

- Every socket message is parsed as JSON in `attach()`; one that is not JSON gets "Malformed message.". `App.handle()` wraps `dispatch()` so that any thrown error becomes an `error` reply, carrying the `ref` of a refused `send` (clipped to 80 characters), never a crash. Unknown types get "Unknown request."; unknown conversation or agent ids get "no longer exists".
- **Messages** (`send`): text up to 400,000 characters (`MAX_TEXT`), not empty unless it has images. Images: at most 8 (`MAX_IMAGES`), media type PNG, JPEG, GIF or WebP, data only base64 characters (`checkImages()`). Each image may be at most 5 MiB (`MAX_IMAGE_BYTES`) and all images in a message together at most 30 MiB (`MAX_TOTAL_IMAGE_BYTES`), counted as decoded bytes from the base64 length less its `=` padding; otherwise "An image is larger than 5 MB." or "The images together are larger than 30 MB.". These match the page's composer (`web/src/lib/Composer.svelte`). The whole socket message is limited to 48 MiB (`MAX_WS_PAYLOAD` in `server/http.ts`).
- **Folders.** A new conversation's folder must exist and be a directory (`checkDir()`, with `~` expanded). The folder picker (`listDirs()`) lists non-hidden folders and symlinks to folders inside any path the server can read.
- **Settings** (`{t:'settings'}`) are merged over the current settings by `sanitizeSettings(raw, current)` in `server/config.ts`. A field that is missing or invalid keeps its current value, so a partial update changes only what it names. Model ids must match `^[A-Za-z0-9._\-\[\]:]{1,80}$`. Effort must be one of the four levels (no `max`). Limits are clamped to 0..12. The permission mode must be one of the five choices. Booleans must be booleans. `defaultCwd` must start with `/`.
- **Rename**: whitespace collapsed, at most 120 characters; an empty title is ignored.
- Ids used in file paths must match `^[A-Za-z0-9_-]{1,64}$` (`assertId()` in `server/store.ts`), so a conversation or agent id cannot lead out of the data folder.

### 8. Files on disk

| What | Where | Mode |
|---|---|---|
| Settings | `$XDG_CONFIG_HOME/masthead/settings.json` (default `~/.config/masthead/`) | `0600`; folder created `0700`. Written by `writeFileAtomic()`: a temporary file then a rename, so a crash never leaves half a file. |
| Secret | `$XDG_DATA_HOME/masthead/secret` (default `~/.local/share/masthead/`) | `0600`, reset to `0600` if looser; folder `0700` (`loadSecret()`) |
| Conversations | `…/masthead/conversations/<id>/conversation.json` | `0600` via `writeFileAtomic()`; folders `0700` (`Store`) |
| Transcripts | `…/conversations/<id>/items/<agent>.jsonl` | `0600` when created (`Store.appendItem()`) |

Folder modes apply only when Masthead creates the folder. A folder that already exists keeps its mode. Failed writes (a full disk, say) are logged once and never stop the server (`App.safely()`).

### 9. Development mode

With `MASTHEAD_DEV=1`, `runServer()` adds `http://localhost:<dev port>` and `http://127.0.0.1:<dev port>` to the allowed origins and their hosts to the Host list. The dev port is `MASTHEAD_DEV_WEB_PORT` (`parseDevWebPort()` in `server/cli.ts`), 7718 by default; an invalid value stops the server with exit 2. Nothing else is relaxed: the secret is still required. At start-up the server prints the Vite page's address with `#key=` to its own terminal only. `vite.config.ts` serves the page on the same port (`strictPort`, so it fails rather than move to another port) and forwards `/ws` and `/api` to `MASTHEAD_PORT`, 7717 by default. See [Building, testing and installing](Building-Testing-Installing.md) for running beside the installed service.

## What it does not defend against

- **Programs running as the person.** Any program running under the person's own account can read the secret file, so it can open the socket and drive agents. `README.md` says so: such a program could run `claude` itself anyway. Other user accounts on the machine cannot read the file (mode `0600`) and are refused.
- **Other users on the machine** cannot read the secret file or the data and settings files (modes above), so they cannot open the socket or stop the server. They can still connect to the port, read `/api/health`, ask `/api/proof` (whose answer is useless without the secret), load the page, and run a server of their own on another port, or on Masthead's port while Masthead is not running. Such a server fails the proof, so `masthead` and `masthead stop` never send it the key; it can still answer `/api/health` as `masthead`, so `masthead status` may report it as running.
- **Browser history.** The browser may record the sign-in file's `file://` path and then the `http://…/#key=…` address in its history before the page removes the key from the address bar (not verified). The key is also printed to the terminal in development mode, with `--no-browser`, and when the browser could not be opened (in both cases only when standard output is a terminal).
- **A leaked key.** Whoever has the key can connect for as long as the secret file is unchanged. Nothing rotates it; deleting `<DATA_DIR>/secret` and restarting the server makes a new one, and every browser then has to be signed in again with `masthead`. (This follows from `loadSecret()`; not verified by running.)
- **What the agents do.** Agents run with the person's permissions and the chosen permission mode. With `bypassPermissions`, Claude Code does not ask before acting. See [Permissions and questions](Permissions-and-Questions.md).
- **The folder picker** (`{t:'dirs'}`) lists the names of non-hidden folders anywhere the server process can read, for anyone who holds the socket.
- **A flood from a socket holder.** There is no rate limit on socket messages; each may be up to 48 MiB.
- **`/api/health` is open by design.** Anyone who can reach the port can read `name`, `version`, `pid` and `busy`. It proves nothing: the launcher relies on `/api/proof`, not on `health`, before sending the key.
- **Malformed requests.** A request line whose target cannot be parsed gets `400`, on plain requests and on socket upgrades, and any other unexpected error while answering a request is logged and answered `500`; one bad request no longer stops the server (tested in `test/http.test.ts`).
- **Plain HTTP on loopback.** Traffic is not encrypted. That is normal for `127.0.0.1`, but anything able to capture loopback traffic (root) sees the key.

## Agents and authority

Text from other agents arrives wrapped in `<agent-report>` or `<agent-message>` tags, and the system prompt tells each agent to treat it as information from a colleague that never carries the person's authority or approval (`server/prompts.ts`). This is instruction to the model, not something code can enforce.

Masthead does not touch credentials. `agentEnv()` (`server/config.ts`) passes the person's environment to Claude Code, including credential variables such as `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, and removes only variables an enclosing Claude Code session sets about itself.

## Related pages

[Safety model](Safety-Model.md) · [server/http.ts](Source-Http.md) · [server/cli.ts](Source-Cli.md) · [Command-line launcher](Command-Line-Launcher.md) · [Configuration and settings](Configuration-and-Settings.md) · [Storage on disk](Storage-on-Disk.md)
