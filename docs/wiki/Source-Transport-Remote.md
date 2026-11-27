# server/transport/remote.ts

**Role:** the private listener that only the person's own `tailscale serve` reaches. Where the platform has Unix sockets it is a socket in a private folder. On Windows, where Tailscale cannot serve a Unix socket, it is a loopback port; the file comment says the device token is then the only protection against another local program that forges the forwarded address. The listener serves the page, the device pairing endpoints, the picture routes and the device WebSocket. The file comment's rule: everything here assumes a request came through `tailscaled`, and checks it again anyway.

Deciding who a request is (Tailscale `whois`, tailnet and tag policy, device tokens) is `authorise()` in `server/remote/authorise.ts`. The on/off switch, the `serve` entry and the device registry are `RemoteAccess` in `server/remote/access.ts`. This page covers only the transport. The person's view is on [Remote access](Remote-Access.md); the reasons are on [Security model](Security-Model.md#the-remote-listener).

> Checked against the 0.2.0 source on branch `next`. Behaviour described here is read from the code, not run. `test/remote-wiring.test.ts` covers parts of it; the tests were not run for this page.

## Constants

| Name | Value | Purpose |
|---|---|---|
| `MAX_BODY` | 4096 bytes | Largest request body `readBody()` accepts (the poll request). |
| `MAX_WS_PAYLOAD` | 48 MiB | Largest single socket message, as on the local listener. |
| `DEVICE_PREFIX` | `device.` | A device offers its token as the subprotocol `device.<token>`. |
| `REQUESTS_PER_MINUTE` | 10 | Pairing requests allowed per forwarded address per minute. |

## remoteCsp(origin)

The Content-Security-Policy for pages served on this listener. It is the local one with `connect-src 'self' <wss origin>`, where the origin's `https:` is turned into `wss:`. The page may therefore open a socket only to the tailnet name it was loaded from. It is passed to [`serveStatic()`](Source-Http.md#servestaticroot-pathname-req-res-csp--csp).

## Private helpers

- `offeredToken(req)`: like `offeredKey()` in [http.ts](Source-Http.md#offeredkeyreq), but returns what follows `device.` in the first matching `Sec-WebSocket-Protocol` entry.
- `json(res, status, body)`: a JSON reply with `cache-control: no-store` and `x-content-type-options: nosniff`. Every API answer and error on this listener goes through it, in the `{code, message}` shape for errors.
- `readBody(req)`: collects the body as UTF-8. Past 4096 bytes it rejects with "too large" and destroys the request.

## RemoteServer

What `serveRemote()` returns:

- `close()`: ends everything (see [Lifecycle](#close)).
- `disconnect(nodeId?)`: ends the sockets of one device, or of every device.
- `setRole(nodeId, role)`: changes the role of a device's open sockets at once.
- `port`: the loopback port when the target is a port (tests ask for 0); undefined for a socket.

## serveRemote(app, access, opts)

Starts the listener. `opts` is `{webDir, blobs?, convExists?, now?}`; `now` lets tests move the clock for the rate limit.

It throws "Tailscale has no name for this computer." when `access.status` has no `dnsName`. Otherwise:

- `expectedHost` is `<dnsName>:<access.port>`. That is the tailnet name and the HTTPS port `serve` listens on (default 7443 in `server/remote/access.ts`), not the local target. The doc comment calls it the only name a browser on the tailnet uses to reach Masthead.
- `origin` is `https://<expectedHost>`, and `csp` is `remoteCsp(origin)`.
- It keeps its own `BlobTokens` (separate from the local listener's), a `sockets` map from device `nodeId` to its open `{ws, client}` entries, and a `recent` map from address to pairing-request times.
- `deps()` builds `authorise()`'s dependencies fresh on each call: `access.tailscale`, `access.registry`, our tailnet id and our own node id from `access.status`.

### fromServe(req)

The checks every request and upgrade must pass, meaning it came through `tailscale serve` for our name:

- `X-Forwarded-Host` equals `expectedHost`;
- `Host` equals `expectedHost`. For a socket target `localhost` is also accepted, because, as the comment says, `serve` keeps the tailnet name as Host for a port target but sends `localhost` to a socket target;
- `X-Forwarded-For` is present as a single string.

### decide(req, token?)

Calls `authorise({via: 'remote', forwardedFor, token}, deps())`. The answer is one of `remote` (an approved device, with its role), `unknown` (a tailnet identity with no valid token yet), or `refused` (with a reason). `authorise()` looks the address up with Tailscale `whois`. It refuses this machine's own node (that must use the local address) and anything the tailnet and tag policy rules out.

### Requests (`handle`)

In order:

1. Remote access switched off (`!access.enabled`): `503` with "Remote access is switched off on that computer." This is checked on every request, so it applies at once even before the listener closes.
2. `fromServe()` fails: `403 Forbidden`.
3. `/api/health`: `200 {name: 'masthead'}`, with no version, pid or busy count, unlike the local one.
4. `/api/shutdown`: always `404`. A device can never stop the server.
5. The device endpoints, below.
6. Picture routes, below.
7. Anything not `GET` or `HEAD`: `405`. Otherwise `serveStatic()` with the remote `csp`. The page holds no secret and is served to any request that passed `fromServe()`, without a `whois`.

`handle` is async. Any rejection is answered `500 {code: 'invalid', message: 'Something went wrong.'}` if headers were not yet sent.

### The remote endpoints

- **`/api/remote/whoami`** (any method): what an unapproved device's page asks first. A token may be sent in the `X-Masthead-Device` header. If a token was sent and refused (revoked, expired), it asks again without the token, and if that says `unknown` the device may simply ask again for approval. Answers (all `200` except the last):
  - `{state: 'refused', reason}`;
  - `{state: 'unknown', device: {name, os, user}}`, with `user` being the Tailscale login;
  - `{state: 'approved', role, device: {name}}`;
  - anything else (`local`, which `authorise()` never gives for `via: 'remote'`): `403`.
- **`POST /api/remote/request`**: asks for approval. It needs `decide()` to say `unknown`; otherwise `403` with the refusal reason, or "Forbidden" for an already approved device. Then the rate limit: the address is the first entry of `X-Forwarded-For`. Entries in `recent` whose times are all older than 60 s are dropped, and if this address already has 10 requests within the last 60 s the answer is `429` "Too many requests; wait a minute." Otherwise the time is recorded and `access.registry.request(identity, addr)` is called. A refusal there (its text) gives `403`. On success `access.changed()` tells the app (local tabs see the new request) and the answer is `{requestId, pollSecret, code}`. `code` is the request's six-digit pairing code (from `server/remote/registry.ts`).
- **`POST /api/remote/request/<24 hex>`**: the device polls for the decision. `decide()` must say `unknown` or `remote`, else `403`. The body must be JSON with `pollSecret`; unparsable or too large gives `400`. It returns whatever `access.registry.collect(requestId, pollSecret, nodeId)` returns, as `200`. When that state is `allowed`, it also calls `access.changed()`. `collect` returns `{state: 'gone'}` for an unknown request, another node or a wrong poll secret; `{state: 'pending'}` until the person decides; and `{state: 'allowed', token, role}` once allowed, which gives the device its token.

### Picture routes for devices

Only when `opts.blobs` is set and the path is `/blob` or starts with `/blob/`:

- **Fetching** goes to `handleBlobGet()` with this listener's tokens. It needs only the socket's blob token in `?t=`, which the device received in its `state`.
- **Uploading** goes to `handleBlobPost()`. `authorised` is true only when the request is a `POST` with an `X-Masthead-Device` token and `decide()` says `remote` with role `full`. Devices with the `approve` or `read` role cannot upload.

### The device socket (`upgrade`)

`refuse()` writes `HTTP/1.1 403 Forbidden` with `Connection: close` and destroys the socket. The upgrade is refused when remote access is off, the path is not `/ws`, `fromServe()` fails, or `Origin` is not exactly `origin`. Otherwise `decide(req, offeredToken(req))` runs. Only a `remote` decision is accepted; anything else, or an error, is refused. For an accepted device it:

1. writes a `connect` entry to the registry's audit log (node id, name, user, address);
2. completes the upgrade (`WebSocketServer` with `noServer`, 48 MiB `maxPayload`, answering only the `masthead` subprotocol, so the token is never echoed);
3. calls [`attach()`](Source-Http.md#attachapp-ws-tokens-remote) with `{role, onClient}`. The client therefore carries the device's role, which the [Hub's gate](Source-Clients.md#admitclient-msg-the-gate) enforces on every message. `onClient` sets `client.deviceId` to the device's node id (App's `forget_me` uses it) and adds `{ws, client}` to the device's set in `sockets`, and removes it when the socket closes.

The connection rate is not limited here; only pairing requests are.

### Listening

For a socket target it first calls `privateFolder()` on the socket's folder and removes a socket file left by a previous run. Then it listens on the socket path, or on `127.0.0.1:<port>` for a loopback target. A listen error rejects. A socket file is then `chmod`ed to `0600`.

### disconnect(nodeId?) and setRole(nodeId, role)

- `disconnect` closes the matching sockets with code `4001` and reason "Access was withdrawn.".
- `setRole` sets `client.role` on each open client of that device. The next message from it passes the gate with the new role. The role is not re-sent to the page.

### close()

Terminates every device socket, calls `server.closeAllConnections()` (where Node has it), closes the server, removes the socket file for a socket target, and then resolves.

## chooseTarget(env, dataDir, platform?, uid?)

Where `tailscale serve` should point on this platform. `server/main.ts` calls it once when building `RemoteAccess`.

- **Windows:** `{kind: 'loopback', port: 7719}`. The comment says any local program can reach it, and the pairing code is the only guard there; the settings say so to the person.
- **Elsewhere:** a Unix socket. A socket path may be at most about 104 bytes (macOS) or 108 (Linux). So if `XDG_RUNTIME_DIR` is set, absolute, and `<runtime>/masthead/remote.sock` is under 100 bytes, that path is used. Otherwise it is `/tmp/masthead-<uid>/remote.sock`, so Unix never needs a port.
- `dataDir` is accepted but unused (`void dataDir`).

Covered by "remote: targets per platform".

## privateFolder(dir, uid?)

Makes the socket's folder ours and private. It creates the folder with mode `0700`, then `lstat`s it. In a shared place such as `/tmp` someone else could have made it first, or put a symbolic link by that name, so it throws "`<dir>` is not a private folder of this user; remove it and try again." when the path is not a directory, is a link, or (when the uid is known) belongs to another user. Then it `chmod`s it to `0700`. Covered by "remote: the socket folder must be a private folder of this user, not a symlink or someone else's".

## startRemote(app, access, opts)

Keeps the listener in step with the switch, as `server/main.ts` uses it: open while remote access is on, closed while it is off.

- `sync()` queues a step on a promise chain (`busy`), so opening and closing never overlap. If access is on, no server is open, and Tailscale has a name, it calls `serveRemote()`; a failure is logged as "Masthead could not open its remote listener: …" and nothing is open. If access is off and a server is open, it closes it.
- It subscribes `sync` to `access.onChange()`.
- It subscribes to `access.onDevice()`. A `revoked` change calls `disconnect(nodeId)`; a role change calls `setRole(nodeId, role)`.
- It runs `access.reconcile()` once (a failure is logged as "Masthead could not read Tailscale's state: …"), then `sync()`, and waits for it.
- It returns `{stop()}`, which unsubscribes both, waits for the queue, and closes any open server.

A change of the tailnet name or port while the listener is open does not reopen it, since `sync()` only looks at on/off and whether a server exists (read from the code, not run). The settings refuse a port change while access is on ("remote: port and policy settings; a port cannot change while on").

## Related pages

[Remote access](Remote-Access.md) · [Security model](Security-Model.md#the-remote-listener) · [server/transport/http.ts](Source-Http.md) · [server/transport/auth.ts](Source-Transport-Auth.md) · [server/app/clients.ts](Source-Clients.md) · [server/app/app.ts](Source-App.md) · [Browser/server protocol](Browser-Server-Protocol.md)
