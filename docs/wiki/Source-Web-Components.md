# Web components

The Svelte components in `web/src/lib/`. Each one reads from the shared `store` ([Web store](Source-Web-Store.md)) and sends its actions through it. The overall layout is on [Web front end](Source-Web-Front-End.md).

## Sidebar.svelte

The left column. It shows:

- The brand and a hide button.
- A **New** button (`store.newConversation()`).
- **Recents:** every conversation, newest first. Each row has:
  - a "working" dot when `busy` is set;
  - the title;
  - a count of approval requests waiting for an answer;
  - a delete button that asks for a second click within 3 seconds ("Delete?") before sending `{t:'delete'}`.
- A footer with the connection state, the Claude Code version (or "Claude Code not found"), and the Masthead version.

The approval counts come from `store.pending`, which the `state` message fills for every conversation, so they are right after a reload.

## Transcript.svelte

The chat for the agent being viewed (`store.viewItems`). How each item kind is drawn:

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
- otherwise a status line: the activity (only while no tool item is still running, since a running tool line already says what the agent is doing), "Waiting for a free slot…", "Waiting for an answer from Alpha" (`waitingFor`), "Waiting on N agents", or plain "Waiting" (for example a command still running in the background);
- "Starting…" while a new conversation is being created.

The view follows new output only while the reader is near the bottom (within 80 px). When the reader has scrolled up, a ↓ button jumps back down. On the new-conversation screen it shows "What are we working on?".

## Composer.svelte

The message box. It has:

- **Text:** Enter sends, Shift+Enter adds a new line. The box grows up to 260 px.
- **Waiting hint:** when the open sub-agent is waiting for an answer (`status: 'waiting'` with `waitingFor`), a quiet line above the box says so and that what you send there answers it.
- **Placeholder** text that says where the message goes:
  - "Ask for anything" on a new conversation;
  - "Message Bravo directly" when a sub-agent's chat is open;
  - "Add to what Alpha is doing" while the lead is running;
  - otherwise "Reply to Alpha".
- **Images:** a + button, paste, or drag and drop. Only PNG, JPEG, GIF and WebP are accepted: at most 5 MB each, 8 per message and 30 MB in total (base64 adds a third, which keeps a message under the server's 48 MB socket limit). Both limits are checked again after each file is read, since another paste may have added images meanwhile. Each has a thumbnail and a remove button. They are read as base64 and sent as `ImageAttachment`s.
- **Send / Stop:** while the lead is running and the box is empty, the button becomes ■ and sends `{t:'interrupt'}`. Send is disabled when there is nothing to send, when disconnected, while creating, or when Claude Code was not found.
- **Under the box:**
  - on a new conversation, the **Folder** chip, which opens the folder picker;
  - in an existing conversation, its working folder, shown plainly (not clickable);
  - while agents are live, **Stop everything** (`{t:'stop_all'}`);
  - on the right, the model and effort of the agent being addressed (with "· auto" for the lead under automatic effort) and the permission mode.
- **Drafts:** the text and images live in `store.composer`, one draft per conversation and agent. `App.svelte` rebuilds the component in a `{#key}` block when either changes, and the box takes focus then.
- **Sending:** the box empties at once, but the store keeps a copy until the server accepts the message, and puts it back if the server refuses it or the connection drops first (unless something new has been typed). If the socket is not open, nothing is sent and the box is kept.

## FolderPicker.svelte

A small dialog for choosing a new conversation's folder. On opening it clears the previous listing, so an old one is never shown or chosen, and asks the server for a listing (`{t:'dirs'}`). A path can be typed and submitted, a sub-folder clicked, or "Up to …" used to go up. **Use this folder** sets `store.newCwd`; it is disabled while the listing shows an error. Hidden folders are not listed (the server leaves them out).

## PermissionCard.svelte

One approval request or question. Both kinds name the asking agent, also in the card's accessible label.

- **Focus:** a new card takes focus so the keyboard can reach it, unless the person is typing: a key pressed in the last 1.5 seconds, text in the field they are in, or focus already on another card. Focus goes to the card itself (outlined), not to Allow, so a stray Enter answers nothing.

- **Permission card:** the agent's name and Claude Code's title, or else a fixed phrase for common tools ("wants to run a command", "wants to write a file", "wants to edit a file", "wants to edit a notebook", "wants to read a file", "wants to fetch a web page", "wants to search the web"), or "wants to use <tool>" for any other (an MCP tool's `mcp__` prefix removed and `__` shown as " · "), with the target from `toolLine()` underneath when there is no title. A shell command is shown in full; other input sits behind "Show details". Then Claude Code's description, and the buttons Deny / Always allow (only if `canAlways`) / Allow.
- **Question card:** "<Agent> asks", then option buttons for each question (one choice, or several; keyed by position, so repeated labels do not break the list), plus a "Something else…" field. Typing in that field clears a single-choice pick. **Answer** sends each question's choices and typed text joined with ", ". **Skip** sends `deny`.

Cards appear above the message box in the chat view, and in a dock at the bottom of the team map view. See [Permissions and questions](Permissions-and-Questions.md).

## TeamPanel.svelte

The right column: the tier limits, usage, and an overview of the open conversation. App-wide preferences are in the settings menu (below).

- **Team:**
  - One block per tier, headed by `modelLabel()` of its model and "Started by …".
  - For Opus, Sonnet and Haiku, an "At once" stepper from 0 ("Off") to 12, with "· N now" when agents of that tier are running or waiting. That count covers only the open conversation, while the limit is app-wide.
  - For every tier, an effort selector labelled "Effort up to" (automatic effort) or "Effort".
- A warning line when permissions are set to bypass.
- Every change goes through `store.updateSettings()`, which sends the whole settings object.
- **Usage:** always shown. One row per usage window in `store.usage`, in a fixed order, named for Claude Code's `rateLimitType`: "Current session (5 hours)" (`five_hour`), "Weekly, all models" (`seven_day`), "Weekly, Opus", "Weekly, Sonnet", "Weekly, with extra usage", "Extra usage"; unknown types show their own name. Each has "N% used" and a bar when `utilization` is reported (the bar turns amber unless the status is `allowed`), "limit reached" when rejected, and "Resets <time>" from `resetsAt`. `sdk.d.ts` does not give the scale of `utilization`, so a value of 1 or less is read as a fraction. Before any notice: "No usage reported yet; it appears once an agent has run."
- **Context:** a bar showing the lead's context use (`usage.context / usage.contextMax`) and the total output of all agents.
- **Agents:** the lead and an indented tree of every agent, each with:
  - a status dot, its name, a short model badge and its title;
  - its activity or status, from `statusWords()`;
  - the shared stop button while live (see StopControl below).

  Clicking an agent opens its chat. "Open map" switches to the team map.
- **Folder:** the conversation's working folder.

The +/− buttons' accessible labels use the fixed `TIER_LABEL` names ("More Opus 5.5 agents"), not the configured model names. `test/ui.e2e.mjs` finds the buttons by those labels.

## SettingsMenu.svelte

The ⚙ button at the top right of the header and the popup it opens. It holds the app-wide preferences:

- **Permissions** choice, with a warning when "Bypass all checks" is chosen;
- **Automatic effort**;
- **Lean Opus** (`leanOpus`): Opus agents skip the person's connected services too;
- **Lean Sonnet and Haiku** (`leanSubagents`);
- **Fold agent reports** (`collapseReports`);
- the Masthead version, and Claude Code's version and path (or why it was not found).

Enter or Space on the gear opens it and moves focus to the first control; Escape closes it and returns focus to the gear; a click outside closes it. Changes go through `store.updateSettings()`.

## StopControl.svelte

The ■ that stops a live sub-agent and everything under it (`{t:'stop_agent'}`), used by both the team panel's agent rows and the team map's cards so the two cannot drift. Props: `agent`, and `placement` (`'row'` sits in the flex row; `'map'` sits in the card's bottom-right corner). The square is in the normal text colour (not muted) and a little larger than in 0.1.1; on hover or keyboard focus it turns red and shows the word **Stop** beside it, on an opaque background so it does not cover the card's text. Title "Stop this agent and everything under it"; accessible name "Stop <Name>".

## TeamMap.svelte

The "Team map" tab: the whole team as a tree, built recursively with a Svelte snippet from `store.lead` and `childrenOf()`. Each agent is a card showing:

- its status dot, its name ("Bravo") and a model badge;
- its title (for the lead, "The one you talk to");
- what it is doing, from `statusWords()`: the activity line while running, "Waiting for an answer from …", "Failed: …" with the error, or the status words;
- its effort, context size and, for sub-agents, the time since it started (ticking every second while live).

Live sub-agents have the shared stop button in the card's corner. Clicking a card opens that agent's chat.

**Hover preview:** resting on a card for 220 ms (or focusing it with the keyboard) loads that agent's transcript if needed. A transcript fetched only for a preview is dropped again when the preview closes, unless that agent's chat is the one open. It then shows a tooltip with:

- its task, up to 260 characters;
- the last six lines of its chat (the person's messages, its text, tool lines, reports and messages from others, notices);
- its live draft;
- "Click to open the chat".

The `task` item is left out of those lines because the task is already shown at the top. When only the lead exists, a hint explains that started agents will appear under it.

## Related pages

[Web front end](Source-Web-Front-End.md) · [Web store](Source-Web-Store.md) · [shared/toolline.ts](Source-Shared-Toolline.md)
