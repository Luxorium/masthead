# Text and words in the page (text.ts, words.ts)

Every word the page shows lives in `web/src/lib/text.ts`, and the words for statuses, sizes and paths are built in `web/src/lib/words.ts`. This page describes Masthead 0.2.0.

## `text.ts`

The file's own reason: plain language for anybody, no team jargon on first sight, and one file for wording reviews (and for any translation). There are no translations.

It exports one object, `T` (declared `as const`), and two functions. Entries are plain strings, or functions that take what varies (a name, a count, a time) and return a string. The groups:

| Group | Used for |
|---|---|
| `app`, `signIn`, `firstRun` | Name, signed-out screen, first-run screen |
| `shell` | Header, chat list, Team button, skip link, live-region "replied", breadcrumbs |
| `banner` | Usage-limit banner |
| `empty` | New-chat heading, intro and the three example prompts |
| `composer` | Message box placeholders, Stop, folder chip, picture errors |
| `transcript` | Show earlier, inbound headings, thinking, tool labels |
| `status` | Agent statuses (used by `words.ts`) |
| `team` | Team panel: "This chat uses the team …" (`usesTeam`), outline, Hide finished, the "N finished: …" row, expand and collapse labels, panel width, Stop (the tooltip `stopTitle(name)`, "Stop Bravo and its helpers", since 0.2.1), levels |
| `progress` | 0.2.1: a helper's time on what it is doing ("under 1 min", "4 min", "1 h 5 min", "over …", the " · " separator), "Waiting for 2 helpers: Bravo, Charlie", show/hide what each helper is doing, "Open Bravo's chat", "Waiting for your answer" and its tooltip |
| `preview` | The team outline's preview: "Report from", "Message from" and "Thinking…" |
| `compact` | Tidying the team ([Compact team](Compact-Team.md)): the setting and per-chat switch, the card, progress lines and Cancel, the "Archived helpers (M)" row, the Archived note, Restore, the `/compact` hint |
| `usage` | Usage meter (with "not reported yet", `notReported`, since 0.2.1) and the names of usage windows |
| `settings` | Settings view: General, ask modes, thinking, Appearance, About |
| `effort` | Thinking time names: Short, Medium, Long, Longest |
| `images` | Viewer and thumbnails |
| `card` | Approval cards |
| `device` | Settings > This device, role lines |
| `remote` | Remote sign-in, device requests (since 0.2.1 one help line per role in `request.roleHelp`, an Allow button that names the role, `request.allow(role)`, and the warning only for Everything), roles (in the order "Read only", "Answer approvals and stop work", "Everything"), Remote access section, audit events (`event()`), `when()` |
| `teams` | Agent programs, teams (with `moreInAdvanced`, the Simple pointer to "Show team controls"), levels, problems, the team chip |
| `folder` | The folder picker |
| `wants` | The "wants to …" phrase per tool on approval cards |
| `errors` | `notConnected` |

Three private helpers: `plural(n, one, many)`; `roleWord(role)`, a device role in the page's words ("everything", "answer approvals and stop work", "read only") for the audit lines; and `when(ts)`, a short local date and time (also exposed as `T.remote.when`).

The plain words follow the plan's table (`docs/plans/0.2.0/web.md` 0.4): "main assistant" and "helper", not lead and sub-agent; levels named by their model; "Thinking time" with Short to Longest, not effort; "When to ask you"; "Allow for this session"; "Don't answer"; "Memory used"; "Waiting its turn". Model names stay where a choice is made.

`T.remote` and `T.teams` were moved in from `remote/text.ts` and `settings/text.ts`, which now only export `RT = T.remote` and `ST = T.teams`, so existing imports keep working.

### The jargon test

`web/test/text.test.ts` walks every string in `T` (calling each function with sample arguments) and fails if any matches `\b(tiers?|sub-?agents?|lead|effort)\b`, case-insensitive. Model names (Opus, Sonnet) are allowed there, because levels are called by their model. The browser test is stricter on the first screen: the visible text of the first load must not contain tier, Opus, Sonnet, Haiku, effort, sub-agent or lead ([Page tests](Source-Web-Tests.md#browser-test-testuie2emjs)).

### Words outside `text.ts`

`web/test/no-inline-text.test.ts` scans the markup of every `.svelte` file (text between tags and the `aria-label`, `title`, `placeholder` and `alt` attributes) and fails on English written inline; only "Masthead" and "Copy" are allowed ([Page tests](Source-Web-Tests.md#test-files)). It does not read scripts, so a few words are still set in TypeScript: `markdown.ts` ("Copy", "Copied" on code blocks), `RemoteSignIn` (its "this device" default), `images.ts` (the upload failure) and `store.send()` (its own not-connected sentence). The jargon test does not see these.

### `friendlyError`

`friendlyError(message)` rewrites known server messages into plain words with one next action. App passes every toast through it. Anything not listed is shown as the server wrote it.

| Server says | Shown |
|---|---|
| The message is too long. | That message is too long to send (over 400,000 characters). Put the text in a file in the folder and mention its name. |
| That conversation no longer exists. | This chat was deleted in another window. Pick another chat or start a new one. |
| The message is empty. | Type a message first. |
| Unsupported image. | That picture could not be used. Only PNG, JPEG, GIF and WebP pictures can be attached. |
| … is not a folder. | The same sentence, then "Choose another folder under the message box." |

### `programName`

`programName(id, label?)` gives a program's name for people when the server's list does not have it (not installed): the label if given, else "Claude Code", "Codex" or "the test program" for the known ids, else the id with dashes as spaces and a capital first letter. The team settings use it so a person never sees a raw id.

## `words.ts`

Words for statuses, sizes and paths, shared by every component that shows an agent. `store.svelte.ts` re-exports most of them.

- `fmtTokens(n)`: `950`, `12k`, `1.5k`, `1.00M`.
- `shortPath(path, home)`: replaces the home folder with `~`. Windows paths (`C:\…`) are compared without case.
- `childPath(parent, name)`: joins with the parent's own separator (`\` on Windows).
- `statusWords(agent)`: what an agent is doing, wherever the page shows one. Paused until a time (usage limit), waiting for a named agent, its `activity` while running, failed or stopped with a short reason, else `STATUS_LABEL`. The comment asks that a new sub-state be added here as one line.
- `shortReason(error)`: known server reasons named plainly ("by you", "run-time limit", "by Bravo", "Alpha ended first", "Masthead was closed"), anything else cut to its first sentence and 60 characters.
- `STATUS_LABEL`: the word per status, from `T.status`. `waiting` covers both waiting on its helpers and on a command left running in the background.

Tested in `web/test/words.test.ts`.

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web components](Source-Web-Components.md) · [Glossary](Glossary.md) · [Page tests](Source-Web-Tests.md)
