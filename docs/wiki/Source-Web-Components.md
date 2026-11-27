# Web components

The Svelte components in `web/src/lib/`, `web/src/lib/transcript/` and `web/src/lib/team/`, as of Masthead 0.2.0. Each reads from the shared `store` ([Web store](Source-Web-Store.md)) and sends its actions through it; none opens a socket itself. Image components are on [Images](Source-Web-Images.md), and the settings view with its team and remote-access parts on [Settings and remote access](Source-Web-Settings-and-Remote.md). The layout that places them is on [Web front end](Source-Web-Front-End.md#layout-appsvelte).

All visible words come from `T` in `text.ts` ([Text and words](Source-Web-Text.md)), with a few exceptions named below. Agent names are always shown through `displayName()` from `shared/protocol.ts`: "bravo" is shown as "Bravo", "alpha-ii" as "Alpha II". Model names go through `modelLabel()`.

## Who renders what

```
App
├─ RemoteSignIn                      (remote device, not yet approved)
├─ Sidebar ─ UsageMeter, SettingsMenu
├─ main
│  ├─ SettingsView                   (settings open)
│  ├─ FirstRun                       (no backend can run)
│  ├─ Transcript ─ UserItem, TextItem, ThinkingItem, ToolItem, InboundItem,
│  │               NoticeItem, DraftView, StatusLine ─ AgentSpan, Expander;
│  │               Thumbs ─ ImageViewer
│  └─ dock: DeviceRequestCard, PermissionCard, CompactCard, CompactProgress,
│           Composer ─ AnswerMarker, FolderPicker, ProfileChip (or the
│           "Archived" note; on a device that may not act, the role note instead)
└─ TeamPanel ─ CompactProgress, TeamOutline ─ Expander, AgentSpan, StopControl;
               TierControls
```

## Sidebar.svelte

The chat list, the left column (or drawer). Props: `onhide` (the ⟨ button hides it) and `onpick` (called after a chat is chosen or started, so App can close the drawer on narrow screens).

- "Masthead" and the hide button at the top.
- "+ New chat" (`store.newConversation()`), only when `store.mayAct`.
- The chats from `store.conversations`, in the order the server sends them. Each row: a pulsing dot when `c.busy`, the title, and a count badge "Needs your answer" from `store.waitingIn(id)` (approval summaries in version 2). The open chat is highlighted.
- Delete (×), only with `mayAct`: the first press turns it into "Delete?" for 3 s; a second press sends `{t:'delete'}`.
- Empty list: "Your chats appear here."
- `UsageMeter`, only once some usage has been reported.
- The foot: a red dot and "Not connected" only while disconnected, then the ⚙ button.

## Transcript.svelte

The open agent's chat: `store.viewItems`, `store.viewDraft` and `store.viewAgent`.

- **New chat:** the heading "What are we working on?", one sentence, and three example prompts. A click puts the example into the composer and focuses the box; it does not send. The plan's variant for an empty folder ("Start a small website…") is not built.
- **Nothing yet:** "Nothing here yet." when the agent on screen has no items and no draft and is neither running nor queued.
- **Windowing:** only the newest 80 items are rendered. "Show earlier (N more items)" adds 80 and keeps the scroll position; when all loaded items are shown and the server has older ones (`store.pages[id].more`), the same button asks for the next page ("Show earlier"). It is disabled while a page loads. See [Rendering speed](Source-Web-Front-End.md#rendering-speed).
- **Items:** each in a wrapper with `content-visibility: auto`, except tool lines. The kinds are rendered by the components under [Transcript items](#transcript-items).
- **Draft and status:** `DraftView` while a draft exists, else `StatusLine`. "Starting…" while a new chat is being created.
- **Scrolling:** the view follows new output only while the reader is within 80 px of the bottom (`pinned`). A ↓ "Jump to latest" button shows otherwise. Opening another chat or agent pins again and resets the window. A picture that finishes loading keeps the view at the bottom; image `load` events do not bubble, so this listens in the capture phase.
- **Showing a question** (0.2.1): each item's wrapper carries `data-item=<id>`. When `progress.focus` is set (by [AnswerMarker](#answermarkersvelte)), an effect clears it and scrolls to that item, widening the window first if it is above the newest page, centred (smoothly unless reduced motion is asked for). It unpins the view, gives the item `tabindex=-1` and focus so a screen reader reads it next, and adds the `highlight` class for 2.6 s: a soft wash that fades, or stays still under reduced motion (`Transcript.svelte` `showItem()`).
- The column's click handler is `handleCopyClick`, for Copy buttons in code blocks.

## Transcript items

The `web/src/lib/transcript/` components. Each takes one `item` prop of its kind (except `DraftView` and `StatusLine`).

- **`UserItem.svelte`:** the person's message in a bubble. 0.2.0 items carry the pictures (`BlobRef[]`), shown with `Thumbs`; 0.1.x items stored only a count, shown as "2 pictures attached".
- **`TextItem.svelte`:** the assistant's text, `renderMarkdown` into a `.md` block.
- **`ThinkingItem.svelte`:** a closed `<details>` "Thought" with the thinking as Markdown.
- **`ToolItem.svelte`:** one line from `toolLine()` (verb and target), a running dot while not done, "failed" on errors, and a chevron. Clicking opens the input (pretty JSON) and result ("(empty)" if blank). If the item arrived clipped, opening it calls `store.fetchFull()`. Tool images show as thumbnails even when the line is closed, because a screenshot is usually the point of the call.
- **`InboundItem.svelte`:** a task, report or message from another agent: "Asked by Alpha", "Bravo finished", "Bravo says". The name opens that agent's chat. A report that ended other than done shows its status. Tasks start closed; reports start closed when "Show helper reports as one line" (`collapseReports`) is on, showing their first 100 characters as a button that opens them. Show/Hide toggles. The body is Markdown.
- **`NoticeItem.svelte`:** a plain-text notice; `level === 'error'` gets the error style.
- **`DraftView.svelte`:** prop `draft`. A text draft goes through `renderDraft` at most once per animation frame, shown with a `.streaming` class. A thinking draft shows "Thinking…" and its last 140 characters as plain text.
- **`StatusLine.svelte`:** props `agent` and `toolRunning`. What the agent is doing when there is no draft: paused (usage limit), working (its `activity`, or "Working…"; hidden while a tool line is already running), "Waiting its turn…", or waiting. Waiting for a named agent shows the status words. Waiting on live helpers (queued, running or waiting) is a disclosure button (0.2.1): "Waiting for 2 helpers: Bravo, Charlie", with `aria-expanded`, `aria-controls` and an `Expander`, closed at first. Open, a list gives each helper's name (a button that opens its chat, `store.viewOf()`), its status words and its time on them ([AgentSpan](#agentspansvelte)). Otherwise the status words.

## Composer.svelte

The message box, in the dock. App remounts it (inside `{#key store.composerKey}`) when the chat or the agent on screen changes, so each keeps its own text and pictures in `store.composer`. No props.

- **Who it talks to.** New chat: "Ask for anything". The lead: "Reply to Alpha", or "Add to what Alpha is doing" while it runs. A helper on screen: "Message Bravo directly, not Alpha", with a line above, in the helper's colour: "To **Bravo** · <model>" and "Back to Alpha". If that helper is waiting for an answer, a hint says that what is sent here answers it.
- **Sending.** Enter sends (not during IME composition), Shift+Enter is a new line. Send is enabled when there is text or a picture, no picture is uploading or failed, the socket is connected, no new chat is being created, and a backend can run. The textarea (`id="message"`, the skip link's target) grows up to 260 px and takes focus on mount.
- **"Waiting for your answer".** In an existing chat, [AnswerMarker](#answermarkersvelte) sits above the box.
- **Stop.** While the lead runs and the box is empty, ■ replaces ↑ and sends `{t:'interrupt'}`. Under the box, "Stop all" (`{t:'stop_all'}`) shows while any helper is live.
- **Pictures.** + opens a file picker; paste and drop work too. Checks, shrinking and upload: [Images](Source-Web-Images.md#attaching-pictures-composersvelte).
- **Under the box, new chat:** the folder chip ("Folder ~/projects/x"), which opens `FolderPicker`; the team chip `ProfileChip`, when more than one team can start now or when the only one that can is not the default (then the chip names it and the chat starts with it); and on the very first chat, "Agents can read and change files in this folder."
- **Under the box, existing chat:** the folder as a static chip (full path in its tooltip), and Stop all.
- **The `/compact` hint.** In an existing chat, while the text is a prefix of `/compact` with no space, a small `role="listbox"` offers "/compact: Tidy the team now". Tab, a click, or Enter before the word is complete fills in `/compact `; Enter on the full word sends it as typed, and the server treats it as a request to tidy the team ([Compact team](Compact-Team.md)). Not shown in a new chat or while messaging a helper directly.
- **Advanced only:** the model that will answer, its thinking time, and the short "when to ask" mode. For a chat without a lead yet it reads the first level of the chat's profile, else the team picked on the new-chat screen, else the default.

## FolderPicker.svelte

The folder chooser for a new chat, a small `role="dialog"` over the composer. Prop `onclose`. On mount it clears `store.dirs` (an old listing must not be shown or chosen) and sends `{t:'dirs', path: store.newCwd}`. A path field (Enter lists it), "‹ Up to …", the subfolders (each lists itself on click), and Cancel / "Use this folder", which sets `store.newCwd`. On Windows the server uses the sentinel `drives:` for the list of drives; the picker shows it as "Drives" and cannot choose it. Child paths use the parent's own separator (`childPath()` in `words.ts`).

Its words are in `T.folder`.

## PermissionCard.svelte

One approval request, in the dock. Prop `request` (a `PermissionRequest`). It is a `role="alertdialog"` card.

- **Focus.** A module-level listener records the last key press. On mount the card takes focus unless a key was pressed in the last 1.5 s, the focused field has text, or another card has focus. It focuses the card, not Allow, so a stray Enter answers nothing.
- **Questions** (`kind === 'question'`): each question as a fieldset with its options as toggle buttons (one or many) and a "Something else…" field. Typing in that field clears the picks of a single-choice question, and picking an option of a single-choice question clears the field. Answer is enabled once every question has an answer; "Don't answer" sends `deny`. A question's picks and its free text are joined with ", ". Answers are keyed by question text, as Claude Code's AskUserQuestion expects; two questions with the same text share one entry, with both answers joined by " | ".
- **Permissions:** "Bravo wants to run a command" (or the request's `title`), the command in full, or for other tools the target (only when there is no `title`) and Show details; the description; Deny, "Allow for this session" (only if `canAlways`), Allow.
- **Read-only device** (`!store.mayAnswer`): the card still shows, with the question options and field disabled and, in place of the buttons, "This device is read only, so it cannot answer. Answer on the computer."

The "wants to …" phrases per tool are in `T.wants`; an unknown tool gets `T.wants.other()` with its name (an `mcp__` prefix dropped and `__` shown as " · ").

## TeamPanel.svelte

The team, as a column or drawer on the right. Shown only once the lead has started a helper and the person opened it (or Advanced opened it on a wide screen). No props. There is no map view any more: 0.2.0 deleted `TeamMap.svelte`, `store.view` and "Show as a map"; the outline below is the only team view.

- Header "Team" and × (closes the panel).
- **Width.** On wide screens it is a column, 400 px by default. A separator on its left edge (`role="separator"`, `aria-valuemin` 300, `aria-valuemax` 560) is dragged with the pointer, or moved 20 px at a time with ← (wider) and → (narrower); the width is `ui.teamWidth`, kept per device ([ui.svelte.ts](Source-Web-Front-End.md#simple-and-advanced-uisveltets)). As a drawer the `aside` is `min(400px, 88vw)` wide.
- `CompactProgress` (while the team is being tidied); then, when there is more than one team in Settings, "This chat uses the team “<name>”." (the chat's `profileId`, else the default team; shown in Simple too); then the `TeamOutline`.
- With `mayAct`, a per-chat switch "Tidy this chat's team automatically", which sends `{t:'auto_compact', convId, on}`. It is disabled (and shown off) when the setting "Tidy the team automatically" is off, because the person may only switch tidying off per chat ([Compact team](Compact-Team.md)).
- "Memory used: N%": the lead's context against its window. The tokens and all agents' output are in the tooltip, and shown inline in Advanced.
- `TierControls`, in Advanced and with `mayAct`.

## TeamOutline.svelte

`web/src/lib/team/TeamOutline.svelte`: the team as an outline that scrolls only up and down. No props. The rows come from [`outline.ts`](#outlinets).

- **A tree for assistive technology and the keyboard.** `role="tree"`, each agent a `role="treeitem"` with `aria-level`, `aria-expanded` (parents only) and `aria-selected` (the agent on screen), and its children in a `role="group"`. One tab stop (roving `tabindex`): ↓ and ↑ move, Home and End go to the first and last row, → opens a closed branch or moves into it, ← closes an open branch or goes to the parent, Enter or Space opens the agent's chat (or opens a folded row).
- **Rows.** The expander (or a blank of the same width), status dot, name, a badge with the model, the title (or "Main assistant"), and on a second line `statusWords()`, cut short with an ellipsis if need be, followed for live helpers (not the lead, not paused at a usage limit; `showsTime()`) by their time on it, " · 4 min" ([AgentSpan](#agentspansvelte)), which is never cut. The time is also in the row's `aria-label`. Clicking a row opens that agent's chat. The level's colour appears only on the model badge. Finished and stopped helpers stay and are dimmed by colour (`--muted`, `--faint`), not opacity, so their words keep AA contrast; a failed one's status line is in `--bad`. Live helpers (queued, running, waiting; never the lead) get a `StopControl` at the right.
- **Guide lines.** Neutral 1 px lines in `--border-strong` join each parent to its children, exact to the pixel by construction. An open parent draws its line once, as one 1 px `.vline` in its row: from the pixel under its expander down to where its last child's corner begins. The line's length comes from `guide()`, an action on the children's `role="group"` that reads the last child's `offsetTop` (again whenever a `ResizeObserver` sees the parent or the group change size) into `--vend`. Each child draws only its own `.tick`: a 1 px line from the parent's line to its expander (├), or on towards its dot for a leaf; the last child's tick is a corner with a rounded bend (└) that starts where the line stops. Every position is a whole number of CSS pixels taken from the variables on `.outline`: `--tw` (indent per level and expander column, 20 px; 16 px under 600 px), `--gx` (the line's x, the middle pixel of the 13 px expander, which sits at `--gx` − 6; 9 px, 7 px on phones), `--pad` (the row's top padding, 4 px), `--line` (the first line's fixed height, 24 px to hold the 24 px Stop; 44 px on touch screens), `--bt` (the expander's top in that line, 5 px; 15 px on touch), `--ty` (the tick's y, `--pad` + `--bt` + 6) and `--r` (the corner's radius, 4 px). Text lines have pixel line heights (20 px, and 18 px for the status line and preview), so no row is a fraction of a pixel tall. The browser test checks the joins to the pixel at pixel ratios 1 and 1.5 ([Page tests](Source-Web-Tests.md#browser-test-testuie2emjs)). On phones the job title is hidden.
- **Preview.** Hovering or focusing a row for 300 ms shows, below the row and inside the panel, the agent's task and its last four chat lines (from the last 14 items), plus its live draft; "loading" until the transcript arrives, and a "nothing yet" line when there is nothing to show. If that transcript is not loaded, the preview fetches it and drops it again when it closes (`store.dropItems()`), so hovering across a big team does not keep every transcript in memory. The preview is `aria-hidden`; it never makes the panel scroll sideways.
- **Hide finished.** A checkbox above the tree, `ui.hideFinished`, kept per device and off by default. When on, each parent's finished helpers (done or stopped, with nothing live or failed under them) fold into one row, "N finished: Bravo, Charlie"; clicking it, or Enter, opens that group again. Failed helpers are never folded.
- **Branches.** Closed branches (`ui.collapsed`) and opened folded groups (`ui.openGroups`) are kept while the chat is open and forgotten when another chat is opened (`ui.teamOf()`).
- **Archived helpers.** When a tidy-up archived helpers (`store.archivedAgents`), a row "Archived helpers (M)" under the tree opens a list, newest first: name, model badge, title and "archived <when>". Clicking one opens its chat read-only; with `mayAct`, Restore sends `restore_agent` ([Compact team](Compact-Team.md)). The row's − / + is the same `Expander` as the tree's.

The preview's "Report from", "Message from" and "Thinking…" come from `T.preview`.

## outline.ts

`web/src/lib/team/outline.ts`, pure and tested without a page (`web/test/team-outline.test.ts`).

- `outlineRows(agents, { collapsed, hideFinished, openGroups })`: the rows top to bottom from the lead (depth 1), children in start order (`createdAt`). A collapsed branch's children are left out. With `hideFinished`, each parent's finished helpers (not failed, and with nothing live or failed under them) become one `folded` row after the others, unless the parent's group was opened. A row is `{kind:'agent', agent, depth, hasChildren, expanded, parentId}` or `{kind:'folded', parentId, depth, agents, key}`.
- `outlineTree(agents, opts)`: the same rows as nested nodes, so each parent's children sit in one group for drawing the guides.
- `indent(depth)`: 16 px a level for the first three, then 6 px. It is tested but no longer used by `TeamOutline`, which indents by `--tw`.

## Expander.svelte

`web/src/lib/team/Expander.svelte`: the small − / + box of the outline's branches and of the "Archived helpers" row, so the two cannot differ. Prop: `open`. A 13 px square (border included, so its middle is a whole pixel) with a 1 px `--guide` border and 3 px corners; the − and + are 1 px bars, not text, crossing on the middle pixel, so font metrics cannot move them. `aria-hidden`: the button around it carries the label.

## CompactCard.svelte

`web/src/lib/team/CompactCard.svelte`, in the dock. The tidy-up proposal, shown only when `store.compact` is in phase `proposed`, which happens when automatic tidying is off. A `role="alertdialog"` "Tidy the team?" with "Keep N, archive M", the lead's note if any, and every helper named with its job and a tick to keep it. The proposal's keeps start ticked; helpers that must stay ("Stays: still working, or needed by a helper that stays") are ticked and cannot be unticked; the others show the lead's reason. With `mayAnswer`, "Not now" and "Tidy up" call `store.answerCompact(keep, accept)`. Without it the ticks are disabled and a note says "This device is read only, so it cannot choose. Choose on the computer."

## CompactProgress.svelte

`web/src/lib/team/CompactProgress.svelte`, in the dock and at the top of the team panel. While a tidy-up is asked, archiving or compacting, a `role="status"` line: "Tidying the team: deciding who to keep…", "…archiving finished helpers…" or "Tidying the team… N of M", with Cancel (`store.cancelCompact()`) when `mayAnswer`.

## TierControls.svelte

`web/src/lib/team/TierControls.svelte`, Advanced only. The levels of this chat's team: the profile from `store.conv.profileId`, else the default profile ([tiers.ts](Source-Web-Styles.md#tier-colours-tiersts)). For each level: its label in its colour and "The one you talk to" or "Started by <level above>". Levels after the first get "Helpers at a time" with how many are working and waiting now, and a − / + stepper from 0 ("Off") to `MAX_PER_TIER` (12). Every level gets a "Thinking time" select ("Thinking time up to" when automatic thinking is on).

If the chat's team was removed in Settings but the chat keeps its stored copy (`conv.team`), those levels are shown in their own colours with "This chat’s team was removed in Settings…", and every control is disabled.

A change edits that level inside the profile list and saves it through `store.updateSettings()`; the server takes the whole profile list. The select lists every effort in `EFFORTS` (`low` to `xhigh`), not only those the model offers; the team editor in Settings limits them ([TeamEditor](Source-Web-Settings-and-Remote.md#teameditorsvelte)).

## SettingsMenu.svelte

The ⚙ button at the foot of the chat list (`id="settings-gear"`). It opens the settings view in place of the chat, or closes it if open (`ui.openSettings()` / `ui.closeSettings()`), with `aria-expanded`. The 0.1.x settings popup is gone; the view is on [Settings and remote access](Source-Web-Settings-and-Remote.md#settingsviewsvelte).

## StopControl.svelte

The "Stop ■" that stops a live helper and everything under it. Props: `agent` and `placement` (only `'row'` now). It sends `{t:'stop_agent', convId, agentId}` and renders nothing without `store.mayStop` (any device role but `read`). Since 0.2.1 the word "Stop" is always shown beside the square (before, only on hover, focus or touch); its tooltip is "Stop Bravo and its helpers" and its label "Stop Bravo". On touch screens the target is 44 px. Used by `TeamOutline`.

## FirstRun.svelte

Shown instead of the chat when `store.canRun` is false (no backend reported available and no Claude Code found; [Web store](Source-Web-Store.md#state)). "Masthead needs Claude Code to work", one sentence on why, how to install and sign in (backticks shown as code), "What Masthead saw" (a closed `<details>`) with the Claude Code error if any, and "Reload this page". Its words and the error it shows are about Claude Code only.

## UsageMeter.svelte

The usage line in the sidebar foot: "Usage" and the window closest to its limit ("N% used" or "limit reached"). It opens into every window with a bar, the percent and the reset time, ordered as `T.usage.names` lists them. `utilization` of 1 or less is read as a fraction, because the SDK does not say its scale. Reset times within 20 hours show only the time. A window type not in `T.usage.names` is shown by its type with `_` as spaces. Shown only once usage has been reported (Sidebar checks `store.usage` has a key). Entries that are not objects are dropped (0.2.1); if none is left, the closed line says "not reported yet" (`T.usage.notReported`) in `--faint`.

## AgentSpan.svelte

`web/src/lib/AgentSpan.svelte` (0.2.1): " · 4 min" after what an agent is doing, its time on its current activity, from `progress.span(agentId)` ([Web store](Source-Web-Store.md#progress-without-asking-progressts-progresssveltets)). Prop `agentId`. It renders nothing while the span is empty. It holds the 15 s clock open while mounted (`$effect(() => progress.useClock())`), and only it reads the clock, so a tick redraws nothing else. `white-space: pre` keeps the separator's spaces in a flex row. Used by `TeamOutline` and `StatusLine`.

## AnswerMarker.svelte

`web/src/lib/transcript/AnswerMarker.svelte` (0.2.1), mounted by the `Composer` above the box in an existing chat. A button "? Waiting for your answer" (tooltip "Alpha asked you a question. Show it") when the main assistant's chat is on screen and `openQuestion()` finds a question in it that more items came after and the person has not answered ([progress.ts](Source-Web-Store.md#progress-without-asking-progressts-progresssveltets)). A click calls `progress.showItem(id)`, and `Transcript` scrolls to the question, highlights it and focuses it. It goes as soon as the person writes. Not shown while a helper's chat is open. 44 px tall on touch screens.

## statusWords() and STATUS_LABEL

These moved to `words.ts`; the store re-exports them. See [Text and words](Source-Web-Text.md#wordsts).

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web store](Source-Web-Store.md) · [Text and words](Source-Web-Text.md) · [Images](Source-Web-Images.md) · [Settings and remote access](Source-Web-Settings-and-Remote.md) · [Styles](Source-Web-Styles.md) · [Permissions and questions](Permissions-and-Questions.md)
