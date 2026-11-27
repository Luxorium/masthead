# Settings and remote access in the page

The settings view and its parts in Masthead 0.2.0: `web/src/lib/SettingsView.svelte`, `web/src/lib/settings/` (teams and agent programs) and `web/src/lib/remote/` (remote access and device sign-in). What the settings mean is on [Team profiles and settings](Team-Profiles-and-Settings.md) and [Configuration and settings](Configuration-and-Settings.md); remote access as a whole on [Remote access](Remote-Access.md).

## SettingsView.svelte

Settings as a view in place of the chat; it replaced the 0.1.x popup. Opened by the ⚙ button ([SettingsMenu](Source-Web-Components.md#settingsmenusvelte)). It is a `role="dialog"` with `aria-modal="false"`. On mount it focuses its first field or button; Escape or × goes back to the chat and focus returns to ⚙.

Sections, in order:

1. **This device** (only on a remote device): that the browser stays signed in, what its role allows if it is not `full`, and **Forget this device** with one sentence on when to use it ([Signing in](Source-Web-Front-End.md#remote-devices)).
2. **General:** "When to ask you" (the permission mode; "Never ask (risky)" adds a warning line), "Longest a helper may work" (no limit, 15, 30, 60, 120 or 240 minutes, plus the current value if it is something else), "Show helper reports as one line", "Tidy the team automatically" with its help line (`autoCompact`, on by default; shown only if the server's settings have it; off means the person is asked first with a card, see [Compact team](Compact-Team.md)), "Keep this computer awake while helpers are working" (only if the server's settings have `keepAwake`), "Show team controls" (Advanced, kept in this browser by `ui`, not on the server), and in Advanced "Let them decide how long to think".
3. **Teams** (`ProfilesSection`).
4. **Agents on this computer** (`BackendsSection`).
5. **Remote access** (`RemoteSection`), only when `store.remote` is set, which is only on this computer's own page.
6. **Appearance:** "Same as this device", Light or Dark (`ui.setTheme`, kept in this browser).
7. **About:** the Masthead version and the Claude Code version and path, or why it was not found.

Sections 2 to 6 sit in a `<fieldset>` that is disabled when `store.mayAct` is false, so a device with a lesser role sees the settings but cannot change them. Every server setting goes through `store.updateSettings()`, which sends only what changed.

## Teams and agent programs (`settings/`)

### `settings/types.ts`

`BackendModel` (`id`, `label`, `efforts`, optional `contextWindow`, `default`, `description`) and `BackendEntry` (`id`, `label`, `available`, `path`, `version`, `signedIn`, optional `minVersion`, `error`, `warning`, `models`). `readBackends(raw)` reads `store.backends` defensively: entries without a string `id` are left out, a missing label falls back to the id, and wrong-typed fields become `null` or are dropped.

### `settings/logic.ts`

Plain logic, no Svelte, tested on its own:

- `EFFORT_ORDER`: `low`, `medium`, `high`, `xhigh`. There is no `max`.
- `backendOf`, `modelOf`: lookups.
- `usable(profile, backends)`: a team can start when every program its levels use is reported available. Programs with no report count as not ready. `usableProfiles()` filters a list.
- `problems(profile, all, backends)`: every problem in plain words, in the order a person would fix them: no name, a name another team has (case-insensitive), no levels, more than `MAX_TIERS` (5), more than one program, a level without a model, a model the program no longer offers, a thinking time the model does not offer, helpers outside 0–`MAX_PER_TIER` (12), a helper level at 0 with levels after it (they would never start), and a program not ready. Models are judged only against a program that reported its list.
- `fitEffort(model, want)`: the longest thinking time the model offers that is not above `want`.
- `freeColour(profile)`: the first palette colour the team does not use.
- `addLevel(profile, backends)`: a new last level on the same program, with the next model in the program's list after the level above, thinking time fitted to medium, 2 helpers, kept light, a free colour.
- `removeLevel(profile, i)`: never the first level.
- `newProfileId(label, all)`: a slug of at most 32 characters, with `-2`, `-3` … until free.
- `copyOf(profile, all)`: "<name> (copy)" (numbered if taken), not built in, with new ids for the team and its levels.
- `withModel(tier, model, previous)`: sets the model; the label follows the model unless the person renamed the level, and the thinking time is fitted.

### `settings/text.ts`

`ST`, an alias for `T.teams` in `text.ts` ([Text and words](Source-Web-Text.md)). The strings used to live here.

### `BackendsSection.svelte`

"Agents on this computer": each program the server looked for, with Ready, Not ready or Not found, its version and number of models. A program that is not ready gets one next step: install it, sign in to it, update it (when its error mentions an old version and the server gave `minVersion`), or the server's error. A `warning` shows as a note. "Check again" sends `check_backends` through `store.request()` and shows "Checking…" until the `backends` reply comes (`store.listen`).

### `ProfilesSection.svelte`

"Teams": each team with its levels as coloured dots and "Main assistant: <model>" / "Level N helper: <model>", a "Built in" tag, and a warning if its program is not ready. Actions per team: Edit (opens `TeamEditor` in place), "Make a copy" (adds the copy and opens it), and "Reset to the built-in team" for a built-in team (sends `reset_profile`) or "Remove team" for the person's own (after a `confirm()`; if it was the default, the default goes back to the Claude team).

"Team for new chats" (a select, when there is more than one team) sets `defaultProfile`; teams that cannot start are disabled in it.

**The Codex proposal.** When the built-in `codex` team exists and can start, and it is not already the default, a box says a team for Codex is ready, with "Use it for new chats" and "Change it first". Using or saving it hides the box. That choice is component state, so the box shows again after the settings view is reopened, until Codex is the default.

### `TeamEditor.svelte`

Edits one team on a copy; nothing is sent until Save. Props: `profile`, `all`, `backends`, `onsave`, `oncancel`.

- Team name (at most 40 characters).
- Per level: the program (first level only; changing it moves every level to that program, each to the model at its place in the list, since a team uses one program for now), the model (from the program's real list; a model no longer offered stays shown as the current value), thinking time (only those the model offers), "Name shown", helpers at a time (not for the first level, which is always one), colour (the eight palette slots), and "Keep light" with a hint that it leaves out the person's own MCP servers.
- Move up and Move down (never above the first level), "Remove this level", and "Add a helper level" up to five levels.
- Save checks `problems()`. If any, they show as a list (`role="alert"`) and nothing is saved.

Field ids carry a random suffix so two editors cannot clash.

### `ProfileChip.svelte`

The team picker under the message box on the new-chat screen, mounted by the composer only when more than one team can start now. Props: `value` and `onchange`. The button reads "Uses <team>" and opens a menu (`role="menu"`, items `menuitemradio`) of the teams that can start, each with its level colours. Focus goes to the checked item; ↑ ↓ move, Escape closes and returns focus to the button, Tab closes.

## Remote access (`remote/`)

### `remote/types.ts`

The shapes the server sends about remote access, copied because the page cannot import server code: `RemoteRole`, `RemoteDevice`, `RemoteRequest`, `RemoteState` (`enabled`, `port`, `available`, `url`, `serve`, `problem`, `command`, `target`, `warning`, `allowOtherTailnets`, `allowTagged`, `devices`, `requests`) and `AuditEntry`. `spacedCode("482913")` gives "482 913", easier to compare by eye.

### `remote/text.ts`

`RT`, an alias for `T.remote` in `text.ts`.

### `RemoteSection.svelte`

The Remote access part of the settings, on the computer's own page only.

- "Allow my other devices to connect" sends `remote_settings` with `enabled`; the status line says "Turning on…" until the state changes or an error comes. Without Tailscale it says so and the switch is disabled.
- When on: the address to open on the other device, with Copy. If copying fails, the text is shown in the toast instead.
- The server's `problem`, the command to run once in a terminal (with Copy), and any `warning`, as sent.
- Port (locked while on), "Allow devices shared from other Tailscale networks", "Allow devices without a user (tagged devices)".
- Allowed devices: name, system, user, address, last use and expiry, a role select (`device_role`) and Remove (`device_revoke`).
- "Show recent activity" asks for `remote_audit` and lists the newest 50 entries in plain words (`RT.event`).

### `DeviceRequestCard.svelte`

A device asking to be let in, shown above the message box on the computer's own page. Prop `request`. It shows the device, its system, user and address, the code to compare, a warning, a role select (Everything, "Answer approvals and stop work", "Only read"), and Deny / Allow, which send `device_decision`. The role select starts at Everything. It takes focus by the same rule as an approval card ([PermissionCard](Source-Web-Components.md#permissioncardsvelte)).

### `RemoteSignIn.svelte`

What a device sees until it is approved, in place of the whole page. Props: `withdrawn` (shows "This computer withdrew access for this device.") and `onapproved(token)`.

Phases: `checking` → asks `/api/remote/whoami` (the server's name for the device is shown if given). Approved with a stored token: hands it over at once. Refused: says why. Otherwise, if a request is already waiting, it goes on polling; else `ready` with "Ask for access".

"Ask for access" posts to `/api/remote/request` and gets a request id, a poll secret and a code. The page shows the code to compare on the computer and polls `/api/remote/request/<id>` with the secret every 2 s. `allowed` with a token → `onapproved`; anything but `pending` → "This device was not allowed, or the request ran out." with Ask again. A failed poll keeps waiting. HTTP 429 says to wait a minute. The request (id, secret, code) is kept in `sessionStorage` under `masthead.pairing`, because asking again while a request waits is refused, and a reload must not lose it.

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web store](Source-Web-Store.md) · [Web components](Source-Web-Components.md) · [Team profiles and settings](Team-Profiles-and-Settings.md) · [Remote access](Remote-Access.md) · [Using Masthead from your phone](Using-Masthead-From-Your-Phone.md) · [Page tests](Source-Web-Tests.md)
