# Walkthrough: restarting the app with saved conversations

This follows Masthead being stopped while agents are working, started again, and the person continuing an old conversation.

## Shutting down

`App.shutdown()` (see [Stopping an agent](Walkthrough-Stopping-an-Agent.md#the-app-shuts-down)) stops every agent's process and calls `flush()`, which writes each conversation with a pending save to `conversation.json`. Transcript items were already appended as they happened. Each agent's stored record keeps its `sessionId`, the pointer to Claude Code's own saved session.

Note on statuses: `Conversation.shutdown()` sets live sub-agents to `stopped` and the lead to `idle` before the flush, so after a clean shutdown the file already says so. After a crash, the file may still say `running` etc.; restoring handles that case (below).

## Starting again

```mermaid
sequenceDiagram
  participant M as main.ts runServer
  participant P as App constructor
  participant S as Store
  participant C as Conversation.restore
  M->>P: new App()
  P->>P: loadSettings(), findClaude(), new Scheduler
  P->>S: loadAll()
  S-->>P: StoredConversation[] (bad folders skipped)
  loop each conversation
    P->>C: restore(app, stored)
    C->>C: live statuses → lead idle / others stopped<br/>clear activity, keep sessionId, owesReport=false
  end
  M->>M: serve() — tabs connect, get {t:'state'}
```

1. `runServer()` in `server/main.ts` creates `new App()`.
2. The constructor loads settings, finds Claude Code, creates the scheduler, and calls `Store.loadAll()`. Each folder with a readable `conversation.json` whose `meta.id` matches the folder name is returned.
3. `Conversation.restore()` rebuilds each conversation: one `Agent` per stored agent, with its `info`, its `sessionId`, `owesReport: false` and, for an agent that never started, its saved `seed`. Any agent whose stored status is live is corrected: the lead to `idle`; others to `stopped` with the error "Masthead was closed while this agent was working.". Nothing is started and no slots are taken.
4. A tab connects and gets `{t:'state'}` with the conversation list (newest first). Opening one sends `{t:'open'}` → `{t:'conversation'}` with every agent's info; `{t:'items'}` reads a transcript from its `.jsonl` file.

## Continuing the conversation

The person sends a message to the lead. The lead has no process, so `deliver()` puts it in the backlog and `ensureProcess()` → `launch()` starts Claude Code with `resume: sessionId`. Claude Code reloads its saved session, so the lead remembers the conversation. Its model and effort ceiling come from the current settings; its effort is the saved one, capped at the ceiling.

## What survives

- Every conversation, agent record and transcript, and each agent's Claude Code session id.
- **The task of an agent that never started.** An agent still `queued` at shutdown has no session yet. Its task is saved as `seed` (`Agent.pendingSeed` → `Conversation.toStored()`) and restored, so if it is woken later its new session begins with the original task, followed by the new message.
- The URL: a reloaded page reopens the conversation named in `#/c/<id>`.

## What does not survive a restart

- **Work in progress.** Sub-agents that were working are `stopped`. Their reports were never sent, and since `owesReport` is reset to false, a later message from anyone other than their parent will not produce a report. If the parent (or the lead, for an Opus) messages one of them, `message()` sets `owesReport` again and it resumes its session to answer.
- **Open approval requests** and the **live draft**: memory only.
- **The inter-agent message counter** starts at zero (a known limitation).
- **Processes and slots**: nothing runs until something is delivered.

## Related pages

[Storage on disk](Storage-on-Disk.md) · [server/store.ts](Source-Store.md) · [server/conversation.ts](Source-Conversation.md) · [Agent life cycle](Agent-Life-Cycle.md)
