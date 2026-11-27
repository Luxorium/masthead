# Security model

Masthead's server can run commands and edit files as the person, because the Claude Code agents it starts can. Anyone who can talk to the server can therefore act as the person. This page explains what the server does to limit who can reach it, and what it does not protect against. Code: `serve()` and `serveStatic()` in `server/http.ts`; input checks in `server/app.ts` and `server/store.ts`.

## What it defends against

The main threat considered in the code is **a web page on another site** trying to use the person's browser to reach the local server. Browsers let any page send requests to `127.0.0.1`, so local servers need their own checks.

### 1. Listening only on the loopback address

`server.listen(port, '127.0.0.1')`. Other machines on the network cannot connect.

### 2. The Host header check (DNS rebinding)

**DNS rebinding** is a trick where an attacker's domain name is made to point at `127.0.0.1`, so the attacker's page becomes "same origin" with the local server in the browser's eyes. The browser still sends the attacker's name in the `Host` header. Every HTTP request and the WebSocket upgrade must therefore carry `Host: 127.0.0.1:<port>` or `localhost:<port>`, or get `403 Forbidden` (`hostOk()`).

In development mode (`MASTHEAD_DEV=1`, see [server/main.ts](Source-Main.md)) the list also contains `localhost:7718` and `127.0.0.1:7718`, the Vite development server that forwards the page's requests. The check itself is never switched off. `AGENTS.md` makes this a rule for anyone changing the code: the server binds to `127.0.0.1` and checks `Host` and `Origin`, and neither may be weakened.

### 3. The Origin check on the WebSocket

Browsers always send an `Origin` header naming the page that opened a WebSocket, and a page cannot fake it. The upgrade is refused unless the path is `/ws` and the Origin is `http://127.0.0.1:<port>` or `http://localhost:<port>` (plus the Vite development server's origins in development mode). So only Masthead's own page can open the socket, and the socket is where everything powerful happens.

### 4. The local secret

The Host and Origin checks stop web pages, not programs: a local program can send any headers it likes. So the socket and the shutdown endpoint also need a **secret** that only the person's own user account can read.

- **Where it lives.** `<DATA_DIR>/secret`, by default `~/.local/share/masthead/secret` (`SECRET_FILE` in `server/config.ts`). `loadSecret()` creates it once, when it is missing: 32 random bytes written as 64 hex characters, mode `0600`, in a folder created with mode `0700`. The file is written to a temporary name and hard-linked into place, so a launcher and a server starting at the same moment end up with the same secret. An existing file that does not hold 64 hex characters is replaced; one with looser permissions is set back to `0600`. The secret is kept across restarts, so a signed-in browser stays signed in.
- **The server** (`masthead serve`) loads it at start-up (`secretOrExit()` in `server/main.ts`; it exits with code 1 if the file can be neither read nor created) and passes it to `serve()`. Comparisons use `timingSafeEqual` (`secretOk()` in `server/http.ts`).
- **Signing a browser in.** `masthead` (the `open` command) opens `http://127.0.0.1:<port>/?key=<secret>`. The page (`takeKey()` in `web/src/lib/store.svelte.ts`) saves the key in `localStorage` under `masthead.key`, which is per origin, and removes it from the address bar with `history.replaceState`, so it is not left in history or bookmarks. If storage is refused (private browsing), the key works for that page load only. A tab opened without a key and with none stored shows a signed-out screen asking the person to open Masthead with `masthead`.
- **The socket.** The page opens `/ws` offering two subprotocols: `masthead` and `key.<secret>`. The upgrade is refused with `403` unless the `key.` subprotocol carries the secret (`offeredKey()`). The server's answer names only `masthead` (`handleProtocols`), so the key is never echoed back.
- **Shutdown.** `POST /api/shutdown` needs the header `x-masthead: 1` **and** `x-masthead-key: <secret>`. A page on another site cannot add custom headers to a cross-site request without a CORS "preflight" check, and this server never answers one with permission (it sends no CORS headers, and `OPTIONS` gets `405`). `masthead stop` reads the secret file and sends both headers.
- **What needs no secret.** The page itself (HTML, scripts, styles) holds no secret and is served to anyone who passes the Host check. `GET /api/health` returns only the name, version, process id and `busy` (how many conversations have agents working).

In development mode the server prints the Vite page's address with its key (`http://localhost:7718/?key=…`); that page keeps the key in its own origin's storage.

### 5. Headers on the page itself

`serveStatic()` sends with each file:

- `Content-Security-Policy`: scripts, styles and connections only from the server itself (`default-src 'self'`), inline styles allowed, images also from `data:` and `blob:`, WebSockets only to `ws://127.0.0.1:*` or `ws://localhost:*`, and `frame-ancestors 'none'` so no other site can embed the page in a frame.
- `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The referrer policy also keeps a `?key=` in the address from being sent to any other site.

Static paths are URL-decoded and normalised; a path containing a NUL byte gets `400`, and a path that does not stay inside the web folder (the folder itself or something below it) gets `403`.

### 6. Rendering agent output in the page

Agent text is Markdown written by a model, and could contain HTML. The page turns it into HTML with `marked` and then cleans it with **DOMPurify**, a library that removes scripts and other dangerous markup (`renderMarkdown()` in `web/src/lib/markdown.ts`). It also forbids `style`, `form`, `input` and `iframe` tags and makes links open in a new tab with `rel="noopener noreferrer"`. Other text (the person's own messages, tool input and output, notices) is inserted as plain text by Svelte. See [Web front end](Source-Web-Front-End.md).

### 7. Input checks

- Every browser message is checked by `App.dispatch()`: unknown types and bad ids produce an `error` reply, not a crash.
- Settings from the browser go through `sanitizeSettings()`: model ids must match a strict character pattern, numbers are clamped, unknown values fall back to defaults, `defaultCwd` must be an absolute path.
- Images must be one of four types and valid base64 characters; at most 8 per message; text at most 400,000 characters.
- Ids used in file paths must match a safe pattern (`assertId` in `server/store.ts`).

## What it does not defend against

- **Programs running as the person.** Any program running under the person's own account can read the secret file, so it can open the socket and drive agents. `README.md` says so: such a program could run `claude` itself anyway. Other user accounts on the machine cannot read the file (mode `0600`) and are refused.
- **A leaked key.** Whoever has the key can connect for as long as the secret file is unchanged. Nothing rotates it; deleting `<DATA_DIR>/secret` and restarting the server makes a new one, and every browser then has to be signed in again with `masthead`. (This follows from `loadSecret()`; not verified by running.)
- **What the agents do.** Agents run with the person's permissions and the chosen permission mode. With `bypassPermissions`, Claude Code does not ask before acting. See [Permissions and questions](Permissions-and-Questions.md).
- **The folder picker** (`{t:'dirs'}`) lists the names of non-hidden folders anywhere the server process can read, for anyone who holds the socket.

## Agents and authority

Text from other agents arrives wrapped in `<agent-report>` or `<agent-message>` tags, and the system prompt tells each agent to treat it as information from a colleague that never carries the person's authority or approval (`server/prompts.ts`). This is instruction to the model, not something code can enforce.

Masthead does not touch credentials. `agentEnv()` (`server/config.ts`) passes the person's environment to Claude Code, including credential variables such as `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, and removes only variables an enclosing Claude Code session sets about itself.

## Related pages

[server/http.ts](Source-Http.md) · [Command-line launcher](Command-Line-Launcher.md) · [Configuration and settings](Configuration-and-Settings.md)
