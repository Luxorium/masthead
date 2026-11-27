# Walkthrough: sending a message

This follows the person typing a message to the lead (`alpha`), from the browser to Claude Code and back to the screen. It describes version 0.1.3.

## In the page

1. The person types in the message box (`Composer.svelte`). The text and images are held in the store's draft for this conversation and agent (`store.composer[composerKey]`). Enter calls `store.sendMessage(key)`.
2. Every send carries a fresh `ref`. In an open conversation, the store sends `{t:'send', convId, text, images, ref}`, with `agentId` added if a sub-agent's chat is open. On the new-conversation screen it sends `convId: null` and the chosen folder (`newCwd`), and shows "Starting…" until `created` comes back with that `ref`. The store then opens the new conversation.
3. The box empties, but the store keeps a copy. The message counts as accepted when `created` arrives with its `ref` or its `user` item appears. If the server refuses it (`{t:'error', ref}`: empty, too long, the conversation is gone, a bad folder) or the socket drops first, the text and images go back into that draft, unless something new has been typed there.
4. If the socket is not open, `send()` shows "Not connected to Masthead…" and nothing leaves the box.

Send is disabled while there is nothing to send, while disconnected, while a new conversation is being created, and when Claude Code was not found. While the lead is running and its chat is open with an empty box, the button is ■ and sends `{t:'interrupt'}` instead.

What comes back is drawn by `Transcript.svelte`: `item` messages append or replace entries, `draft` messages show the text being written, and `agent` messages update the status line ("Working…", the activity line). See [Web store](Source-Web-Store.md).

## On the server

### The path

```mermaid
sequenceDiagram
  participant B as Browser
  participant H as http.ts attach()
  participant P as App
  participant C as Conversation
  participant A as Agent (lead)
  participant S as Scheduler
  participant CC as Claude Code
  B->>H: {t:'send', convId, text, images?}
  H->>P: handle(client, parsed)
  P->>P: dispatch: validate text/images, find or create conversation
  P->>C: userSend(text, images)
  C->>A: addItem({kind:'user'}) → saved + broadcast
  C->>A: deliver(content)
  alt lead has an open process
    A->>CC: push into input Channel
  else no process (new conversation, or after restart)
    A->>A: backlog.push, ensureProcess()
    A->>S: acquire('lead') — always free
    A->>CC: launch(): query({prompt: channel, options})
  end
  CC-->>A: system init (session id)
  CC-->>A: stream_event deltas
  A-->>B: {t:'draft'} every ≤70 ms (via Conversation → App)
  CC-->>A: assistant (text / thinking / tool_use)
  A-->>B: {t:'item'} for each
  CC-->>A: result (user_message_uuids)
  A->>C: turnEnded(outcome)
  C->>A: setStatus('idle' or 'waiting')
  A-->>B: {t:'agent'}
```

### Step by step

1. **Socket.** `attach()` in `server/http.ts` receives the text frame, parses JSON, and calls `app.handle(client, parsed)`.
2. **Dispatch.** `App.dispatch()` case `send` (`server/app.ts`):
   - `text` must be a string; `checkImages()` validates attachments; empty or over 400,000 characters throws, which `handle()` turns into `{t:'error'}` carrying the send's `ref`, so the page can give the message back.
   - `convId: null` means a new conversation: Claude Code must have been found; `checkDir()` validates the folder (default `defaultCwd`); `Conversation.create()` makes it with an idle lead; a different folder becomes the new default; the tab gets `{t:'created', convId, ref}`.
   - Otherwise `conv(convId)` finds the existing conversation.
3. **`Conversation.userSend()`** picks the target (the lead unless `agentId` names another agent), sets the conversation title from the first message, and adds a `user` item (only the image count is kept). Its broadcast is what the page takes as "accepted". If the target's tier is switched off, it adds an error notice and stops there. Otherwise it ends any wait the target was in (`clearWait`), and for the lead it puts a one-time note in front of the text when agents were cut off by an earlier shutdown or restart (`restartNote()`). Then it calls `target.deliver(Agent.imageContent(content, images))` and `touch()`es the conversation (new `updatedAt`, list broadcast, save scheduled).
4. **`Agent.deliver()`** wraps the content as an SDK user message with a fresh id and records the id in `unanswered`.
   - If the lead's process is open (the usual case after its first message: the lead's process stays open between turns), the message is pushed into its input `Channel` and the status becomes `running`.
   - Otherwise it goes to `backlog` and `ensureProcess()` runs: the scheduler grants a lead slot immediately (the lead is never limited), and `launch()` starts Claude Code with the backlog as the first input, resuming the saved session if there is one.
5. **Claude Code works.** `consume()` passes each SDK message to `handle()`:
   - `init` records the session id (and the conversation file is saved soon after, via `agentChanged`).
   - `stream_event`s build the **draft**, broadcast at most every 70 ms as `{t:'draft'}`, and update the context and output token counts (`{t:'agent'}`).
   - `assistant` messages become `text`, `thinking` and `tool` items (`{t:'item'}`, each appended to `items/<lead id>.jsonl`). A tool call also sets the activity line.
   - Tool results arrive as `user` messages and update the matching tool item (same id, new line in the file).
   - If a tool needs approval, the turn pauses in `canUseTool` until the person answers ([Permissions and questions](Permissions-and-Questions.md)).
6. **Turn end.** The `result` message lists the consumed ids. If the person typed again during the turn, that id is still unanswered and Claude Code runs another turn; the lead stays `running`. Otherwise `turnEnded()` runs.
7. **`Conversation.turnEnded()`** adds an error notice if any, sets the lead to `idle` (or `waiting` if agents it started are still live), and calls `refreshContext()` to get the real context size from Claude Code. Each change is broadcast as `{t:'agent'}`.

## Sending to an agent other than the lead

The same path, with `agentId` set in `{t:'send'}`: in the page, open the agent's chat (click it in the team panel, the map or a breadcrumb); the box then says "Message Bravo directly", and the draft typed there is kept separately from the lead's. If that agent is waiting for an answer (`waitingFor` set), a quiet line above the box says so, and the person's message ends the wait (`clearWait`). `userSend()` targets that agent. If it has finished, `deliver()` resumes its session (it must get a slot in its tier first, so it may queue). It arrives as a plain user message, and since `owesReport` is not set by this path, a finished agent woken this way does not send a new report to its parent when it is done.

## Related pages

[Browser/server protocol](Browser-Server-Protocol.md) · [Agent life cycle](Agent-Life-Cycle.md) · [server/agent.ts](Source-Agent.md)
