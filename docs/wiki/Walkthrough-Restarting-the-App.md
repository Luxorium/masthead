# Walkthrough: restarting the app with saved conversations

This follows Masthead being stopped while agents are working, started again, and the person continuing an old conversation. The state machine is explained on [State machine](State-Machine.md).

## Shutting down

`App.shutdown()` calls `Conversation.shutdown()` on every conversation (see [Stopping an agent](Walkthrough-Stopping-an-Agent.md#the-app-shuts-down)), then `flush()`, which writes each conversation with a pending save to `conversation.json` (`Store.saveConversation()`, an atomic write). Transcript items were appended to their `.jsonl` files as they happened. Each agent's stored record keeps its `sessionId`, the pointer to the backend's own saved session.

`shutdown()` ends each live sub-agent through its machine with `Stop { by: 'restart' }`, so the runtime sets it `stopped` with the error "Masthead was closed while this agent was working." (`CLOSED_WHILE_WORKING`), and sets the lead `idle`. After a clean shutdown the file already says so. After a crash the file may still say `running`, `waiting` or `queued`; `restore()` handles that (below).

## Starting again

```mermaid
sequenceDiagram
  participant M as main.ts
  participant A as App constructor
  participant S as Store
  participant C as Conversation.restore
  M->>A: new App()
  A->>A: loadSettings(), backend registry, new Scheduler(tierLimit)
  A->>S: loadAll()
  S-->>A: StoredConversation[] (migrated; unreadable or newer ones skipped)
  loop each conversation
    A->>C: restore(app, stored)
    C->>C: live statuses → lead idle / others stopped<br/>owesReport false, keep sessionId and seed
    C->>C: stoppedByPerson marks → machine states (st())
    C->>C: restartNote() → notice in the lead's transcript (microtask)
  end
  M->>M: serve() — tabs connect
```

1. **Settings.** The `App` constructor (`server/app/app.ts`) calls `loadSettings()` (`server/settings/settings.ts`). A file without `version` (0.1.x) is copied once to `settings.json.v1.bak` and migrated in memory to version 2 (profiles); the new format is written on the next save. See [Team profiles and settings](Team-Profiles-and-Settings.md).
2. **Backends and scheduler.** It builds the backend registry (detection runs in the background) and `new Scheduler((tier) => tierLimit(settings, tier))`.
3. **Conversations.** `Store.loadAll()` (`server/storage/store.ts`) returns each folder whose `conversation.json` parses, has an array of agents and a `meta.id` equal to the folder name. `migrateConversation()` (`server/storage/migrate.ts`) brings it to format 2; a file from a newer Masthead is left alone and not loaded; an older one is marked so its first rewrite first copies it to `conversation.json.v1.bak`.
4. **`Conversation.restore()`** (`server/core/conversation.ts`) rebuilds each conversation:
   - one `Agent` per stored agent, with its `info` (activity, `waitingFor` and `pausedUntil` cleared), its `sessionId`, `owesReport: false`, and, for an agent that never started, its saved task as `seed`;
   - a stored live status is corrected: the lead to `idle`; any other agent to `stopped` with `CLOSED_WHILE_WORKING`. This is what row 27 (`Restored`) of the machine describes; the shell does it directly on the stored statuses and never sends `Restored`;
   - the person's stop marks (`stoppedByPerson`) are set on the machine state of each agent that still exists. `st(agent)` creates a state from the agent's status the first time it is asked: `initial(lead)`, then the phase from the status (an end status becomes `ended` with that kind and error), `owesReport` from the agent. Other agents get their state the same way when they are first touched;
   - the message counter (`agentMessages`) is read back, clamped to 0–1000;
   - `restartNote()` looks for agents that are `stopped` with exactly `CLOSED_WHILE_WORKING` and, if there are any, adds an info notice to the lead's transcript: "Masthead was restarted; these agents were stopped while working: bravo (Audit). Message one to resume it." It is deferred with `queueMicrotask`, because the app keeps items only for a conversation it has registered, which happens after `restore()` returns. Because the note is found from the stored error, it survives saves and further restarts until the lead is told.
   Nothing is started, no slot is taken, and no timer runs.
5. **Tabs.** A tab connects and receives the conversation list; opening a conversation sends every agent's info, and transcripts are read from the `.jsonl` files. See [Browser–server protocol](Browser-Server-Protocol.md).

## Continuing the conversation

The person sends a message to the lead; `App` calls `Conversation.userSend()`:

1. The title is kept (it is no longer "New conversation"); a `user` item goes into the lead's transcript.
2. `apply(lead, { type: 'Woken', by: 'person', parentCanReceive: false })`. For the lead this only clears a stop mark; the phase stays `idle`.
3. The restart note, if any, is put in front of the text: the lead receives "[Masthead was restarted; these agents were stopped while working: bravo (Audit). Message one to resume it.]", a blank line, then the person's text; the transcript shows only what they typed. Those agents' error becomes "Masthead was closed while this agent was working. The lead was told.", so the lead is told once.
4. `apply(lead, { type: 'Input', from: 'person' })` → effect `send { urgent: true }`, which `exec()` leaves to the caller; `userSend()` then calls `lead.deliver(content)`.
5. The lead has no session, so the runtime puts the message in its backlog and `ensureProcess()` asks the scheduler for a slot (the lead's tier is unlimited), then `launch()` opens the backend with `resume: sessionId`. The backend reloads its saved session, so the lead remembers the conversation. `launch()` sets status `running`; `agentChanged()` applies `Status: running` and the machine's phase follows.
6. If the saved session is gone, the backend reports it missing; the runtime starts one fresh session in its place, tells the agent its context is lost, and re-sends what was unanswered (`startFresh()`; see [Agent life cycle](Agent-Life-Cycle.md)).

The lead's effort is the saved one, capped at its tier's current ceiling (or the tier's level with automatic effort off). Its model is re-read from its tier in the settings (any profile); if no profile lists its tier any more, it keeps its saved model and effort.

## Waking an agent that was cut off

The lead messages `bravo` with `send_message`. `message()` checks that the person did not stop it and its tier is on, then:

1. `apply(bravo, { type: 'Woken', by: 'agent', parentCanReceive: true })` (its parent is the lead): the machine moves it from `ended` to `queued`, clears `end`, resets its run clock and sets `owesReport` (row 26). The runtime still shows `stopped`; a `Status: stopped` event arriving now would not undo the wake-up, because the machine ignores an end status for a `queued` state (the second "runtime wins" rule).
2. `deliverTo()` applies `Input` and calls `bravo.deliver()`: backlog, `ensureProcess()`, a slot of its tier (it may show `queued` while waiting), then `launch()` resumes its session and sets `running`.
3. It works, and its report goes to the lead as usual.

## What survives

- Every conversation, agent record and transcript, and each agent's session id.
- **The task of an agent that never started.** An agent still `queued` at shutdown has no session yet. Its task is saved as `seed` (`Agent.pendingSeed` → `toStored()`) and restored, so if it is woken later its new session begins with the original task, followed by the new message.
- **Stop marks and the message counter** (`stoppedByPerson`, `agentMessages` in `StoredConversation`): agents still cannot wake an agent the person stopped, and the message limit carries on where it was.

## What does not survive

- **Work in progress.** Sub-agents that were working are `stopped`, and nobody owes a report (`owesReport: false`). When an agent later wakes one, it owes a report again only if its parent can receive one: the lead always can; any other parent only while it is live. A woken agent whose parent is also stopped reports to nobody and answers only with `send_message`.
- **Machine state.** `AgentState` is not saved except for the stop marks: holds (children, answers, background work, pauses, approvals), the pause count, run clocks and `liveSince` start fresh.
- **Waits for an answer** and **usage-limit pauses**: memory only. A paused agent is treated like any other agent stopped while working; messages held for it are lost.
- **Open approval requests** (denied at shutdown) and **live drafts**.
- **Processes and slots**: nothing runs until something is delivered.

What was not verified by running: written from the code and the unit tests ("restart: …" and "conversation: restore resets agents that were working" in `test/conversation.test.ts`, `test/storage.test.ts`); the app was not restarted for this page.

Related pages: [Storage on disk](Storage-on-Disk.md) · [State machine](State-Machine.md) · [Source: storage](Source-Storage.md) · [Source: core/conversation.ts](Source-Core-Conversation.md) · [Agent life cycle](Agent-Life-Cycle.md)
