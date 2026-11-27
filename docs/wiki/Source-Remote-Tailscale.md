# server/remote/tailscale.ts

**Role:** the Tailscale side of remote access, behind one interface so the rest of Masthead can be tested with a fake. Masthead only ever adds and removes its own `tailscale serve` entry, on one HTTPS port it owns. It never runs `serve reset`, never touches another port and never uses Funnel. The feature as a whole is described on [Remote access](Remote-Access.md); the threats it guards against are on [Security model](Security-Model.md).

**What has been run:** remote access has only ever run against a fake Tailscale. The unit tests in `test/remote.test.ts` use `FakeTailscale`, and `CliTailscale` with a fake `Runner` that records the arguments instead of starting `tailscale`. No test, and nothing written for this page, has run the real `tailscale` command. Statements about what the real CLI prints or accepts are read from the code, not run.

## Types

- `Identity`: who is at the other end of a tailnet connection, from `tailscale whois`. `nodeId` (the node's stable id, which approvals are bound to), `nodeName`, `os`, `addresses`, `tagged`, an optional `user: { login, name }` (absent for tagged nodes) and `tailnetId` (differs from ours for a node shared from another tailnet).
- `TailnetStatus`: `running`, `dnsName` (this machine's MagicDNS name without the trailing dot), `tailnetId`, `selfNodeId`, and `https` (whether the tailnet can issue HTTPS certificates, which `serve --https` needs).
- `ServeState`: the state of Masthead's own entry on its port: `{kind:'off'}`, `{kind:'ours'}`, `{kind:'elsewhere', target}` (with a short description of what is there) or `{kind:'funnel'}`.
- `Runner`: `(args) => Promise<string>`. Runs the tailscale CLI and resolves with stdout. Tests replace it.

## The provider interface: `TailscaleProvider`

| Method | What it does |
|---|---|
| `status()` | The tailnet's status, or `null`. |
| `serveState(port, target)` | What is on `port` now. |
| `addServe(port, target)` | Adds Masthead's entry. Refuses if the port is in other use. |
| `removeServe(port, target)` | Removes Masthead's entry only. Refuses if the port serves something else. |
| `whois(address)` | The `Identity` behind an address, or `null`. |

There are three implementations: `CliTailscale` (the real one), `FakeTailscale` (tests) and `CachedWhois` (a wrapper). `server/main.ts` builds `new CliTailscale()` and hands it to `RemoteAccess`, which wraps it in `CachedWhois`.

## `runTailscale`

The default `Runner`. It calls `execFile('tailscale', args)` with a 15 second timeout and a 4 MB output buffer, so no shell is involved. On failure it rejects with the trimmed stderr, or the error message when stderr is empty. (Read from the code, not run.)

## `checkServePort(port)` and `checkServeTarget(target)`

- `checkServePort` throws unless the port is an integer from 1024 to 65535, and throws for 8443 and 10000, two of the ports Tailscale Funnel can use. It also refuses 7717, Masthead's own local port.
- `checkServeTarget` accepts only two shapes: `unix:/…` (an absolute socket path with no whitespace) or `http://127.0.0.1:` followed by a 4 or 5 digit port. Anything else throws `Masthead serves only its own socket or loopback port, not …`.

The test "commands refuse foreign targets, Funnel ports and bad ports" checks both.

## The only commands: `addCommand` and `removeCommand`

These two functions build every command that changes serve config. Both run the checks above first.

- `addCommand(port, target)` → `['serve', '--bg', '--https=<port>', <target>]`.
- `removeCommand(port)` → `['serve', '--https=<port>', 'off']`.

No other change command exists in the file. There is no `serve reset`, no `funnel` and no other port. The read-only commands `CliTailscale` runs are `status --json`, `serve status --json` and `whois --json <address>`. The tests "serve add and remove only ever name our own port and target" and "the CLI provider adds and removes its entry with exactly its own commands" check the exact argument lists.

## `serveStateFrom(json, dnsName, port, target)`

Reads Masthead's entry out of the parsed `tailscale serve status --json`. Only the layout Masthead understands counts as `off` or `ours`; anything else is treated as someone else's, so Masthead refuses rather than overwrites. In order:

1. Not an object, or an array → `elsewhere` ("an unrecognised serve configuration").
2. Any top-level key other than `Web`, `TCP` and `AllowFunnel` whose value is not `null`, `false` or an empty object → `elsewhere`, naming the keys. This is how a foreground session, services or a newer Tailscale layout are refused.
3. `AllowFunnel["<dnsName>:<port>"]` is true → `funnel`.
4. No `Web["<dnsName>:<port>"]` and no `TCP["<port>"]` → `off`.
5. A `Web` entry whose `Handlers` is not an object → `elsewhere` ("an unrecognised serve entry").
6. A `TCP` entry with no `Web` entry, or with any key other than `HTTPS` → `elsewhere` ("a TCP forward").
7. Exactly one handler, at `/`, whose `Proxy` equals `target` → `ours`.
8. Anything else → `elsewhere`, described by the root handler's `Proxy`, `Path` or `Text`, or as "N handlers".

The tests "serve state reads ours, elsewhere, funnel and off" and "anything Masthead does not fully understand counts as in use, never as off" cover these cases.

## `identityFrom(json)`

Parses `tailscale whois --json`. Returns `null` unless `Node.StableID` is a string. Otherwise:

- `nodeId` = `StableID`;
- `nodeName` = `ComputedName`, else `Hostinfo.Hostname`, else `Name`, with a trailing dot removed;
- `os` = `Hostinfo.OS`;
- `addresses` = `Node.Addresses` with any `/prefix` suffix removed;
- `tagged` = `Node.Tags` is a non-empty array;
- `user` only for untagged nodes with a `UserProfile.LoginName`; the name falls back to the login;
- `tailnetId` = `StableTailnetID`, or `''`.

## `class CliTailscale`

The real provider. `constructor(run = runTailscale)`.

- `status()` runs `status --json`. `running` is `BackendState === 'Running'`; `dnsName` is `Self.DNSName` without its trailing dot; `tailnetId` is `CurrentTailnet.StableID`; `selfNodeId` is `Self.ID`; `https` is true when `Self.CapMap` has an `https` key. Any error (not installed, not running, bad JSON) returns `null`.
- `serveState(port, target)` throws `Tailscale is not running or has no name for this machine.` without a DNS name. Otherwise it runs `serve status --json` (empty output counts as `{}`) and passes it to `serveStateFrom`.
- `addServe(port, target)` builds the command first (so bad input throws before anything runs), then reads the state. `ours` returns with nothing run. Anything other than `off` throws `Port N on Tailscale is already in use (…). Choose another port.` Only on `off` does it run `addCommand`.
- `removeServe(port, target)` mirrors it. `off` returns with nothing run. Anything other than `ours` throws `…serves something other than Masthead; left as it is.` Only on `ours` does it run `removeCommand`.
- `whois(address)` returns `null` without running anything unless the address is only hex digits, colons and dots. Errors give `null`.

## `class FakeTailscale`

A stand-in for tests that records every change command in `commands` instead of running it. `tailnet` (default `{running:true, dnsName:'host.example.ts.net', tailnetId:'T1', selfNodeId:'nSELF', https:true}`, or `null` for "not running"), `identities` (a map from address to `Identity`, which `whois` reads) and `serve` (a `ServeJson` the test can set). `addServe` and `removeServe` use the same `addCommand`/`removeCommand` and the same `serveStateFrom` as the real provider, then update `serve` as Tailscale would: a `Web` entry with one `/` proxy handler and `TCP[port] = {HTTPS:true}`.

## `class CachedWhois`

Wraps a provider so a burst of requests from the tailnet cannot start a `tailscale whois` each. `status`, `serveState`, `addServe` and `removeServe` pass straight through.

`whois(address)`:

- A lookup already running for the address is shared.
- An answer is kept for `ttlMs` (default 60 000 ms, 60 s).
- At most `maxConcurrent` lookups (default 4) run at once. The rest wait in a queue, and each finished lookup starts the next.
- Only answers are kept. A failed or `null` lookup (for example while tailscaled restarts) removes the entry, so it cannot lock a device out for a minute.
- Past 1000 entries the whole cache is cleared.

The tests "whois is cached a minute per address and at most four run at once" and "a failed whois is not cached" check this.

## Tests

`test/remote.test.ts`. All 35 tests in it and `test/storage.test.ts` passed when this page was written (`node --import tsx --test test/remote.test.ts test/storage.test.ts`). Again: they use `FakeTailscale` and fake runners only.

## Related pages

[Remote access](Remote-Access.md) · [Security model](Security-Model.md) · [server/remote/registry.ts](Source-Remote-Registry.md) · [server/remote/access.ts and authorise.ts](Source-Remote-Access.md) · [server/transport/remote.ts](Source-Transport-Remote.md)
