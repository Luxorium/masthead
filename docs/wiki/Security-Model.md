# Security model

Masthead can run commands and change files as you, because the agents it starts can. So anyone who can
drive Masthead can act as you. This page explains who can reach it and what they need, and then what
it does not protect against. How the agents themselves are kept in hand is on
[Safety model](Safety-Model.md); use from other devices is on [Remote access](Remote-Access.md).

Everything here was read from the code of 0.2.0 (branch `next`). The HTTP checks are covered by unit
tests (see [Tests](Source-Tests.md)). Remote access has been checked on a real tailnet (a Linux computer running Masthead, an Android phone and
a Windows device); its unit tests use a fake Tailscale. Setting it up: [Using Masthead from your phone](Using-Masthead-From-Your-Phone.md).

## In short: how Masthead stays safe

- **Loopback plus a secret.** The local listener is on `127.0.0.1` only. A page or socket that drives
  it must present the 64-hex local secret from a `0600` file in your data folder. Host and Origin
  checks stop other websites from using it.
- **Remote access only through Tailscale, to a private socket.** While remote access is on, a second
  listener runs on a Unix socket (mode `0600`) in a folder that must belong to you and must not be a
  link (`$XDG_RUNTIME_DIR/masthead/`, else `/tmp/masthead-<uid>/`). Only `tailscale serve` forwards to
  it, and it is never published through Funnel.
- **Why root is needed once.** Tailscale lets only root serve a Unix socket. An operator is enough
  only if `sudo` works without a password. So on Linux and macOS the settings show the exact command,
  `sudo tailscale serve --bg --https=<port> unix:<socket>`, which you run once with your password.
  After that, switching remote access on finds the entry and needs no root. Masthead adds and removes
  only its own entry (`server/remote/access.ts`, `server/remote/tailscale.ts`).
- **One socket per data folder.** The usual data folder uses `remote.sock`. Any other folder (a
  second instance or a test server) gets `remote-<10 hex>.sock`, made from a hash of its path. Such an
  instance sees the real serve entry as someone else's and never removes it
  (`chooseTarget()` in `server/transport/remote.ts`).
- **Test servers never call Tailscale.** With `MASTHEAD_TAILSCALE=off` or `MASTHEAD_BACKEND=fake`,
  `tailscaleFor()` returns `OffTailscale`, which never runs the binary and refuses every change.
- **Device pairing.** A device that asks gets a six-digit code. You approve it on this computer only
  after the same code shows on the device. The device then gets a token, which works only from that
  Tailscale node. Only the token's SHA-256 is stored, and the token expires after 30 days unused.
- **Roles.** Each device is `full`, `approve` or `read`, and the device list says what each role
  allows. Changing a role takes effect at once on the device's open connections, with no reconnect,
  so a downgrade applies to its very next message (`setRole()`). Removing a device or letting its
  approval expire closes its sockets with code `4001`, "Access was withdrawn." No role may manage
  devices or remote access, or shut the server down; those are local only (`allowedMessage()`).
- **What a remote device never receives.** The remote-access state (the device list, pending
  requests, audit log and settings) and the local-only messages (`Hub.publishLocal()`). It also never
  receives the local secret: a remote socket accepts only `device.<token>`, and its `/api/health`
  answers only the name. A device reads a conversation's details only while subscribed to it.
- **New devices start read-only.** Approving a pairing request without choosing a role gives `read`
  (the defaults of `RemoteAccess.decide()` in `server/remote/access.ts` and `DeviceRegistry.allow()`
  in `server/remote/registry.ts`, and `m.role ?? 'read'` in `server/app/app.ts`). The approval card preselects "Read only"; more must be chosen on purpose.
- **Switching the permission mode answers open approvals.** When the settings' permission mode
  changes, `App.autoAllowPending()` allows every open approval the new mode would not have asked
  for: all of them for `bypassPermissions`, file edits for `acceptEdits`. Questions are never
  answered this way. Changing settings needs the local page or a device with the `full` role.
- **Private scratch folders.** Each conversation has one temporary folder, shared by its agents and
  given to Claude Code agents as `TMPDIR` (and `CLAUDE_CODE_TMPDIR`; also `TMP`/`TEMP` on Windows), so their
  temporary files, downloads and browser profiles stay out of the shared `/tmp`. It is
  `<cache>/masthead/scratch/<conversation id>`: `~/.cache/masthead/scratch` on Linux
  (`$XDG_CACHE_HOME`), `~/Library/Caches/Masthead/scratch` on macOS,
  `%LOCALAPPDATA%\Masthead\Cache\scratch` on Windows (inside the data folder, so private by its
  `icacls` rule), or `<data folder>/scratch` when `MASTHEAD_DATA_DIR` is set. It is made with mode
  `0700` when an agent's session opens; the id must match `[A-Za-z0-9_-]{1,128}`, so it cannot point
  elsewhere. It is deleted with the conversation, and a sweep 10 s after start removes folders whose
  conversation is gone, or whose conversation was neither active nor changed inside the folder
  (looking up to 4 levels and 2000 entries deep, without following links; a bigger folder counts as
  just changed) for 7 days; never a busy conversation's (`server/service/scratch.ts`). Codex agents
  all share one `codex app-server`, so they get no `TMPDIR` of their own; they are told the folder,
  and it is added to the thread's writable roots while its sandbox is `workspaceWrite` (a read-only
  thread cannot write there). See [server/service](Source-Service.md#scratchts).
- **A resumed Codex chat never runs wider than its mode.** A Codex thread keeps the last sandbox
  it had, a turn's override included (full access after a turn in bypass), and resuming cannot change
  it (Codex 0.172). So after every resume the session works out the sandbox a new thread would get in
  its current mode: full access for bypass; a workspace-write sandbox with network off for `default`,
  `acceptEdits` and `auto`; for `inherit`, the person's own config, learned once per app-server and
  folder by a throwaway `ephemeral` `thread/start` with no turn (cached). If the thread reports
  something else, every turn carries the wanted sandbox. Under `inherit`, if that probe fails and the
  thread reports full access or nothing, the chat is not resumed (it fails closed). The probe thread
  stays loaded in the shared app-server until it ends. See
  [Codex backend](Source-Backend-Codex.md#sending-sendid-content).
- **Windows caveat.** Tailscale cannot serve a Unix socket on Windows, so the remote listener there
  is `127.0.0.1:7719`, which any local program can reach. Such a program still has no token and can
  only ask to pair. The code shown when it asks will not match your device, and the settings say this
  next to the switch.

## Two listeners

| Listener | Where | Who reaches it | Credential |
|---|---|---|---|
| **Local** | `127.0.0.1:<port>` (7717 by default), `serve()` in `server/transport/http.ts` | programs on this computer, including your browser | the local secret |
| **Remote** (only while Remote access is on) | a Unix socket in a private folder (Linux, macOS), or `127.0.0.1:7719` (Windows), `serveRemote()` in `server/transport/remote.ts` | Tailscale's `serve`, forwarding your tailnet devices; on Windows also any local program | a device token, plus the device's Tailscale identity |

Masthead never listens on another network interface and never uses Tailscale Funnel.

## The local listener

### Host and Origin

- **Host.** Every request and socket upgrade must name `127.0.0.1:<port>` or `localhost:<port>`
  (`hostOk()`), else `403`. This defeats DNS rebinding: an attacker's site can point its own name at
  127.0.0.1, but the browser still sends that name.
- **Origin.** The WebSocket upgrade must come from `http://127.0.0.1:<port>` or `http://localhost:<port>`.
  Only Masthead's own page can open it.
- In development (`MASTHEAD_DEV=1`) the Vite page's port (`MASTHEAD_DEV_WEB_PORT`, default 7718) is
  added to both lists. Nothing else is relaxed.

### The local secret

- **Where.** `<data folder>/secret`: `~/.local/share/masthead/secret` on Linux, `~/Library/Application
  Support/Masthead/secret` on macOS, `%LOCALAPPDATA%\Masthead\secret` on Windows (`server/paths.ts`).
- **How it is made.** `loadSecret()` in `server/transport/auth.ts` creates it once: 32 random bytes as
  64 hex characters, written to a temporary file and linked into place, so two processes starting
  together agree on it. It is kept across restarts.
- **Who can read it.** On Linux and macOS the file is mode `0600`. On Windows the data folder is made
  private first (`makeDirPrivate()`: `icacls /inheritance:r /grant:r *<SID>:(OI)(CI)F`, with your
  SID from `whoami /user`), so files made inside are private from the start; every `icacls` result is
  checked, and if it fails `loadSecret()` throws and Masthead does not start. `isPrivate()` reads the
  permissions back (also used by `masthead doctor`). On every platform a secret others could read is
  replaced, not merely tightened. Details: [Platforms](Platforms.md).
- **The socket.** The page offers the subprotocol `key.<secret>`; the upgrade is refused unless it
  matches (constant-time compare). The answer names only `masthead`, never the key.
- **Shutdown.** `POST /api/shutdown` needs `x-masthead: 1` and `x-masthead-key: <secret>`. A site
  elsewhere cannot add custom headers without a CORS preflight, which this server never grants.
- **Proof.** `GET /api/proof?nonce=<64 hex>` answers an HMAC of the nonce and port with the secret
  (`proofOf()`). The `masthead` command uses it (`serverProves()` in `server/cli.ts`) to check that the
  server on the port knows the secret *before* sending the secret anywhere. The answer reveals nothing.
- **Signing a browser in.** `masthead` writes a small page only you can read (in `$XDG_RUNTIME_DIR`
  or the data folder), opens that file, and deletes it a minute later. The page forwards to
  `http://127.0.0.1:<port>/#key=<secret>`. The key is in the fragment, which a browser never sends to
  a server or in a `Referer`. The page keeps it in `localStorage` for that address and removes it from
  the address bar. The key is never on a command line.
- **What needs no secret.** The page files, and `GET /api/health` (name, version, process id, and
  how many conversations are busy).

## The remote listener

Details and the pairing flow are on [Remote access](Remote-Access.md). In short:

- **Only through Tailscale `serve`.** Every request must carry `X-Forwarded-Host:
  <machine>.<tailnet>.ts.net:<port>`, an `X-Forwarded-For` address, and the Host `serve` sends
  (`localhost` to a socket, the tailnet name to a port) (`fromServe()`).
- **Identity from Tailscale, not from headers.** The forwarded address is looked up with `tailscale
  whois` (`authorise()` in `server/remote/authorise.ts`). The result names the device by its stable
  node id. Users of other tailnets and tagged devices are refused unless the person allows them.
- **A device token.** After the person approves a pairing request, the device gets a token. Only its
  SHA-256 is stored. The token works only from the node it was issued to, and expires after 30 days
  unused.
- **Origin.** The socket must come from `https://<machine>.<tailnet>.ts.net:<port>`, with the
  subprotocol `device.<token>`. The local secret is never accepted here.
- **No shutdown, little health.** `/api/shutdown` is `404`; `/api/health` answers only `{name}`.
- **Roles.** Every message a device sends passes one gate (`Hub.admit()` in `server/app/clients.ts`,
  using `allowedMessage()`): `full` may do everything the local page can except manage remote access
  and devices; `approve` may read, answer approvals, stop work, and answer or cancel tidying the team; `read` may only read, including archived helpers' chats. Restoring an archived helper and switching automatic tidying need `full`; see the table on [Remote access](Remote-Access.md#what-a-remote-device-can-and-cannot-do). A device must
  say hello with protocol 2 before anything, and reads a conversation's details only while subscribed.

## Page headers

- **Local page CSP:** `default-src 'self'`; images also from `data:` and `blob:`; inline styles;
  `connect-src 'self' ws://127.0.0.1:* ws://localhost:*`; `frame-ancestors 'none'`; `base-uri 'none'`;
  `form-action 'none'`.
- **Remote page CSP:** the same, with `connect-src 'self' wss://<machine>.<tailnet>.ts.net:<port>`
  (`remoteCsp()`).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` on every page file; hashed assets
  cached for a year, the page itself revalidated.
- Static paths are decoded and normalised; a NUL byte or malformed escape is `400`, anything outside
  the web folder `403`. A file that vanishes mid-read is `404`, never a crash.
- Agent-written text is rendered through `marked` (raw HTML escaped) and DOMPurify; see
  [Rendering Markdown safely](Source-Web-Front-End.md#rendering-markdown-safely-markdownts).

## Pictures (blobs)

- **Fetch:** `GET /blob/<conversation>/<sha256>?t=<blob token>`. The blob token is random per socket,
  sent in `state.blobToken`, and valid while that socket is open plus 60 s (`BlobTokens` in
  `server/transport/blobs.ts`, constant-time compare). Both parts of the path are checked against
  strict patterns and looked up only inside that conversation's `blobs/` folder.
- **Upload:** `POST /blob?conv=<id>` with the raw bytes and `x-masthead-key` (local) or
  `x-masthead-device` (a device with the `full` role).
- **What is accepted:** PNG, JPEG, GIF and WebP only, decided from the file's bytes, never SVG. At most
  5 MB each, 8192 pixels a side and 40 megapixels; 30 MB per message; 500 MB per conversation
  (`server/storage/blobs.ts`). A declared type that disagrees with the bytes is refused.
- **Served with:** the stored type as `Content-Type`, `nosniff`, `Content-Disposition: inline`, and its
  own CSP `default-src 'none'; …; sandbox`, so a picture opened on its own can run nothing.

## Input checks and error codes

- Every socket message is JSON; anything else is answered `{t:'error', code:'invalid'}`.
  `App.handle()` turns every refusal into an `error` message, never a crash.
- Version 2 errors carry a code. A version 1 (0.1.x) page gets the old shape without it.

| Code | Meaning |
|---|---|
| `protocol` | Wrong or missing protocol version (a device must say hello with protocol 2 first). |
| `refused` | Not allowed: the device's role, a conversation not subscribed to, a remote-access change Tailscale refused. |
| `not_found` | The conversation, agent, item, picture or team no longer exists here. |
| `too_large` | Over a limit: message length, image count or size. |
| `invalid` | Malformed or unknown request. |

- **Settings** are merged over the current ones and sanitised field by field
  ([Configuration and settings](Configuration-and-Settings.md)).
- **Folders** for a new conversation must exist. Ids used in file names must match strict patterns.

## Files on disk

| What | Where (Linux) | Protection |
|---|---|---|
| Settings | `~/.config/masthead/settings.json` | `0600`, folder `0700` |
| Secret | `~/.local/share/masthead/secret` | `0600` (Windows: `icacls`, current user only) |
| Conversations, transcripts, pictures | `~/.local/share/masthead/conversations/` | files `0600`, folders `0700` |
| Remote access (devices, audit, config) | `~/.local/share/masthead/remote/` | files `0600`, folder `0700` |
| Scratch folders | `~/.cache/masthead/scratch/<conversation id>/` | folders `0700` when Masthead creates them |
| Remote socket | `$XDG_RUNTIME_DIR/masthead/remote.sock`, else `/tmp/masthead-<uid>/remote.sock` (`remote-<hash>.sock` for a data folder other than the usual one) | socket `0600` in a `0700` folder that must be yours and not a link |

On Windows the data folder and the sign-in folder are set with `icacls` (private to your account,
inherited by every file inside, so conversations, pictures and remote-access files too); the settings
folder in `%APPDATA%` relies on Windows keeping your profile private by default. Folder
modes apply only when Masthead creates the folder.

## What other users of the computer can and cannot do

- **Linux and macOS.** They cannot read the secret, your data or the remote socket's folder, so they
  cannot drive Masthead or pretend to be a device. They can connect to the local port, read
  `/api/health`, and load the page.
- **Windows.** The same for the secret and your files. **But the remote listener is a local port,** so
  another program on the computer, including one run by another user account, can send requests that
  claim to come through Tailscale with any device's address. What still protects you: such a program
  has no device token, so it can only *ask* to pair; the person must approve, and the six-digit code on
  the approval card will not match the one on their real device. The settings say this in plain words
  next to the switch.

## What this does not protect against

- **Programs running as you.** Anything running under your own account can read the secret (and on
  Windows reach the remote port), so it can drive Masthead, as it could run `claude` itself.
- **An approved device that is lost or compromised.** With the `full` role it can do everything the
  local page can, including running commands through the agents. Remove it from the device list.
- **Approving the wrong device.** Nothing stops a careless approval; compare the code.
- **A leaked key or token.** A leaked secret works until the file is deleted and the server restarted
  (every browser then signs in again). A leaked device token works only from that same device, until
  it is removed or expires.
- **The browser's history.** The first address with `#key=` may be recorded before the page removes it
  (not verified).
- **No rate limit on the local socket**, and plain HTTP on loopback (anything able to capture loopback
  traffic, i.e. root, sees the key).
- **The folder picker** lists folder names anywhere the server can read, for anyone with the socket.

## Related pages

[Remote access](Remote-Access.md) · [Safety model](Safety-Model.md) · [server/transport/http.ts](Source-Http.md) · [server/transport/remote.ts](Source-Transport-Remote.md) · [server/transport/auth.ts](Source-Transport-Auth.md) · [Pictures](Source-Blobs.md) · [Browser/server protocol](Browser-Server-Protocol.md)
