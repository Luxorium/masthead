# Walkthrough: sending a message

This follows the person typing a message to the lead (`alpha`), from the browser through the server to the agent's backend and back to every tab that shows the conversation. It describes version 0.2.0 (branch `next`), with Claude Code as the example backend. Line numbers are file-relative and were checked on 2026-11-27; the code was still changing, so search for the function name if a line has moved.

## The path

```mermaid
sequenceDiagram
  participant B as Browser (store)
  participant H as http.ts attach()
  participant P as App (app.ts)
  participant U as Hub (clients.ts)
  participant C as Conversation
  participant M as machine.ts step()
  participant A as Agent (runtime)
  participant S as ClaudeSession
  B->>H: {t:'send', convId, text, blobs?, agentId?, ref}
  H->>P: handle(client, parsed)
  P->>U: admit() (role gate), intercept() (not a v2 connection message)
  P->>P: dispatch() case 'send': checks, find or create the conversation
  P->>C: userSend(text, images, agentId, refs)
  C->>A: addItem({kind:'user'}) → saved, published
  C->>M: Woken {by:'person'}, then Input {from:'person'}
  C->>A: deliver(content)
  alt session open
    A->>S: send(id, content) → pushed into the SDK input channel
  else no session
    A->>A: backlog, ensureProcess() → slot → launch() → backend.open()
  end
  S-->>A: events: turnStarted, draft, text, toolStarted…, turnEnded
  A-->>P: itemChanged / draftChanged / agentChanged (through Conversation)
  P->>U: publish(v1 message)
  U-->>B: v1 tabs: as is; v2 tabs: subscribed only, with seq, drafts as deltas
```

## In the page

1. The message box (`web/src/lib/Composer.svelte`, line 67) calls `store.sendMessage(key)` (`web/src/lib/store.svelte.ts`, line 780).
2. `sendMessage()` makes a fresh `ref`. In an open conversation it sends `{t:'send', convId, text, images, blobs, agentId, ref}`: pictures were already uploaded with `POST /blob`, so they go as `blobs` refs, and `agentId` is set when a sub-agent's chat is open. On the new-chat screen it sends `convId: null` with the folder (`newCwd`), inline images and, on a v2 page, the chosen team `profile`.
3. The box empties but the store keeps the text in `sent` until the server accepts it (`created` with the `ref`, or the `user` item appearing). If an `error` comes back with that `ref`, or the socket drops, the text goes back into its draft (tested in `web/test/store.test.ts`).

## On the server, step by step

1. **Transport.** `attach()` in `server/transport/http.ts` (line 177) wraps the WebSocket as a `Client`. On each frame (`ws.on('message')`, line 193) it parses JSON (a parse failure gets `{t:'error', code:'invalid'}`) and calls `app.handle(client, parsed)` (line 201). The upgrade has already checked path, `Host`, `Origin` and the secret (line 149). Outgoing messages are dropped (drafts only) past 4 MB buffered and the socket closed past 32 MB (lines 27–28, 186–187).
2. **`App.handle()`** (`server/app/app.ts`, line 314): rejects anything without a string `t`, then `this.hub.admit()` (line 319), the one gate where a remote device's role is enforced, and `this.hub.intercept()` (line 320), which answers the protocol 2 connection messages itself (`hello` with `protocol: 2`, `subscribe`, `unsubscribe`, `draft_sync`, `item_full`; `server/app/clients.ts`, line 282). A `send` is not one of them, so it goes on to `dispatch()`. Any throw becomes an error for this client carrying the message's `ref`.
3. **`App.dispatch()` case `send`** (line 434). The same case serves v1 and v2 pages; the protocol version only changes what the tab is sent back (step 9). It:
   - takes `text`, validates inline images (`checkImages`), and refuses an empty message or one over `MAX_TEXT` (`too_large`);
   - for `convId: null`: checks the folder, picks the profile (an unknown named profile is an error), checks that the lead tier's backend is usable through `this.registry.get()`, creates the conversation (`Conversation.create`, line 452), and sends `{t:'created', convId, ref}` (line 455); inline pictures become stored blobs;
   - otherwise: finds the conversation, checks uploaded `blobs` refs against it, keeps one 30 MB cap for uploaded and inline pictures together, and loads the pictures as image content;
   - calls `conv.userSend(text, images, agentId, refs)` (line 480).
4. **`Conversation.userSend()`** (`server/core/conversation.ts`, line 330):
   - The target is the agent named by `agentId`, else the lead. The first message to the lead names the conversation.
   - `target.addItem({kind:'user', …})` saves the person's item (with picture refs) and publishes it; this is what the page takes as "accepted".
   - If the target's tier is switched off, it adds an error notice and stops.
   - `apply(target, {type:'Woken', by:'person'})`: in the machine (`server/core/machine.ts`, `case 'Woken'`, line 406, row 26) this clears a stop mark the person set; an ended sub-agent goes back to `queued`. If the target was waiting for an answer, `AnswerArrived` ends the wait.
   - If the target is still answering an earlier message from the person (busy, with a process, and in `personPending`), the text is prefixed with `SENT_WHILE_ANSWERING` ("[Sent while you were still answering the previous message. If your answer already covers it, do not repeat yourself.]"); a busy turn for a helper's report does not count.
   - For the lead, a one-time note about agents cut off by a restart is put in front of the text (`restartNote()`), only when the restart came more than 6 hours after the last activity; otherwise the lead was already told in a turn of its own (see [Restarting the app](Walkthrough-Restarting-the-App.md#the-leads-turn-after-a-restart)).
   - If the target is paused at a usage limit, messages held for it are delivered first, in order.
   - `apply(target, {type:'Input', from:'person'})` (`case 'Input'`, line 252, rows 4–6): marks `personWoke` on a paused agent and returns a `send` effect, which `exec()` ignores because the caller delivers the content itself.
   - `target.deliver(Agent.imageContent(content, images))`, then `touch()` (new `updatedAt`, list broadcast, save scheduled).
   Every `apply()` (line 534) runs `step()` and carries out its effects; see [State machine](State-Machine.md).
5. **`Agent.deliver()`** (`server/runtime/agent.ts`, line 249). Each message gets a fresh id recorded in `unanswered`; messages held from a usage-limit stop go first.
   - If settings changed in a way that needs a new process (`stale`) and the agent is between turns: close the session gracefully, put the messages in `backlog`, `ensureProcess()`.
   - If a session is open (the usual case for the lead after its first message): `session.send(id, content)` for each, and the status becomes `running`.
   - Otherwise: `backlog`, then `ensureProcess()` (line 293) → `scheduler.acquire()` (the lead's tier is never limited) → `launch()` (line 341) → `backendFor()` → `backend.open(spec, events)` (line 375), then the backlog is sent into the new session. The start path is described step by step in [Walkthrough: an agent starting another](Walkthrough-Starting-an-Agent.md).
6. **`ClaudeSession.send()`** (`server/backends/claude/session.ts`, line 260) pushes an SDK user message (`uuid` = the id) into the `Channel` that the session's `query()` reads as its streaming prompt. Claude Code takes it into the running turn or starts a new one. Other backends do the same through the [Backend interface](Backend-Interface.md) (Codex steers a running turn or starts the next).
7. **Events back.** `consume()` (line 300) feeds each SDK message to `handle()` (line 317), which turns it into neutral `SessionEvents`:
   - `system`/`init` → `turnStarted()`, `sessionStarted(id)` (the runtime saves the session id);
   - `stream_event` (line 337) → `stream()` (line 418): `draft({kind, append})` for text and thinking deltas, `usage()` for context and output tokens;
   - `assistant` (line 341) → `draft(null)`, then `text`, `thinking` or `toolStarted` per block;
   - `user` tool results (line 363) → `toolFinished`;
   - `result` (line 399) → `result()` (line 441) → `turnEnded({consumed, text, error, interrupted})` (line 469).
   The runtime's `events()` (`agent.ts`, line 411) maps these to items (`addItem` → `host.itemChanged`), drafts (`setDraft`, line 698, sent at most every 70 ms, `DRAFT_INTERVAL_MS`, line 82) and status changes (`host.agentChanged`).
8. **Turn end.** `handleResult()` (`agent.ts`, line 551) removes the consumed ids from `unanswered`. If the person typed again during the turn, another turn follows and nothing is reported yet. Otherwise it calls `host.turnEnded()` (line 608). `Conversation.turnEnded()` (`conversation.ts`, line 478) runs `TurnEnded` through the machine: the lead goes `idle`, or `waiting` while agents it started are still live; automatic effort goes back to low; the lead's real context size is read.
9. **To the tabs.** `Conversation` passes `itemChanged`, `draftChanged` and `agentChanged` to `App` (`app.ts`, lines 119–139): an item is appended to the transcript file and every change is `broadcast()` (line 298) as a version 1 message to `Hub.publish()` (`clients.ts`, line 213). The hub turns it into what each tab asked for (`sendTo()`, line 258):
   - a **version 1** tab gets the message unchanged;
   - a **version 2** tab gets conversation events only while **subscribed** to that conversation, each with a per-conversation `seq` kept in a ring for resync (`record()`, line 162); drafts become deltas (`draftEvent()`, line 173: `append` to the same draft, a full `text` for a new one, `draft_end` naming the final item); long tool fields are clipped (`item_full` fetches them). List-level events (`conversations`) go to every tab; an approval request goes to every v2 tab as a short `approval` summary.

## Sending to an agent other than the lead

The same path with `agentId` set: the page sends it when a sub-agent's chat is open. `userSend()` targets that agent; the person's message ends a wait it was in and wakes it if it had finished (`Woken` row 26: back to `queued`, so it needs a slot in its tier again and may queue). Because the person woke it (`parentCanReceive: false`), it does not owe its parent a new report.

## Related pages

[State machine](State-Machine.md) · [server/runtime/agent.ts](Source-Runtime.md) · [Backend interface](Backend-Interface.md) · [server/backends/claude/](Source-Backend-Claude.md) · [server/app/clients.ts](Source-Clients.md) · [Browser/server protocol](Browser-Server-Protocol.md) · [Walkthrough: an agent starting another](Walkthrough-Starting-an-Agent.md)
