# server/remote/registry.ts

**Role:** the devices allowed to use Masthead over the tailnet. It holds pending requests with pairing codes, approvals with roles, tokens bound to the Tailscale node, expiry, revocation and an audit log. It is pure logic plus a small versioned file: the transport calls it and never decides on its own. The feature is described on [Remote access](Remote-Access.md) and the threats on [Security model](Security-Model.md).

Remote access has been checked on a real tailnet (a Linux computer running Masthead, an Android phone and a Windows device); the unit tests use a fake Tailscale (`FakeTailscale`). The registry itself needs no Tailscale: its tests in `test/remote.test.ts` call it directly with made-up identities.

## Types and limits

- `Role` is `'full' | 'approve' | 'read'` (`ROLES`). `full` is everything the local browser can do except shut down; the message table is in `allowedMessage()` on [server/remote/access.ts and authorise.ts](Source-Remote-Access.md).
- `Device`: `nodeId`, `nodeName`, `os`, optional `user`, `address`, `role`, `tokenHash` (SHA-256 of the token in hex; the token itself is never stored), `createdAt`, `lastSeen`, `expiresAt`.
- `PendingRequest`: `id`, the node's details, `code` (six digits), `createdAt`, `pollHash` (hash of the secret the device polls with), and once decided `token`, `role` or `denied`.
- `AuditEntry`: `ts`, `event` (`request`, `allow`, `deny`, `revoke`, `expire`, `role`, `connect`, `refuse`, `collect`, `switch`, `forget`) and optional `nodeId`, `nodeName`, `user`, `address`, `detail`.
- `RegistryOptions`: `dir` (created `0700`), `now`, `tokenDays` (default 30), `allowOtherTailnets`, `allowTagged`, `loopback` and `onExpire`.

| Constant | Value |
|---|---|
| `FILE_VERSION` | 1 |
| `MAX_PENDING_PER_USER` | 3 waiting requests per tailnet user (all tagged nodes count as one user, `tagged`); doubled to 6 in loopback mode |
| `MAX_PENDING_PER_NODE_LOOPBACK` | 3 waiting requests per node in loopback mode (1 otherwise) |
| `MAX_PENDING` | 20 waiting requests in all |
| `PENDING_MS` | 10 minutes before a request is dropped |
| `DENY_COOLDOWN_MS` | 10 minutes |
| `REFUSE_LOG_MS` | 60 s |
| `AUDIT_MAX_BYTES` | 1 MB |
| `AUDIT_TAIL_BYTES` | 256 KB |

## `refusalFor(id, ourTailnet, opts)`

Why a device may not even ask, or `null`. A tagged node is refused unless `allowTagged`. A node whose `tailnetId` differs from ours is refused unless `allowOtherTailnets`. If either tailnet id is empty, the tailnet check is skipped. Tested by "other tailnets and tagged devices are refused unless allowed".

## Constructor, file and `sweep()`

`new DeviceRegistry(opts)` creates `dir` with mode `0700` (and `chmod`s it to `0700` if it already existed), then loads `devices.json`.

**File format.** `devices.json` is `{ "version": 1, "devices": [Device, …] }`. `save()` writes it to `devices.json.<pid>.tmp` with mode `0600` and renames it over the old file. `load()` approves nobody if the file is missing, unreadable, not version 1 or has no `devices` array, and skips any device without a string `nodeId`, a string `tokenHash` and a known role. Tested by "an unreadable or old-format devices file approves nobody" and "tokens last 30 days, are renewed on use, and survive a restart". Pending requests and deny cool-downs live only in memory and are lost on restart (read from the code, not run).

`save()` writes a temporary file and moves it into place with `renameRetry` from `server/storage/atomic.ts`, which retries briefly on Windows while another program holds the file.

**`sweep()`** runs at the start of `list()`, `requests()`, `request()` and `check()`. It drops devices whose `expiresAt` has passed, writing an `expire` audit line and calling `onExpire(nodeId)` for each, then saves once if anything changed. It drops pending requests older than 10 minutes. `RemoteAccess` passes an `onExpire` that tells the transport to close that device's open sockets, as a revoke does. Tested by "an approval that expires tells the transport, as revoke does" and "requests expire after ten minutes".

## Asking: `request(id, address)`

Returns `{ request, pollSecret }` or `{ refused }`. In order:

1. A node in its deny cool-down is refused (`This device was turned down recently…`) and a `refuse` line is logged.
2. Too many waiting requests from this node are refused: the limit is 1, or 3 in loopback mode. Approved requests the device has not yet collected count as waiting.
3. 20 pending requests in all are refused.
4. Too many from this tailnet user are refused: 3, or 6 in loopback mode.
5. Otherwise a new request gets a random id, a six-digit `code` from `randomInt` (zero-padded) and a 24-byte random poll secret. Only `sha256(pollSecret)` is kept. A `request` line is logged.

**Poll secrets are never rotated.** A second request from the same node does not return the first request's code or a new secret; it is refused. On a loopback listener another local user could forge this node's address, and that must not take over the first asker's request. A page that lost its secret waits for the request to expire. Tested by "a pending request gets a six-digit code; a second asker for the same node gets neither code nor secret" and "pending requests are capped per tailnet user".

**Loopback mode** (`opts.loopback`, set when the remote listener is a loopback port, on Windows): any local program can claim to be any device, so a node may have up to three waiting requests, each with its own code and poll secret, and the matching code on the device's screen is the guard. A denial in this mode locks out that request only: no cool-down is set for the node. Tested by "a forged first request cannot block the real device; deny locks out that request only".

## Deciding: `allow(requestId, role = 'read')` and `deny(requestId)`

- Without a role, `allow` gives the most limited one, `read` (0.2.1; it was `full`).
- `allow` returns `null` for an unknown, denied or already-allowed request, or an unknown role. Otherwise it makes a 32-byte random token (64 hex characters), stores a `Device` with `tokenHash`, `expiresAt = now + tokenMs` and the request's details, saves, keeps the token on the pending request until the device collects it, and logs `allow` with the role. A new approval of a node replaces any earlier approval and its token.
- `deny` returns `false` for an unknown or already-allowed request. Otherwise it removes the request, sets the node's 10-minute cool-down (not in loopback mode) and logs `deny`. Tested by "deny refuses the node for a while, then it may ask again".

## Collecting: `collect(requestId, pollSecret, nodeId)`

The waiting device polls with its secret. Returns `{state:'gone'}` if the request does not exist, belongs to another node, or the secret's hash does not match (compared with `timingSafeEqual` in `sameHash`). Returns `{state:'pending'}` until it is allowed. Once allowed, it returns `{state:'allowed', token, role}` **once**, deletes the request and logs `collect`. A denied request is deleted, so it reads as `gone`. Tested by "allow issues the token once, only to the node that asked, and only its hash is stored".

## Changing approvals: `revoke(nodeId)` and `setRole(nodeId, role)`

`revoke` deletes the device, saves and logs `revoke`; `false` if unknown. `setRole` changes the role (known roles only), saves and logs `role`. Neither closes sockets itself; `RemoteAccess` tells the transport. Tested by "revoke and role changes take effect at once; re-pairing replaces the old token".

## Checking a token: `check(nodeId, token, address)` and `ownerOf(token)`

- `check` sweeps, then returns the node's device only if the token is 64 lower-case hex characters and its hash matches that node's current `tokenHash` (constant-time). It sets `lastSeen` and `address`. **Renewal:** when more than an hour of the approval has been used, `expiresAt` moves to `now + tokenMs` and the file is saved, so a busy socket writes at most once an hour. An approval therefore runs out only after 30 days (by default) without use.
- `ownerOf` finds whichever device holds a token, whatever node offers it. `authorise()` uses it only to log a copied token.

## Policy

`setPolicy({allowOtherTailnets, allowTagged})` changes who may ask; `options` reads it back.

## Audit log: `audit(e)` and `readAudit(limit = 100)`

`audit` appends one JSON line with `ts` to `audit.jsonl` (mode `0600`). Before appending, a log larger than 1 MB is renamed to `audit.jsonl.1`, replacing any earlier one. Errors are swallowed, so a full disk never stops a decision. **Refusal rate limit:** a `refuse` line is written at most once a minute for each node (or address) and reason; the memory of this is cleared past 1000 keys.

`readAudit` reads only the last 256 KB of the file, drops the first line if it was cut, keeps the last `limit` lines and skips any that do not parse. Tested by "refusals are logged at most once a minute per node and reason; the log rotates and reads a tail" and "the audit log records each step, privately".

## Tests

`test/remote.test.ts`; all its tests passed when this page was written.

## Related pages

[Remote access](Remote-Access.md) · [Security model](Security-Model.md) · [server/remote/tailscale.ts](Source-Remote-Tailscale.md) · [server/remote/access.ts and authorise.ts](Source-Remote-Access.md) · [server/transport/remote.ts](Source-Transport-Remote.md)
