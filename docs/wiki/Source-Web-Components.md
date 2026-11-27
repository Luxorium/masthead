# Web components

The Svelte components in `web/src/lib/`, as of Masthead 0.1.3. Each one reads from the shared `store` ([Web store](Source-Web-Store.md)) and sends its actions through it. None of them talks to the socket directly: every message goes out through `store.send()` or a store method that calls it. The overall layout is on [Web front end](Source-Web-Front-End.md).

Agent names are always shown through `displayName()` from `shared/protocol.ts`: "bravo" is shown as "Bravo". Since 0.1.3, agents after Zulu are named `alpha-ii`, `bravo-ii` … and then `alpha-iii` …, and `displayName()` shows them as "Alpha II", "Bravo II". Before 0.1.3 they were `alpha-2` and shown as "Alpha-2".

## Who renders what

`App.svelte` owns the page layout. It calls `store.connect()` on mount, follows `#/c/<id>` hash changes with `store.open()`, and keeps two pieces of its own state, `showSidebar` and `showPanel` (both start hidden on narrow windows: the panel below 1100 px, the sidebar below 760 px). It also handles renaming a conversation (clicking the title sends `{t:'rename'}`; Escape cancels, and the blur that follows does not save).

| Component | Rendered by | Props | When |
|---|---|---|---|
| `Sidebar` | `App.svelte` | `onhide` | While `showSidebar` is on. |
| `SettingsMenu` | `App.svelte`, in the header | none | Always (its popup needs `store.settings`). |
| `Transcript` | `App.svelte` | none | In the chat view. |
| `PermissionCard` | `App.svelte` | `request` | One per `store.convPending` item: above the composer in the chat view, in a dock in the map view. |
| `Composer` | `App.svelte`, inside `{#key store.composerKey}` | none | In the chat view. |
| `TeamMap` | `App.svelte` | none | When `store.view === 'map'` and a conversation is open. |
| `TeamPanel` | `App.svelte` | none | While `showPanel` is on. |
| `FolderPicker` | `Composer` | `onclose` | While the Folder chip is open on a new conversation. |
| `StopControl` | `TeamPanel` and `TeamMap` | `agent`, `placement` | For each live sub-agent. |

`App.svelte` also draws the parts that are not components: the signed-out page (`store.signedOut`, with **Try again** calling `store.retryConnect()`), the Chat / Team map tabs (setting `store.view`, with `store.liveCount` as a badge), the banners (Claude Code error, lost connection, usage limit from `store.rateLimit` with Dismiss), the breadcrumb of `store.pathTo()` with "Back to Alpha" when a sub-agent's chat is open, and the error toast (`store.error`).

## Sidebar.svelte

The left column. Prop: `onhide` (the hide button calls it; `App.svelte` then sets `showSidebar` off). State: `confirming`, the id of the conversation whose delete button is waiting for its second click. It reads `store.conversations`, `store.convId`, `store.pending`, `store.connected` and `store.app`. It shows:

- The brand and a hide button.
- A **New** button (`store.newConversation()`).
- **Recents:** every conversation, in the order the server sends them (newest first). Clicking a row calls `store.open(id)`. Each row has:
  - a "working" dot when `busy` is set;
  - the title;
  - a count of approval requests waiting for an answer;
  - a delete button that asks for a second click within 3 seconds ("Delete?") before sending `{t:'delete'}`.
- A footer with the connection state ("Disconnected" when the socket is closed), the Claude Code version with any trailing "(…)" removed (or "Claude Code not found"), and the Masthead version.

The approval counts come from `store.pending`, which the `state` message fills for every conversation, so they are right after a reload.

Internals: `remove(id)` sets `confirming` on the first click and starts a 3-second timer that clears it only if it still points at the same row; the second click clears it and sends `{t:'delete', convId}`. `waiting(id)` counts `store.pending` items with that `convId`. Labels: the working dot is "Working", the hide button "Hide conversations", each delete button "Delete conversation". An empty list shows "No conversations yet.".

## Transcript.svelte

The chat for the agent being viewed. No props. It reads `store.viewItems`, `store.viewDraft`, `store.viewAgent`, `store.convId`, `store.creating`, `store.settings.collapseReports`, `store.agentList` and `store.childrenOf()`. Its own state: `pinned` (whether the view follows new output) and `open` (which tool lines and inbound items are expanded, by item id). It sends nothing itself; clicking an agent name calls `store.viewOf()`. Markdown goes through `renderMarkdown()` (sanitised with DOMPurify) and code-block copy buttons through `handleCopyClick`, both in `markdown.ts`. How each item kind is drawn:

| Item | Drawn as |
|---|---|
| `user` | A bubble, with "N images attached" when there were images. |
| `text` | Markdown (`renderMarkdown`). |
| `thinking` | A collapsed "Thought" section. |
| `tool` | One line from `toolLine()`, in the present tense while running and the past tense when done, with a running dot and "failed" if it errored. Clicking shows the input and result. |
| `inbound` | "Task from / Report from / Message from" + a clickable agent name that opens that agent's chat. Reports show a non-`done` status. Tasks start collapsed; messages start open. Reports start open, or folded when **Fold agent reports** (`settings.collapseReports`) is on: one line with the name, status and the first ~100 characters, which opens on click or Enter. Opening or closing one is page state only, not saved. |
| `notice` | A small line, red for errors. |

Below the items:

- the live draft: text as Markdown while it streams, or "Thinking… <last 140 characters>";
- otherwise a status line: the activity (only while no tool item is still running, since a running tool line already says what the agent is doing), "Waiting for a free slot…", "Waiting for an answer from Alpha" (when `waitingFor` is set, via `statusWords()`), "Waiting on N agents" (its live children), or plain "Waiting" (for example a command still running in the background);
- "Starting…" while a new conversation is being created.

The view follows new output only while the reader is near the bottom (within 80 px). When the reader has scrolled up, a ↓ button jumps back down. Opening another agent or conversation sets `pinned` again, so it starts at the bottom. On the new-conversation screen it shows "What are we working on?"; an empty chat of an agent that is not running or queued shows "Nothing here yet."

Internals:

- **Auto-scroll:** `onScroll()` sets `pinned` when the bottom is within 80 px. An effect that tracks the item count, the draft text and the agent's id and status scrolls to the bottom after `tick()`, only while `pinned`. `toBottom()` is the ↓ button (`aria-label="Jump to latest"`).
- **`startsOpen(item)`:** tasks start shut; reports start shut when `collapseReports` is on; the rest start open. Once clicked, `open[item.id]` wins over it.
- **`firstWords(text, 100)`:** removes Markdown marks (`#`, `*`, `_`, backticks, `>`, brackets), squeezes white space and cuts at 100 characters with "…". It is the folded report's one-line gist.
- **`openAgent(name)`** finds the agent in `store.agentList` by name and calls `store.viewOf()`.
- **`pretty(value)`** shows a tool input as is when it is a string, else as indented JSON; an empty result shows "(empty)".
- A report's non-`done` status is `STATUS_LABEL` in lower case. Tool lines and the inbound Show/Hide toggles carry `aria-expanded`.

## Composer.svelte

The message box. No props. It reads `store.composerKey` once, when it is created, and keeps that conversation's and agent's draft from `store.composerFor(key)`; it also reads `store.viewAgent`, `store.lead`, `store.liveCount`, `store.conv`, `store.newCwd`, `store.settings`, `store.app` and `store.connected`. Its own state: `choosingFolder` (the FolderPicker is open) and `dragging` (a file is over the box). It renders `FolderPicker`.

| Action | What it calls |
|---|---|
| Send | `store.sendMessage(key)`, which sends `{t:'send'}` (with `cwd` for a new conversation, `agentId` for a sub-agent's chat) |
| ■ Stop this turn | `store.send({t:'interrupt'})` |
| Stop everything | `store.send({t:'stop_all'})` |
| A rejected image | `store.fail(message)`, which shows the toast |

It has:

- **Text:** Enter sends, Shift+Enter adds a new line (not while an input method is composing). The box grows up to 260 px.
- **Waiting hint (0.1.2):** when the open sub-agent is waiting for an answer (`status: 'waiting'` with `waitingFor`), a quiet line above the box reads "Bravo is waiting for an answer from Alpha. What you send here reaches it as that answer." On the server, a message the person sends to an agent ends that agent's wait (`clearWait` in `Conversation.userSend`).
- **Placeholder** text that says where the message goes:
  - "Ask for anything" on a new conversation;
  - "Message Bravo directly" when a sub-agent's chat is open;
  - "Add to what Alpha is doing" while the lead is running;
  - otherwise "Reply to Alpha".
- **Images:** a + button, paste, or drag and drop. Only PNG, JPEG, GIF and WebP are accepted: at most 5 MB each, 8 per message and 30 MB in total (base64 adds a third, which keeps a message under the server's 48 MB socket limit). Both limits are checked again after each file is read, since another paste may have added images meanwhile. Each has a thumbnail and a remove button. They are read as base64 and sent as `ImageAttachment`s.
- **Send / Stop:** while the lead is running, the lead's chat is open and the box is empty (no text, no images), the button becomes ■ and sends `{t:'interrupt'}`. In a sub-agent's chat it stays a send button. Send is disabled when there is nothing to send, when disconnected, while creating, or when Claude Code was not found.
- **Under the box:**
  - on a new conversation, the **Folder** chip, which opens the folder picker;
  - in an existing conversation, its working folder, shown plainly (not clickable);
  - while agents are live, **Stop everything** (`{t:'stop_all'}`);
  - on the right, the model and effort of the agent being addressed (with "· auto" for the lead under automatic effort) and the permission mode in short words ("Claude settings", "Ask first", "Accept edits", "Auto", "Bypass"). Before the lead exists, its effort shows as Low under automatic effort, or else the configured lead effort.
- **Drafts:** the text and images live in `store.composer`, one draft per conversation and agent. `App.svelte` rebuilds the component in a `{#key}` block when either changes, and the box takes focus then.
- **Sending:** the box empties at once, but the store keeps a copy until the server accepts the message, and puts it back if the server refuses it or the connection drops first (unless something new has been typed). If the socket is not open, nothing is sent and the box is kept.

Internals:

- **`resize()`** sets the box's height to its content, capped at 260 px; an effect runs it on every text change. Another effect focuses the box on mount.
- **`addFiles(files)`** goes file by file: a wrong type is refused and the next file tried; over 5 MB, refused; at 8 images the whole loop stops (`break`); over 30 MB in total, that file is refused. The file is read with `FileReader` as a data URL and only the base64 part kept. After the read the count and total are checked again. Each refusal goes to `store.fail()`. Each image keeps an object URL for its thumbnail; `removeImage()` revokes it.
- **Paste** takes only clipboard files whose type starts with `image/`, and only then blocks the normal paste. **Drop** passes every file to `addFiles`, which refuses non-images.
- **Accessibility:** the box sits in `role="group"` labelled "Message"; buttons are labelled "Attach images", "Send", "Stop this turn" and "Remove image"; thumbnails use the file name as `alt`. The drag highlight and the growing box were not checked in a browser.

## FolderPicker.svelte

A small dialog for choosing a new conversation's folder. Rendered only by `Composer`, under the Folder chip, on the new-conversation screen. Prop: `onclose`, which the Composer uses to set `choosingFolder` off. State: `typed`, the text in the path field; it starts as `store.newCwd` and follows each listing that arrives.

| Action | What it does |
|---|---|
| Opening | Sets `store.dirs = null`, then sends `{t:'dirs', path: store.newCwd}` |
| Submitting the path field | Sends `{t:'dirs', path: typed}` |
| Clicking a sub-folder | Sends `{t:'dirs'}` for that path (no double slash under `/`) |
| "‹ Up to …" | Sends `{t:'dirs'}` for `store.dirs.parent` (shown only when there is a parent) |
| **Use this folder** | Sets `store.newCwd = store.dirs.path` and calls `onclose()` |
| Cancel | Calls `onclose()`; `store.newCwd` is unchanged |

The server's answer arrives as a `dirs` message, which the store puts in `store.dirs`. Clearing `store.dirs` on opening matters: a listing from the last time the picker was open must never be shown or chosen. **Use this folder** is disabled until a listing has arrived and while it shows an error, and `choose()` checks the same again. A folder with no sub-folders shows "No folders inside." Hidden folders are not listed (the server leaves them out). Only browsing goes through the picker; the folder is used when the first message is sent (`cwd` in `{t:'send'}`).

## PermissionCard.svelte

One approval request or question. Prop: `request` (a `PermissionRequest`; `request.kind === 'question'` marks an `AskUserQuestion` question). State: `picked` (the options chosen, per question index), `other` (the "Something else…" text, per question index), `showDetail`, and `card` (the element, for focus). A module-level `lastKey` records when any key was last pressed anywhere on the page (one capture listener on `window`, shared by every card). It reads nothing from the store except to answer through it. Both kinds name the asking agent, also in the card's accessible label ("Question from Bravo" / "Permission request from Bravo"); the card has `role="alertdialog"`.

Every button answers through `store.answer(requestId, decision, answers?)`, which sends `{t:'permission', requestId, decision, answers}` and removes the card from `store.pending` only if the send went through. If the socket is closed the card stays and the "Not connected" toast shows. Other open tabs lose the card when the server sends `permission_resolved` (not verified by running).

| Button | Decision sent |
|---|---|
| Allow | `allow` |
| Always allow | `always` ("Allow, and stop asking for this in this session"); only when `request.canAlways` |
| Deny | `deny` |
| Answer (question) | `allow`, with `answers` |
| Skip (question) | `deny` |

- **Focus:** a new card takes focus so the keyboard can reach it, unless the person is typing: a key pressed in the last 1.5 seconds, text in the field they are in, or focus already on another card. Focus goes to the card itself (outlined), not to Allow, so a stray Enter answers nothing.

- **Permission card:** the agent's name and Claude Code's title, or else a fixed phrase for common tools ("wants to run a command", "wants to write a file", "wants to edit a file", "wants to edit a notebook", "wants to read a file", "wants to fetch a web page", "wants to search the web"), or "wants to use <tool>" for any other (an MCP tool's `mcp__` prefix removed and `__` shown as " · "), with the target from `toolLine()` underneath when there is no title. A shell command is shown in full; other input sits behind "Show details". Then Claude Code's description, and the buttons Deny / Always allow (only if `canAlways`) / Allow.
- **Question card:** "<Agent> asks", then option buttons for each question (one choice, or several; keyed by position, so repeated labels do not break the list), plus a "Something else…" field. Picking a single-choice option replaces the earlier pick and clears that field; typing in the field clears a single-choice pick, so the two never both count. Multi-select options toggle. **Answer** is disabled until every question has a pick or typed text; it sends an `answers` object keyed by each question's text, with the choices and typed text joined with ", ". **Skip** sends `deny`.

Cards appear above the message box in the chat view, and in a dock at the bottom of the team map view. See [Permissions and questions](Permissions-and-Questions.md).

Internals: `onMount` reads `document.activeElement` and skips focus when `lastKey` is under 1.5 s old, when the focused input or textarea holds non-blank text (or a content-editable element has focus), or when focus is inside another `.card[role="alertdialog"]`; otherwise it calls `card.focus({preventScroll: true})`. `lastKey` is module-level so one listener serves all cards. `wants` comes from the `WANTS` table; `detail` is the `command` string when the input has one, else indented JSON, and `isCommand` picks between the always-shown command and "Show details". Each question is a `fieldset` with its text as `legend`; options carry `aria-pressed`. The focus outline was not checked in a browser.

## TeamPanel.svelte

The right column: the tier limits, usage, and an overview of the open conversation. App-wide preferences are in the settings menu (below). No props and no state of its own beyond derived values. It reads `store.settings`, `store.usage`, `store.agentList`, `store.lead`, `store.childrenOf()`, `store.viewAgent`, `store.conv` and `store.app.home`. It calls `store.updateSettings()` for the steppers and effort selectors, `store.viewOf()` when an agent is clicked, sets `store.view = 'map'` for "Open map", and renders `StopControl` for live sub-agents. Context, Agents and Folder appear only when a conversation is open and its lead exists.

- **Team:**
  - One block per tier, headed by `modelLabel()` of its model and "Started by …".
  - For Opus, Sonnet and Haiku, an "At once" stepper from 0 ("Off") to 12, with "· N now" when agents of that tier are running or waiting. That count covers only the open conversation, while the limit is app-wide.
  - For every tier, an effort selector labelled "Effort up to" (automatic effort) or "Effort".
- A warning line when permissions are set to bypass.
- Every change goes through `store.updateSettings()`, which sends the whole settings object.
- **Usage:** always shown. One row per usage window in `store.usage`, in a fixed order, named for Claude Code's `rateLimitType`: "Current session (5 hours)" (`five_hour`), "Weekly, all models" (`seven_day`), "Weekly, Opus", "Weekly, Sonnet", "Weekly, with extra usage", "Extra usage"; unknown types show their own name. Each has "N% used" and a bar when `utilization` is reported (the bar turns amber unless the status is `allowed`), "limit reached" when rejected, and "Resets <time>" from `resetsAt`. `sdk.d.ts` does not give the scale of `utilization`, so a value of 1 or less is read as a fraction. Before any notice: "No usage reported yet; it appears once an agent has run."
- **Context:** a bar showing the lead's context use (`usage.context / usage.contextMax`) and the total output of all agents.
- **Agents:** while only the lead exists, "Only the lead so far…". Otherwise the lead and an indented tree of every agent (a recursive `branch` snippet over `store.childrenOf()`), each with:
  - a status dot, its name, a short model badge and its title (the task as a tooltip);
  - its activity or status, from `statusWords()` (so a waiting agent reads "Waiting for an answer from Alpha");
  - for sub-agents, the shared stop button while queued, running or waiting (see StopControl below). The lead's row has none; the Composer's ■ and Stop everything cover it.

  Clicking an agent opens its chat. "Open map" (shown once there are sub-agents) switches to the team map.
- **Folder:** the conversation's working folder.

The +/− buttons' accessible labels use the fixed `TIER_LABEL` names ("More Opus 5.5 agents"), not the configured model names. `test/ui.e2e.mjs` finds the buttons by those labels.

Internals:

- **`under(tier, s)`:** "The one you talk to" for the lead, "Started by <first word of the lead's model>" for Opus, "Started by <Opus/Sonnet> agents" below that.
- **`step(tier, by)`** clamps `max` between 0 and `MAX_PER_TIER`; the − and + buttons are disabled at the ends, and the value is an `<output aria-live="polite">`.
- **`running(tier)`** counts the open conversation's agents of that tier that are running or waiting; queued ones are not counted.
- **`limits`** is `store.usage` sorted by `LIMIT_ORDER`, unknown types last. **`limitName()`** uses `LIMIT_NAME`, else the raw type with `_` as spaces, or "Usage limit" without a type.
- **`percent()`** returns null unless `utilization` is a finite number, multiplies values of 1 or less by 100, then rounds and clamps to 0–100.
- **`resets()`** turns `resetsAt` (seconds) into local time: the time only when under 20 hours away, else weekday and time.
- **Context:** `pct` is capped at 100; `totalOut` sums every agent's `usage.output`; token counts use `fmtTokens()`. Both bars are `role="progressbar"` with `aria-valuenow` and a label.

## SettingsMenu.svelte

The ⚙ button at the top right of the header and the popup it opens. Rendered by `App.svelte` in the header; no props. State: `open`, plus the `gear` and `panel` elements for focus and outside clicks. It reads `store.settings` (the popup is drawn only once settings have arrived), `store.app.version`, `store.app.claude` and `store.app.home`.

Every control changes one field of the settings through `store.updateSettings(change)`. That clones the current settings, applies the change, sets `store.settings` at once and sends the whole object as `{t:'settings', settings}`. The server answers with a `settings` message to every tab (not verified by running). There is no Save button; each change is saved as it is made.

| Control | Setting | What it means (the control's own text) |
|---|---|---|
| **Permissions** select | `permissionMode` | One of `PERMISSION_CHOICES`: "Use my Claude Code settings" (`inherit`), "Ask me first" (`default`), "Accept file edits, ask for the rest" (`acceptEdits`), "Auto (a classifier decides)" (`auto`), "Bypass all checks" (`bypassPermissions`). Bypass adds a warning: "Every agent can run any command and change any file without asking." |
| **Automatic effort** | `autoEffort` | "Everyone starts at Low. The lead raises its own; the others ask the agent above them." The team panel's effort selectors then read "Effort up to". |
| **Lean Opus** | `leanOpus` | "Opus agents skip your connected services too." |
| **Lean Sonnet and Haiku** | `leanSubagents` | "They skip your connected services, which keeps their context small." |
| **Fold agent reports** | `collapseReports` | "Reports show as one line in a chat until you open them." Read by `Transcript.startsOpen()`; it changes only how reports first appear, not reports already opened or closed on the page. |

Below the controls: the Masthead version, and Claude Code's version and path (shortened with `~`), or "Claude Code not found" with the reason.

Clicking the gear (or Enter or Space on it) opens the popup and moves focus to its first control; Escape closes it and returns focus to the gear; a pointer press outside the popup and gear closes it without moving focus. The tier limits and per-tier effort are not here; they are in the team panel.

Internals: `toggle()` flips `open` and, when opening, waits a `tick()` and focuses the first `select`, `input` or `button` in the panel. `close(refocus)` does nothing when already shut and returns focus to the gear only when asked (Escape asks; an outside click does not). Both listeners sit on `<svelte:window>`: `onkeydown` handles Escape (with `preventDefault`), `onpointerdown` closes on a press outside both the panel and the gear. The gear has `aria-label="Settings"`, `aria-haspopup="dialog"` and `aria-expanded`; the popup is `role="dialog"` labelled "Settings". Placement and look were not checked in a browser.

## StopControl.svelte

The ■ that stops a live sub-agent and everything under it. Added in 0.1.2; before that the team panel and the team map each drew their own ■ button. Both now render this one component, so the two cannot drift.

- **Props:** `agent` (an `AgentInfo`) and `placement`: `'row'` sits in the team panel's flex row; `'map'` is absolutely placed in the card's bottom-right corner.
- **State:** none.
- **Store:** reads `store.convId`. Pressing it sends `{t:'stop_agent', convId, agentId}` through `store.send()`, and nothing when no conversation is open. The server's `Conversation.stopAgent()` stops that agent and its whole subtree.
- **Who shows it:** the parents decide. Both render it only while the agent is queued, running or waiting; the team map also checks it is not the lead, and the panel never draws it on the lead's row. So the button never stops the lead.
- **Why it is "safe":** it asks for no confirmation. Instead it is hard to press by mistake for what it is: the square is in the normal text colour at 80 % opacity (it was muted and smaller in 0.1.1), and on hover or keyboard focus it turns red and shows the word **Stop** beside it, so the square is never a mystery. That hover background is opaque, so the word does not sit on top of the card's text. Title "Stop this agent and everything under it"; accessible name "Stop <Name>". In the map it sits outside the card's open button, so pressing it does not also open the chat.

## TeamMap.svelte

The "Team map" tab: the whole team as a tree, built recursively with a Svelte snippet from `store.lead` and `childrenOf()`. No props. State: `now` (a clock updated every second, for elapsed times), `previewId` (the card whose preview is open), and two plain variables, `hoverTimer` and `fetchedFor`. It reads `store.lead`, `store.agentList`, `store.items` and `store.drafts`; it calls `store.viewOf()`, `store.loadItems()` and `store.dropItems()`, and renders `StopControl`. Permission cards in this view are drawn by `App.svelte`, not by the map. Each agent is a card showing:

- its status dot, its name ("Bravo") and a model badge;
- its title (for the lead, "The one you talk to");
- what it is doing, from `statusWords()`: the activity line while running, "Waiting for an answer from …", "Failed: …" with the error, or the status words;
- its effort, context size and, for sub-agents, the time since it started (ticking every second until it ends; then the time it ran, from `endedAt`).

Live sub-agents have the shared stop button in the card's corner. Clicking a card opens that agent's chat (`store.viewOf()`).

**Hover preview:** resting on a card for 220 ms (or keeping keyboard focus on it for 220 ms) loads that agent's transcript if needed. A transcript fetched only for a preview is dropped again when the preview closes, unless that agent's chat is the one open. It then shows a tooltip with:

- its task, up to 260 characters;
- "Loading…" until the transcript arrives; then the last six lines of its chat (the person's messages, its text, tool lines, reports and messages from others, notices; thinking is left out);
- its live draft;
- "Click to open the chat".

The `task` item is left out of those lines because the task is already shown at the top. When only the lead exists, a hint explains that started agents will appear under it.

Internals:

- **`elapsed(a)`** uses `endedAt` when set, else `now`, and shows "42s", "3m 5s" or "1h 2m". The `now` interval is cleared on unmount.
- **`enter(id)`** (mouse enter on the card, or focus on its button) restarts a 220 ms timer. When it fires it calls `forget()`, sets `previewId`, and if `store.items` has no transcript for that agent, records it in `fetchedFor` and calls `store.loadItems()` (which sends `{t:'items'}`).
- **`leave()`** (mouse leave, or blur) cancels the timer, hides the preview and calls `forget()`.
- **`forget()`** calls `store.dropItems(fetchedFor)`. The store keeps the transcript if that agent is the one being viewed, so clicking a card does not lose it.
- **`previewLines(a)`** returns null ("Loading…") until the transcript is there. It looks at the last 14 items, skips thinking and task items, shortens each with `flat()` (160 characters for the person's messages, 220 for text, 110 for tool lines, 140 for inbound, 120 for notices) and keeps the last six. With no lines and no draft it shows "Nothing yet.". The draft line is the last 220 characters of `store.drafts[a.id]`.
- **Accessibility:** each card's button is labelled "Open <Name>'s chat"; the preview is `role="tooltip"`. The tree layout and preview position were not checked in a browser.

## statusWords() and STATUS_LABEL

Not a component, but every component that says what an agent is doing uses it. `statusWords(agent)` in `store.svelte.ts` (added in 0.1.2) gives one line:

| Agent | Words |
|---|---|
| `waiting` with `waitingFor` | "Waiting for an answer from Alpha" |
| `running` | its `activity`, or "Working" |
| `failed` | "Failed: <error>", or "Failed" |
| anything else | `STATUS_LABEL`: Queued, Waiting, Idle, Done, Stopped |

The team panel, the team map and the transcript's status line all use it, so a new sub-state of a status needs one new line here only. In 0.1.1 `STATUS_LABEL.waiting` was "Waiting on its agents"; it is now plain "Waiting", because an agent also waits on a command it left running in the background. `waitingFor` (added to `AgentInfo` in 0.1.2) is the name of the agent a sub-agent asked a question of with `send_message` and `wait: true`. The server sets it only when that is the agent's parent or the lead, and clears it when the answer comes, including when the person messages the waiting agent directly.

## What changed in 0.1.2 and 0.1.3

- **0.1.2:** the shared `StopControl` replaced the two separate ■ buttons and made the button easier to see; `statusWords()` replaced each component's own status text; the "waiting for an answer" state (`AgentInfo.waitingFor`) shows in the team panel, the team map, the transcript and, as a hint, above the composer.
- **0.1.3:** agent names after Zulu use Roman numerals (`alpha-ii`, shown "Alpha II") instead of `alpha-2`. The components did not change; they show names through `displayName()`.

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web store](Source-Web-Store.md) · [shared/toolline.ts](Source-Shared-Toolline.md)
