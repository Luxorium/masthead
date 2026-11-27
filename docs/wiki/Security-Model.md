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

### 4. The shutdown endpoint needs a custom header

`POST /api/shutdown` also requires the header `x-masthead: 1`. A page on another site cannot add a custom header to a cross-site request without a CORS "preflight" check, and this server never answers one with permission (it sends no CORS headers, and `OPTIONS` gets `405`). The command-line launcher sends the header when you run `masthead stop`.

`GET /api/health` returns only the name, version and process id.

### 5. Headers on the page itself

`serveStatic()` sends with each file:

- `Content-Security-Policy`: scripts, styles and connections only from the server itself (`default-src 'self'`), inline styles allowed, images also from `data:` and `blob:`, WebSockets only to `ws://127.0.0.1:*` or `ws://localhost:*`, and `frame-ancestors 'none'` so no other site can embed the page in a frame.
- `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

Static paths are URL-decoded, normalised and joined to the web folder, and anything outside it gets `403`.

### 6. Rendering agent output in the page

Agent text is Markdown written by a model, and could contain HTML. The page turns it into HTML with `marked` and then cleans it with **DOMPurify**, a library that removes scripts and other dangerous markup (`renderMarkdown()` in `web/src/lib/markdown.ts`). It also forbids `style`, `form`, `input` and `iframe` tags and makes links open in a new tab with `rel="noopener noreferrer"`. Other text (the person's own messages, tool input and output, notices) is inserted as plain text by Svelte. See [Web front end](Source-Web-Front-End.md).

### 7. Input checks

- Every browser message is checked by `App.dispatch()`: unknown types and bad ids produce an `error` reply, not a crash.
- Settings from the browser go through `sanitizeSettings()`: model ids must match a strict character pattern, numbers are clamped, unknown values fall back to defaults, `defaultCwd` must be an absolute path.
- Images must be one of four types and valid base64 characters; at most 8 per message; text at most 400,000 characters.
- Ids used in file paths must match a safe pattern (`assertId` in `server/store.ts`).

## What it does not defend against

- **Other programs and users on the same machine (known limitation, deliberate for 0.1.0).** There is no local authentication beyond the Host and Origin checks: no password or token. A program running locally is not a browser and can send any `Host` and `Origin` headers it likes, so it can open the WebSocket and drive agents. `README.md` states this plainly: any program running as you can reach it, as it could run `claude` itself. On a shared machine it would also mean other local users can reach the server.
- **What the agents do.** Agents run with the person's permissions and the chosen permission mode. With `bypassPermissions`, Claude Code does not ask before acting. See [Permissions and questions](Permissions-and-Questions.md).
- **The folder picker** (`{t:'dirs'}`) lists the names of non-hidden folders anywhere the server process can read, for anyone who holds the socket.

## Agents and authority

Text from other agents arrives wrapped in `<agent-report>` or `<agent-message>` tags, and the system prompt tells each agent to treat it as information from a colleague that never carries the person's authority or approval (`server/prompts.ts`). This is instruction to the model, not something code can enforce.

Masthead does not touch credentials. `agentEnv()` (`server/config.ts`) passes the person's environment to Claude Code, including credential variables such as `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, and removes only variables an enclosing Claude Code session sets about itself.

## Related pages

[server/http.ts](Source-Http.md) · [Command-line launcher](Command-Line-Launcher.md) · [Configuration and settings](Configuration-and-Settings.md)
