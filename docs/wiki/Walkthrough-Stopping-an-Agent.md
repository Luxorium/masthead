# Walkthrough: stopping an agent

An agent is stopped in one of five ways: the person stops one agent, the person stops everything, an agent stops one below it, the run-time limit is reached, or the app shuts down. Interrupting the lead is related but different: it ends the lead's turn and stops nothing. Every stop is a `Stop` event (or, for the run-time limit, a `Tick`) run through the agent's state machine; see [State machine](State-Machine.md). The code is in `server/core/conversation.ts`, `server/core/machine.ts` and `server/runtime/agent.ts`.

## The person stops a sub-agent

The person presses stop on an agent; the page sends `stop_agent` and `App` (`server/app/app.ts`) calls `conv.stopAgent(agentId, 'Stopped by the person.')`.

```mermaid
sequenceDiagram
  participant App
  participant C as Conversation
  participant K as bravo's children
  participant M as bravo's machine
  participant X as Agent "bravo"
  participant L as the lead (its parent)
  App->>C: stopAgent(bravo, "Stopped by the person.")
  C->>K: stopTree(child, why, 'person') for each (children first)
  Note over K: each live one: cancelPermissions,<br/>apply(Stop by person, drop QUIET)
  C->>C: cancelPermissions(bravo)
  C->>M: apply(bravo, Stop by person)
  M-->>C: ended(stopped); effects [dropHeld, end, notice, report or childEndedQuietly, save]
  C->>X: dropHeld(); end('stopped', why)
  C->>X: notice "Stopped by the person."
  alt bravo owed a report
    C->>L: report(lead, bravo, 'stopped', "Stopped by the person.")
  else
    C->>L: settle(lead) → ChildEnded {reported:false}
  end
```

1. **Children first.** `stopAgent()` calls `stopTree(child, why, 'person')` on each child. `stopTree()` recurses into that child's children before the child itself, so the deepest agents stop first. For each live one it calls `host.cancelPermissions(id)` (open approval requests are denied with "The agent was stopped.") and `apply(child, { type: 'Stop', by: 'person', why }, { drop: QUIET })`. `QUIET` drops `report`, `childEndedQuietly` and `stopChildren`: their parents are being stopped too, so nobody is told, and the tree walk itself handles the children. Agents that are not live are skipped.
2. **The agent itself.** `cancelPermissions(bravo)`, then `apply(bravo, { type: 'Stop', by: 'person', why })`. `apply()` recounts `bravo`'s live children (now none). In `step()` (rows 23/24), for a live sub-agent:
   - `stoppedByPerson = true` (the epilogue emits `save`, because the mark changed). Only a live agent gets here, so a finished helper is not marked and stays reusable by the lead;
   - `stopChildren` if any children were still live (none here);
   - `dropHeld`;
   - `endAs('stopped', why, 'person')`: phase `ended`, holds cleared, report debt cleared, effect `end`;
   - `notice` with the reason;
   - `report { status: 'stopped', text: why }` if it owed a report, else `childEndedQuietly`.
3. **The effects** (`exec()`):
   - `dropHeld`: forgets messages held for it in the conversation (a usage-limit pause) and calls `agent.dropHeld()`;
   - `end` → `bravo.end('stopped', why)`: cancels a queued slot request (rejecting it with `SlotCancelled`), bumps the generation counter, clears the backlog and unanswered input, closes the session at once, releases the slot (which may start a queued agent of that tier), and sets status `stopped` with the reason as `info.error`. Then `releaseWaitsOn(bravo)`: agents waiting for `bravo`'s answer are told there is none;
   - `notice`: the line "Stopped by the person." in its transcript;
   - `report` → the lead gets an `<agent-report … status="stopped">` with "Stopped by the person.", which wakes it so it can react; or `childEndedQuietly` → `settle(lead)` → `ChildEnded { reported: false }` moves a lead that was only waiting on it to `idle` (a sub-agent parent would finish `done`);
   - `save` → `host.metaChanged()`, so the mark is saved with the conversation (`stoppedByPerson` in `toStored()`).
4. **An agent that was not live.** The machine changes nothing and returns no `report` or `childEndedQuietly`; `stopAgent()` sees that and calls `settle(parent)` itself, so a parent waiting only on it still moves on.

When the closed session's process exits, the runtime's `onExited()` sees `closing` set and reports no lost process.

An agent stopped while queued, or while its old process was exiting, is never launched afterwards: `end()` bumped the generation counter, so when the slot (or the exit) arrives, `ensureProcess()` does not call `launch()` and gives back a slot granted in the meantime.

After the stop, other agents cannot wake `bravo`: `message()` returns 'Error: the person stopped "bravo"; only they can wake it.' The person can, by messaging it: `userSend()` applies `Woken { by: 'person' }`, which clears the mark.

## The person stops the lead or everything

- `stop_agent` with the lead's id: `stopTree()` on each child (`by: 'person'`, so every live agent below is marked), then `lead.interrupt()`, then `apply(lead, Stop by person)`. For the lead the machine does not end anything: it clears a usage-limit pause, emits `dropHeld`, and runs `released()`, so a lead that was `waiting` on its children (and is not busy) goes `idle` with `setEffortLow`. The lead keeps its session. `interrupt()` acts only while the lead is `running`; its turn then ends as interrupted (see below).
- `stop_all` ("Stop everything"): `stopAll()` calls `stopAgent(lead, 'Stopped by the person.')`, then `settle(lead)` once more.

No reports are sent: the children are stopped with `QUIET`, and the lead is not told.

## Interrupting the lead

`interrupt` → `interruptLead()` → `lead.interrupt()` → `session.interrupt()`. The backend ends the turn; `handleResult()` passes `interrupted: true` to `turnEnded()`; `TurnEnded` adds the notice "Stopped." and sets the lead `waiting` if something holds it, else `idle`. Agents waiting for the lead's answer are told at once that there is no answer (`checkWaitsOn()` with `interrupted`). Agents the lead started keep working.

## An agent stops one below it

Agents with a child tier have `stop_agent`. `Conversation.stop(caller, name)`:

1. finds the target (`parent` means the caller's parent, which then fails the next check);
2. requires `isAncestor(caller, target)`, else "Error: you can only stop agents started by you or below you.";
3. returns '"name" is not running (status).' if it is not live;
4. `stopTree()` on each of the target's children (`by: 'agent'`, `QUIET`), `cancelPermissions(target)`, then `apply(target, { type: 'Stop', by: 'agent', why: 'Stopped by "caller".' })`. The machine ends it as `stopped` (`by: 'agent'`), does not mark it, and emits `childEndedQuietly` instead of a report (row 24): the caller asked for it. The shell runs `settle()` on the target's parent, which moves that parent on if it was waiting only on the target;
5. returns 'Stopped "name" and everything under it.'

Agents may wake an agent stopped this way later with `send_message`.

## The run-time limit

With `maxRunMinutes` set, the 30-second `tick()` applies `Tick` to every agent. A live sub-agent whose run clock (`ranMs()`: time `running` with no approval open) is past the limit is stopped (row 21): `stopChildren` with the reason, `dropHeld`, the notice "Stopped after N minutes: the run-time limit set by the person.", `end` (`by: 'limit'`), and a report with status `stopped` if owed, else `childEndedQuietly`. The lead and paused agents are never stopped this way.

## The app shuts down

`App.shutdown()` (from Ctrl+C, SIGTERM, SIGHUP, or `POST /api/shutdown`, which `masthead stop` sends) denies every pending approval with "Masthead is shutting down.", then calls `Conversation.shutdown()` on each conversation:

1. it leaves the sleep watcher and stops the 30-second timer;
2. each live sub-agent gets `apply(a, { type: 'Stop', by: 'restart', why: 'Masthead was closed while this agent was working.' }, { drop: SHUTDOWN })`. `SHUTDOWN` drops `report`, `childEndedQuietly`, `stopChildren` and `notice`; `dropHeld` and `end` still run, so the runtime closes the process and releases the slot, the status becomes `stopped` with that error, and the machine agrees;
3. every other agent, the lead included, gets `dispose()`: its process is closed without changing its status;
4. the lead is set to `idle` if it was not (a `Status: idle` event follows).

`App` then flushes pending saves to disk, and `server/main.ts` exits 300 ms later. On the next start, the stored error text is how the lead learns which agents were cut off; see [Restarting the app](Walkthrough-Restarting-the-App.md).

What was not verified by running: written from the code and the unit tests in `test/conversation.test.ts` (stop, stopAll, "stopping drops what is held …", "fix: shutdown ends working agents through the machine; …"); no real process was stopped.

Related pages: [Team rules](Team-Rules.md#stopping) · [State machine](State-Machine.md) · [Agent life cycle](Agent-Life-Cycle.md) · [Source: core/conversation.ts](Source-Core-Conversation.md) · [Command-line launcher](Command-Line-Launcher.md)
