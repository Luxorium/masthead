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
│  ├─ TeamMap ─ StopControl          (map view)
│  ├─ Transcript ─ UserItem, TextItem, ThinkingItem, ToolItem, InboundItem,
│  │               NoticeItem, DraftView, StatusLine; Thumbs ─ ImageViewer
│  └─ dock: DeviceRequestCard, PermissionCard, Composer ─ FolderPicker, ProfileChip
└─ TeamPanel ─ StopControl, TierControls
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
- **Nothing yet:** "Nothing here yet." when an idle agent has no items.
- **Windowing:** only the newest 80 items are rendered. "Show earlier (N more items)" adds 80 and keeps the scroll position; when all loaded items are shown and the server has older ones (`store.pages[id].more`), the same button asks for the next page ("Show earlier"). It is disabled while a page loads. See [Rendering speed](Source-Web-Front-End.md#rendering-speed).
- **Items:** each in a wrapper with `content-visibility: auto`, except tool lines. The kinds are rendered by the components under [Transcript items](#transcript-items).
- **Draft and status:** `DraftView` while a draft exists, else `StatusLine`. "Starting…" while a new chat is being created.
- **Scrolling:** the view follows new output only while the reader is within 80 px of the bottom (`pinned`). A ↓ "Jump to latest" button shows otherwise. Opening another chat or agent pins again and resets the window. A picture that finishes loading keeps the view at the bottom; image `load` events do not bubble, so this listens in the capture phase.
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
- **`StatusLine.svelte`:** props `agent` and `toolRunning`. What the agent is doing when there is no draft: paused (usage limit), working (its `activity`, or "Working…"; hidden while a tool line is already running), "Waiting its turn…", or waiting: for a named agent, "Waiting for N helpers", or the status words.

## Composer.svelte

The message box, in the dock. App remounts it (inside `{#key store.composerKey}`) when the chat or the agent on screen changes, so each keeps its own text and pictures in `store.composer`. No props.

- **Who it talks to.** New chat: "Ask for anything". The lead: "Reply to Alpha", or "Add to what Alpha is doing" while it runs. A helper on screen: "Message Bravo directly, not Alpha", with a line above, in the helper's colour: "To **Bravo** · <model>" and "Back to Alpha". If that helper is waiting for an answer, a hint says that what is sent here answers it.
- **Sending.** Enter sends (not during IME composition), Shift+Enter is a new line. Send is enabled when there is text or a picture, no picture is uploading or failed, the socket is connected, no new chat is being created, and a backend can run. The textarea (`id="message"`, the skip link's target) grows up to 260 px and takes focus on mount.
- **Stop.** While the lead runs and the box is empty, ■ replaces ↑ and sends `{t:'interrupt'}`. Under the box, "Stop all" (`{t:'stop_all'}`) shows while any helper is live.
- **Pictures.** + opens a file picker; paste and drop work too. Checks, shrinking and upload: [Images](Source-Web-Images.md#attaching-pictures-composersvelte).
- **Under the box, new chat:** the folder chip ("Folder ~/projects/x"), which opens `FolderPicker`; the team chip `ProfileChip`, only when more than one team can start now; and on the very first chat, "Agents can read and change files in this folder."
- **Under the box, existing chat:** the folder as a static chip (full path in its tooltip), and Stop all.
- **Advanced only:** the model that will answer, its thinking time, and the short "when to ask" mode. For a chat without a lead yet it reads the first level of the chat's (or default) profile.

## FolderPicker.svelte

The folder chooser for a new chat, a small `role="dialog"` over the composer. Prop `onclose`. On mount it clears `store.dirs` (an old listing must not be shown or chosen) and sends `{t:'dirs', path: store.newCwd}`. A path field (Enter lists it), "‹ Up to …", the subfolders (each lists itself on click), and Cancel / "Use this folder", which sets `store.newCwd`. On Windows the server uses the sentinel `drives:` for the list of drives; the picker shows it as "Drives" and cannot choose it. Child paths use the parent's own separator (`childPath()` in `words.ts`).

Its words ("Choose a folder", "Up to", "No folders inside.", "Cancel", "Use this folder") are written in the component, not in `text.ts`.

## PermissionCard.svelte

One approval request, in the dock. Prop `request` (a `PermissionRequest`). It is a `role="alertdialog"` card.

- **Focus.** A module-level listener records the last key press. On mount the card takes focus unless a key was pressed in the last 1.5 s, the focused field has text, or another card has focus. It focuses the card, not Allow, so a stray Enter answers nothing.
- **Questions** (`kind === 'question'`): each question as a fieldset with its options as toggle buttons (one or many) and a "Something else…" field. Typing in that field clears the picks of a single-choice question. Answer is enabled once every question has an answer; "Don't answer" sends `deny`. Answers are keyed by question text, as Claude Code's AskUserQuestion expects; two questions with the same text share one entry, with both answers joined by " | ".
- **Permissions:** "Bravo wants to run a command" (or the request's `title`), the command in full, or the target with Show details for other tools; the description; Deny, "Allow for this session" (only if `canAlways`), Allow.

The "wants to …" phrases per tool (`WANTS`) are written in the component, not in `text.ts`.

## TeamPanel.svelte

The team, as a column or drawer on the right. Shown only once the lead has started a helper and the person opened it (or Advanced opened it on a wide screen). No props.

- Header "Team", "Show as a map" (not on narrow screens) or "Back to the chat", and × (closes and returns to the chat view).
- The tree: the lead, then each agent's children indented 14 px per level. A row shows the status dot, name, a badge with the model in the agent's tier colour, its title (or "Main assistant"), and `statusWords()`. Clicking opens that agent's chat. Live helpers get a `StopControl`.
- "Memory used: N%": the lead's context against its window. The tokens and all agents' output are in the tooltip, and shown inline in Advanced.
- `TierControls`, in Advanced and with `mayAct`.

## TierControls.svelte

`web/src/lib/team/TierControls.svelte`, Advanced only. The levels of this chat's team: the profile from `store.conv.profileId`, else the default profile ([tiers.ts](Source-Web-Styles.md#tier-colours-tiersts)). For each level: its label in its colour and "The one you talk to" or "Started by <level above>". Levels after the first get "Helpers at a time" with how many are working and waiting now, and a − / + stepper from 0 ("Off") to `MAX_PER_TIER` (12). Every level gets a "Thinking time" select ("Thinking time up to" when automatic thinking is on).

A change edits that level inside the profile list and saves it through `store.updateSettings()`; the server takes the whole profile list. The select lists every effort, not only those the model offers; the team editor in Settings limits them ([TeamEditor](Source-Web-Settings-and-Remote.md#teameditorsvelte)).

## SettingsMenu.svelte

The ⚙ button at the foot of the chat list (`id="settings-gear"`). It opens the settings view in place of the chat, or closes it if open (`ui.openSettings()` / `ui.closeSettings()`), with `aria-expanded`. The 0.1.x settings popup is gone; the view is on [Settings and remote access](Source-Web-Settings-and-Remote.md#settingsviewsvelte).

## StopControl.svelte

The ■ that stops a live helper and everything under it. Props: `agent` and `placement` (`'map'` or `'row'`). It sends `{t:'stop_agent', convId, agentId}` and renders nothing without `store.mayAct`. The word "Stop" appears on hover and keyboard focus; on touch screens it is always shown in a row, with a 44 px target (not checked in a browser). Used by `TeamPanel` and `TeamMap`.

## TeamMap.svelte

The team as a tree of cards, in place of the transcript (`store.view === 'map'`, wide enough screens only). No props.

- Each card: status dot, name, model badge in the tier colour, title (or "Main assistant"), what it is doing (`statusWords`), and "<thinking time> thinking · <tokens> memory · <elapsed>". Elapsed time ticks every second for helpers. Clicking opens the agent's chat; live helpers have a Stop.
- **Preview.** Hovering or focusing a card for 220 ms shows a tooltip with the task and the last six lines of the agent's chat, plus its live draft. If that transcript is not loaded, the preview fetches it and drops it again when it closes (`store.dropItems()`), so hovering across a big team does not keep every transcript in memory.
- With only the lead: a hint that helpers will appear under it.

Some words here are written in the component, not in `text.ts`: "thinking", "memory", "Report from", "Message from", "Thinking…", and the only-the-lead hint.

## FirstRun.svelte

Shown instead of the chat when `store.canRun` is false. "Masthead needs Claude Code to work", one sentence on why, how to install and sign in (backticks shown as code), "What Masthead saw" with the server's error if any, and "Reload this page". It reads only the Claude Code info, not the other backends ([Web store](Source-Web-Store.md#state)).

## UsageMeter.svelte

The usage line in the sidebar foot: "Usage" and the window closest to its limit ("N% used" or "limit reached"). It opens into every window with a bar, the percent and the reset time, ordered as `T.usage.names` lists them. `utilization` of 1 or less is read as a fraction, because the SDK does not say its scale. Reset times within 20 hours show only the time. Shown only once usage has been reported.

## statusWords() and STATUS_LABEL

These moved to `words.ts`; the store re-exports them. See [Text and words](Source-Web-Text.md#wordsts).

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web store](Source-Web-Store.md) · [Text and words](Source-Web-Text.md) · [Images](Source-Web-Images.md) · [Settings and remote access](Source-Web-Settings-and-Remote.md) · [Styles](Source-Web-Styles.md) · [Permissions and questions](Permissions-and-Questions.md)
