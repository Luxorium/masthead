# server/remote/access.ts and server/remote/authorise.ts

**Role:** `access.ts` is remote access as a whole: the on/off switch, Masthead's own `tailscale serve` entry, the device registry and the state shown to local sessions. The transport (`server/transport/remote.ts`) opens and closes the private listener when told, and `App` relays the person's decisions. `authorise.ts` makes the one decision the transport asks for: may this request go on, and as whom? The feature is described on [Remote access](Remote-Access.md) and the threats on [Security model](Security-Model.md).

Remote access has only ever run against a fake Tailscale (`FakeTailscale`) in tests. Nothing on this page has been run against a real tailnet.

## access.ts

### Targets

`RemoteTarget` is `{kind:'socket', path}` (a private Unix socket) or `{kind:'loopback', port}` (Windows). `targetUrl()` turns it into `unix:<path>` or `http://127.0.0.1:<port>`, the form `addCommand` accepts. `server/main.ts` picks the target with `chooseTarget` from `server/transport/remote.ts`.

### Config file

`<DATA_DIR>/remote/config.json`, written by `writeFileAtomic` (mode `0600`):

```json
{ "version": 1, "enabled": false, "port": 7443, "allowOtherTailnets": false, "allowTagged": false }
```

These are the defaults (`DEFAULT_REMOTE_PORT` is 7443). `load()` falls back to them for a missing or unreadable file or a version other than 1. Each field is checked: only `true` turns a flag on, and a port outside 1024–65535 becomes 7443. `load()` does not refuse 7717, 8443 or 10000; a hand-edited file with one of the last two would make `addServe` throw later (read from the code, not run).

### Constructor

`new RemoteAccess({dir, tailscale, target, now?, platform?})` creates `dir` (`0700`), loads the config and builds a `DeviceRegistry` in the same folder with the config's policy, `loopback` set when the target is a loopback port, and an `onExpire` that calls the device listeners with `{revoked:true}`. It wraps the provider in `CachedWhois`; the `tailscale` getter returns the wrapped one, which the transport uses for `whois`. Getters: `target`, `enabled`, `port`, `status` (the last `TailnetStatus`).

### `reconcile()`

Run once at start-up by `startRemote` in `server/transport/remote.ts`. It refreshes, then makes Tailscale match the setting: setting on and entry `off` → add it; setting off and entry `ours` → remove it. Someone else's entry, Funnel, or Tailscale not running → nothing changes. (Read from the code, not run.)

### `refresh()`

Reads Tailscale's status and the state of Masthead's port again. It never changes anything. If Tailscale is not running, `serve` becomes `unknown` and the problem says whether Tailscale is missing or just not connected. Otherwise `problemFor()` sets the problem: HTTPS certificates off; Funnel on the port; something else on the port; or "on, but Tailscale is not serving Masthead yet". An error from `serveState` becomes the problem text. Every refresh calls `changed()`.

### `setEnabled(on)`

The switch. It refreshes first, then:

- Tailscale not running: switching **on** gives `{ok:false, problem}`. Switching **off** still works: the setting is saved off (the listener closes) and the leftover entry is removed by `reconcile()` at the next start once Tailscale is back (tested in `test/remote-wiring.test.ts`).
- Switching on without HTTPS → refused with the HTTPS problem.
- Otherwise `apply(on)` calls `addServe` or `removeServe`. Only on success is `enabled` saved, a `switch` line written to the audit log and the state refreshed.

**Refusals:** an error from Tailscale becomes the problem. If its text looks like a permission error (`access denied`, `permission`, `operator`, `not permitted`, `must be root`, `requires root`), the problem says to become the Tailscale operator once and carries the **operator command** from `operatorCommand()`: `sudo tailscale set --operator=<user>` (user from `USER`, `USERNAME` or the literal `$USER`), or on Windows the sentence "Run Tailscale as an administrator, or ask your tailnet admin." Masthead shows this command; it never runs it. A refusal keeps its message on show until the next refresh.

`App` calls `setEnabled` for a `remote_settings` message with a boolean `enabled` and sends a refusal back to that browser as an error, with `Run: <command>` added when there is one.

### `configure(patch)`

Port and policy. Changing the port while switched on throws `Switch remote access off before changing its port.` A port must be an integer from 1024 to 65535 and not 7717, 8443 or 10000. `allowOtherTailnets` and `allowTagged` change only for boolean values. It passes the policy to the registry, saves and calls `changed()`. `App` calls it for every `remote_settings` message, before `setEnabled`.

### `decide(requestId, decision, role = 'full')`

The person's choice from a local session. `allow` checks the role and calls `registry.allow`; `deny` calls `registry.deny`. Both throw `That request is no longer waiting.` when the registry says no.

### Revoke, role and forget: `onDevice`, `revoke`, `setRole`, `forget`

`onDevice(fn)` registers a listener for `(nodeId, {revoked:true} | {role})` and returns an unsubscribe function. The transport listens so a device's open sockets follow a change at once.

- `revoke(nodeId)` revokes in the registry (throws if not allowed), tells the listeners `{revoked:true}` and calls `changed()`.
- `setRole(nodeId, role)` checks the role, changes it, tells the listeners `{role}`.
- `forget(nodeId)` is a device forgetting itself: like a revoke, with an extra `forget` audit line.

### `state()`

The `RemoteState` shown to local sessions only: `enabled`, `port`, `available` (running and HTTPS), `url` (`https://<dnsName>:<port>`, only while on), `serve` (`off`, `ours`, `elsewhere`, `funnel` or `unknown`), `problem` and `command`, `target` (`socket` or `loopback`), the policy flags, `devices` (without `tokenHash`) and `requests` (id, name, os, user, address, code, created time; no poll hash or token).

**Warning for loopback:** when the target is a loopback port, `state()` adds a `warning`: another program on this computer, including one run by another user account, could pretend to be one of your devices, so approve a device only while pairing it and only when the code on its screen matches.

### Other methods

`onChange(fn)` and `changed()` notify local pages. `audit(limit)` reads the registry's audit log.

## authorise.ts

### `authorise(facts, deps)`

`facts` is `{via, forwardedFor?, token?}`; `deps` is `{tailscale, registry, ourTailnet, selfNodeId}`. The transport fills `deps` from `RemoteAccess` (the cached provider and the last status). It returns a `Decision`:

1. `via === 'loopback'` → `{kind:'local'}`, whatever Tailscale or forwarding headers the request carries. On loopback such headers could only be forged by a local process. The local secret check stays in `http.ts`.
2. The first address in `X-Forwarded-For`; none → refused, `no forwarded address`.
3. `whois` finds no node → refused, `unknown tailnet address`.
4. The node is this machine → refused, `this machine uses the local address`.
5. `refusalFor()` (tagged or other tailnet) → refused and logged.
6. No token → `{kind:'unknown', identity}`: the device may ask to pair.
7. `registry.check()` accepts the token for **this** node → `{kind:'remote', role, device, identity}`, renewing the approval.
8. Otherwise refused and logged, as `token of <name> offered from another node` if `ownerOf` finds the token on another device, else `unknown or expired token`.

Tested by "loopback is local whatever headers it carries" and "the remote socket checks address, node, tailnet and token".

### `allowedMessage(role, type)` and the role table

Called by `server/app/clients.ts` for every browser message; a refusal is `This device may not do that.`

| Message | local | full | approve | read |
|---|---|---|---|---|
| `hello`, `open`, `items`, `subscribe`, `unsubscribe`, `draft_sync`, `item_full` | yes | yes | yes | yes |
| `permission`, `interrupt`, `stop_agent`, `stop_all`, `check_backends` | yes | yes | yes | no |
| any other message (sending, starting, settings, …) | yes | yes | no | no |
| `device_decision`, `device_revoke`, `device_role`, `remote_settings`, `remote_audit`, `shutdown` | yes | no | no | no |
| `forget_me` | no | yes | yes | yes |

Tested by "roles limit the messages a remote device may send; shutdown and device management stay local".

## Related pages

[Remote access](Remote-Access.md) · [Security model](Security-Model.md) · [server/remote/tailscale.ts](Source-Remote-Tailscale.md) · [server/remote/registry.ts](Source-Remote-Registry.md) · [server/transport/remote.ts](Source-Transport-Remote.md)
