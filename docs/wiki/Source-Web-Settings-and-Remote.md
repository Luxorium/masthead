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

The server settings (the General choices except "Show team controls", Teams, Agents, Remote access) sit in `<fieldset>`s disabled when `store.mayAct` is false, so a device with a lesser role sees them but cannot change them. "Show team controls" and Appearance are kept in this browser only, so they work on every device. On a device, This device also shows "To do more, change what this device may do on the computer, in Settings → Remote access." Every server setting goes through `store.updateSettings()`, which sends only what changed.

## Teams and agent programs (`settings/`)

### `settings/types.ts`

What the server sends about the agent programs it found. `BackendModel` (`id`, `label`, `efforts`, optional `contextWindow`, `default`, `description`) and `BackendEntry` (`id`, `label`, `available`, `path`, `version`, `signedIn`, optional `minVersion`, `error`, `warning`, `models`). `readBackends(raw)` reads `store.backends` defensively: entries (and models) without a string `id` are left out, a missing label falls back to the id, `available` is true only when it is exactly `true`, and wrong-typed fields become `null` or are dropped. A non-array gives `[]`.

### `settings/logic.ts`

Plain logic, no Svelte, tested on its own:

- `EFFORT_ORDER`: `low`, `medium`, `high`, `xhigh`. There is no `max`.
- `backendOf`, `modelOf`: lookups.
- `usable(profile, backends)`: a team can start when every program its levels use is reported available. Programs with no report count as not ready. `usableProfiles()` filters a list.
- `problems(profile, all, backends)`: every problem in plain words, in the order a person would fix them: no name, a name another team has (case-insensitive), no levels, more than `MAX_TIERS` (5), more than one program, a level without a model, a model the program no longer offers, a thinking time the model does not offer, helpers outside 0–`MAX_PER_TIER` (12), a helper level at 0 with levels after it (they would never start), and a program that reported itself not ready. Models are judged only against a program that is available and reported its list; a program with no report at all gives no problem here (but `usable()` is false).
- `fitEffort(model, want)`: the longest thinking time the model offers that is not above `want`; `want` itself when the model lists none, and the model's first when all it offers are above `want`.
- `freeColour(profile)`: the first palette colour the team does not use.
- `addLevel(profile, backends)`: a new last level (none past `MAX_TIERS`) on the same program, with the next model in the program's list after the level above, thinking time fitted to medium, 2 helpers, kept light, a free colour. On an empty team it makes the main assistant: one at a time, not light, on the first available program (else `claude-code`).
- `removeLevel(profile, i)`: never the first level.
- `newProfileId(label, all, taken?)`: a slug of at most 32 characters, with `-2`, `-3` … until free of every team id and every id in `taken` (the `profileId`s chats still name), so a removed team's id never comes back and its chats never join a new team.
- `copyOf(profile, all, taken?)` (ProfilesSection passes the chats' `profileId`s): "<name> (copy)" (numbered if taken), not built in, with new ids for the team and its levels.
- `withModel(tier, model, previous)`: sets the model; the label follows the model unless the person renamed the level, and the thinking time is fitted.

### `settings/text.ts`

`ST`, an alias for `T.teams` in `text.ts` ([Text and words](Source-Web-Text.md)). The strings used to live here.

### `BackendsSection.svelte`

"Agents on this computer": each program the server looked for, with Ready, Not ready or Not found, its version and number of models. The version shows when known; the model count only for a ready program. A program that is not ready gets one next step: install it (no path), sign in to it (`signedIn` false), update it (when its error mentions an old version and the server gave `minVersion`), or the server's error. A `warning` shows as a note. With no programs at all: "No agent program was found on this computer yet." "Check again" sends `check_backends` through `store.request()` and shows "Checking…" until the `backends` reply comes (`store.listen`).

### `ProfilesSection.svelte`

"Teams": each team with its levels as coloured dots and "Main assistant: <model>" / "Level N helper: <model>", a "Built in" tag, its description if it has one, a level's `unusable` note if the server set one, and a warning if its program is not ready. The actions below are shown only in Advanced (`ui.advanced`, 0.2.1); in Simple the section shows the teams and "Team for new chats", with one line above the list: "To change, copy or remove a team, turn on “Show team controls” above." Actions per team: Edit (opens `TeamEditor` in place), "Make a copy" (adds the copy and opens it), and "Reset to the built-in team" for a built-in team (sends `reset_profile`) or "Remove team" for the person's own. Remove asks with a `confirm()` and sends `delete_profile`. The server refuses to delete a team that chats use and says how many (`inUse` on the error); the section listens for that error and asks a second `confirm()` naming the count. Yes sends `delete_profile` with `force: true` (those chats keep working with their stored levels); no shows "Kept “<team>”: N chats use it."

"Team for new chats" (a select, when there is more than one team) sets `defaultProfile`; teams that cannot start are disabled in it.

**The Codex proposal.** When the built-in `codex` team exists and can start, and it is not already the default, a box says a team for Codex is ready, with "Use it for new chats" and, in Advanced only, "Change it first". Using or saving it hides the box. That choice is component state, so the box shows again after the settings view is reopened, until Codex is the default.

### `TeamEditor.svelte`

Edits one team on a copy; nothing is sent until Save. The form is `novalidate`, so an out-of-range helper count reaches `problems()` and is refused in plain words instead of by the browser. Props: `profile`, `all`, `backends`, `onsave`, `oncancel`.

- Team name (at most 40 characters).
- Per level: the program (first level only; the list holds programs that reported models or that the team already uses; changing it moves every level to that program, each to the model at its place in the list, since every level of a team uses the same program), the model (from the program's real list; a model no longer offered stays shown as the current value), thinking time (only those the model offers), "Name shown", helpers at a time (not for the first level, which is always one), colour (the eight palette slots), and "Keep light" with a hint that agents on that level cannot use the person's connected services and tools (MCP servers), so they start faster and use less.
- A level's `unusable` note, when the server set one.
- Move up and Move down (never above the first level), "Remove this level", and "Add a helper level" up to five levels (`MAX_TIERS`).
- Save checks `problems()`. If any, they show as a list (`role="alert"`, only after the first Save) and nothing is saved. Cancel closes without sending.

Field ids carry a random suffix so two editors cannot clash.

### `ProfileChip.svelte`

The team picker under the message box on the new-chat screen, mounted by the composer when more than one team can start now, or when the only one that can start is not the default. Props: `value` and `onchange`. If `value` names a team that cannot start now, the chip shows the first one that can and calls `onchange` with it, so the new chat starts with the team the chip names. The button reads "Uses <team>" and opens a menu (`role="menu"`, items `menuitemradio`) of the teams that can start, each with its level colours. Focus goes to the checked item; ↑ ↓ move, Escape closes and returns focus to the button, Tab closes.

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
- Allowed devices: name, system, user, address, last use and expiry, a role select (`device_role`; the roles listed Read only, "Answer approvals and stop work", Everything) and Remove (`device_revoke`).
- "Show recent activity" asks for `remote_audit` and lists the newest 50 entries in plain words (`RT.event`).

### `DeviceRequestCard.svelte`

A device asking to be let in, shown above the message box on the computer's own page. Prop `request`. It shows the device, its system, user and address, the code to compare, and "What it may do" as a `<fieldset>` of radio buttons (0.2.1; before, a select that started at Everything): Read only, "Answer approvals and stop work" and Everything, each with one plain line under it (`RT.request.roleHelp`, tied by `aria-describedby`). Read only, the most limited, is chosen until the person picks more. The warning ("Everything lets this device do anything you can do here, including running commands. Choose it only for your own device.") shows only while Everything is chosen. Deny and Allow send `device_decision`; Allow names the role: "Allow, read only", "Allow approvals and stop" or "Allow everything". On touch screens each choice is 44 px tall. It takes focus by the same rule as an approval card ([PermissionCard](Source-Web-Components.md#permissioncardsvelte)).

### `RemoteSignIn.svelte`

What a device sees until it is approved, in place of the whole page. Props: `withdrawn` (shows "This computer withdrew access for this device.") and `onapproved(token)`.

Phases: `checking`, `ready`, `waiting`, `gone`, `refused` and `offline` (the computer could not be reached; Ask again checks again). `checking` asks `/api/remote/whoami` (the server's name for the device is shown if given, else "this device"). Approved with a stored token: hands it over at once. Refused: says why. Otherwise, if a request is already waiting, it goes on polling; else `ready` with "Ask for access".

"Ask for access" posts to `/api/remote/request` and gets a request id, a poll secret and a code. The page shows the code to compare on the computer and polls with `POST /api/remote/request/<id>` and the secret in a JSON body every 2 s. `allowed` with a token → `onapproved`; anything but `pending` → "This device was not allowed, or the request ran out." with Ask again. A failed poll keeps waiting. HTTP 429 says to wait a minute. The request (id, secret, code) is kept in `sessionStorage` under `masthead.pairing`, because asking again while a request waits is refused, and a reload must not lose it.

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web store](Source-Web-Store.md) · [Web components](Source-Web-Components.md) · [Team profiles and settings](Team-Profiles-and-Settings.md) · [Remote access](Remote-Access.md) · [Using Masthead from your phone](Using-Masthead-From-Your-Phone.md) · [Page tests](Source-Web-Tests.md)
