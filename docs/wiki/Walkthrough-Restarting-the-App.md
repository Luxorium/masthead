# Walkthrough: restarting the app with saved conversations

This follows Masthead being stopped while agents are working, started again, and the person continuing an old conversation. The state machine is explained on [State machine](State-Machine.md).

## Shutting down

`App.shutdown()` calls `Conversation.shutdown()` on every conversation (see [Stopping an agent](Walkthrough-Stopping-an-Agent.md#the-app-shuts-down)), then `flush()`, which writes each conversation with a pending save to `conversation.json` (`Store.saveConversation()`, an atomic write). Transcript items were appended to their `.jsonl` files as they happened. Each agent's stored record keeps its `sessionId`, the pointer to the backend's own saved session.

`shutdown()` ends each live sub-agent through its machine with `Stop { by: 'restart' }`, so the runtime sets it `stopped` with the error "Masthead was closed while this agent was working." (`CLOSED_WHILE_WORKING`), and sets the lead `idle`. A lead that was `running` or `queued` is first marked `meta.leadCut = true` (`server/core/conversation.ts` line 631), so the next start knows it was cut off mid-turn. After a clean shutdown the file already says so. After a crash the file may still say `running`, `waiting` or `queued`; `restore()` handles that (below); a lead saved as `running` or `queued` gets `leadCut` there (line 277).

**Upgrading from 0.2.0:** the stop before the upgrade is done by 0.2.0, which does not write `meta.leadCut`, so a lead that was mid-turn then is not asked to carry on after the upgrade. From 0.2.1 on it is.

All three paths (a helper cut off by a clean stop, an unanswered message, a hard kill mid-turn) are run against the real Claude Code by [`test/restart.live.ts`](Live-Tests.md#claude-code-testrestartlivets).

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
    C->>C: afterRestart() (microtask): notices, and within 6 h a turn for the lead
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
   - `afterRestart()` (line 310) runs deferred with `queueMicrotask`, because the app keeps items only for a conversation it has registered, which happens after `restore()` returns. It is described in [The lead's turn after a restart](#the-leads-turn-after-a-restart) below.
   - Then `resumeCompact()` carries on with a team compaction that was under way.
   Unless `afterRestart()` gives the lead a turn, nothing is started, no slot is taken, and no timer runs.
5. **Tabs.** A tab connects and receives the conversation list; opening a conversation sends every agent's info, and transcripts are read from the `.jsonl` files. See [Browser–server protocol](Browser-Server-Protocol.md).

## The lead's turn after a restart

`afterRestart()` (`server/core/conversation.ts` line 310) collects what the restart left undone:

- **Cut-off helpers.** `restartNote()` (line 419) finds non-archived agents that are `stopped` with exactly `CLOSED_WHILE_WORKING`. It returns two texts naming each one with its title and who started it, e.g. `bravo (Audit, started by alpha)`: `lead` (they were stopped before they finished, their work is kept in their session, resume the ones still needed with `send_message` or tell their parent; they are not finished work) and `page` ("Masthead was restarted while a helper was working, so it was stopped: …"). Because it reads the stored error, it survives saves and further restarts until the lead is told.
- **An unanswered message.** `unansweredPersonMessage()` (line 381) reads the lead's last 50 items (`host.lastItems`, else `readItems`) from the end: a `text`, `thinking` or `tool` item first means it was answered; the first `user` item found is the unanswered one unless it is empty, starts with `/compact`, or is `meta.restartResent` (already sent again once).
- **A cut-off lead.** `meta.leadCut`, only when there is no unanswered message (that message is sent again instead).

First, when the app knows why it was restarted (`host.restartReason()`, i.e. `App.restartReason()`, from `lastStopNotice()` in `server/service/laststop.ts`: "Masthead was restarted because the computer ran out of memory."), that is added as an info notice to every conversation whose last activity was within 6 hours, and to any older one the restart cut off (one of the three items above). It is said once: the marker is removed when read, and restore runs once per start. A recent conversation the restart cut nothing off gets only this notice.

With none of the three items, it then clears `leadCut` and stops. Otherwise:

- **Last activity within 6 hours** (`RESUME_WINDOW_MS`, line 178; `now() - meta.updatedAt`): the lead gets **one turn of its own**. The parts, each with a page notice, are joined into one message delivered with `deliverTo(lead, …, 'masthead')`: for `leadCut`, "[You were cut off mid-turn by a restart; check where you were and carry on.]"; for the helpers, `[note.lead]`, and they are marked `CLOSED_LEAD_TOLD`; for the unanswered message, a bracketed note that it is sent again (and that pictures are not, when it had any) followed by its text, and `meta.restartResent` is set to its item id.
- **Older**: the lead is not woken. The page gets notices only: the helper note with "The lead is told with your next message.", "Masthead was restarted before the lead answered your last message. Send it again if you still need an answer." (and `restartResent` is set, so it is never resent later), or "Masthead was restarted while the lead was working. Send a message to have it carry on."

Either way `leadCut` is cleared and `host.saveNow()` writes `conversation.json` at once rather than after the usual save delay (`App.saveNow()`, `server/app/app.ts` line 309), so a server that crashes again straight away does not resend everything.

## Continuing the conversation

The person sends a message to the lead; `App` calls `Conversation.userSend()`:

1. The title is kept (it is no longer "New conversation"); a `user` item goes into the lead's transcript.
2. `apply(lead, { type: 'Woken', by: 'person', parentCanReceive: false })`. For the lead this only clears a stop mark; the phase stays `idle`.
3. A restart note still pending (the restart was more than 6 hours after the last activity, so the lead was not woken) is put in front of the text: the lead receives `[note.lead]`, a blank line, then the person's text; the transcript shows only what they typed. Those agents' error becomes "Masthead was closed while this agent was working. The lead was told.", so the lead is told once.
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
- **What the restart cut off** (`meta.leadCut`, `meta.restartResent`, the helpers' `CLOSED_WHILE_WORKING` error): each is acted on once, as above.
- **Stop marks and the message counter** (`stoppedByPerson`, `agentMessages` in `StoredConversation`): agents still cannot wake an agent the person stopped, and the message limit carries on where it was.

## What does not survive

- **Work in progress.** Sub-agents that were working are `stopped`, and nobody owes a report (`owesReport: false`). When an agent later wakes one, it owes a report again only if its parent can receive one: the lead always can; any other parent only while it is live. A woken agent whose parent is also stopped reports to nobody and answers only with `send_message`.
- **Machine state.** `AgentState` is not saved except for the stop marks: holds (children, answers, background work, pauses, approvals), the pause count, run clocks and `liveSince` start fresh.
- **Waits for an answer** and **usage-limit pauses**: memory only. A paused agent is treated like any other agent stopped while working; messages held for it are lost.
- **Open approval requests** (denied at shutdown) and **live drafts**.
- **Processes and slots**: nothing runs until something is delivered.

What was not verified by running: written from the code and the unit tests ("restart: …" and "conversation: restore resets agents that were working" in `test/conversation.test.ts`, `test/storage.test.ts`, and the R1, R4 and "review 2/3" tests in `test/restart.test.ts`); the app was not restarted for this page.

Related pages: [Storage on disk](Storage-on-Disk.md) · [State machine](State-Machine.md) · [Source: storage](Source-Storage.md) · [Source: core/conversation.ts](Source-Core-Conversation.md) · [Agent life cycle](Agent-Life-Cycle.md)
