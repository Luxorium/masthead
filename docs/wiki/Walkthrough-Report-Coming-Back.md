# Walkthrough: a report coming back

This follows a Sonnet agent `charlie`, started by the Opus agent `bravo` (which the lead `alpha` started), finishing its task, and its report reaching `bravo`, which is `waiting` for it. It uses the built-in Claude profile; tier ids are `opus` and `sonnet`. The machine is explained on [State machine](State-Machine.md).

## The path

```mermaid
sequenceDiagram
  participant S as charlie's session
  participant A as Agent "charlie" (runtime)
  participant C as Conversation
  participant MC as charlie's machine
  participant Sch as Scheduler
  participant MB as bravo's machine
  participant B as Agent "bravo" (waiting)
  S-->>A: turnEnded (final text, ids consumed)
  A->>C: turnEnded(charlie, {text})
  C->>MC: apply(TurnEnded)
  MC-->>C: phase ended(done); effects [end, setEffortLow, report]
  C->>A: end('done')
  A->>Sch: release('sonnet') → pump() may start a queued Sonnet
  C->>A: setEffort('low')
  C->>B: addItem(inbound report)
  C->>MB: deliverTo → apply(Input from agent)
  MB-->>C: effects [send]
  C->>B: deliver(<agent-report …>)
  B->>B: setStatus('running') → Status event → bravo's phase running
```

## Step by step

1. **The last turn ends.** `charlie`'s session reports the end of a turn; `Agent.handleResult()` (`server/runtime/agent.ts`) removes the input ids the turn consumed. Nothing is left unanswered and no background work runs, so it calls `host.turnEnded(charlie, { text, error: undefined, interrupted: false })`. `text` joins the final texts of every turn since `charlie` last took up work, oldest first; usually one turn. If a message landed as the turn ended, the backend runs one more turn and its reply is added after the real report instead of replacing it.
2. **`Conversation.turnEnded()`** (`server/core/conversation.ts`) applies `{ type: 'TurnEnded', text, interrupted: false }` to `charlie`.
3. **`apply()` reads fresh facts**: `holds.children` = `charlie`'s live children (0), `holds.background` = 0, `owesReport` = true (set at spawn). It runs `step()` with the awake-time clock, `busy` false, automatic effort on and `charlie.lastText`.
4. **`step()`** (`server/core/machine.ts`): no usage limit, so `limitStreak` resets; not the lead; no error and nothing holding it, so `finish('done', text)` (row 7):
   - no children to stop;
   - `endAs('done')`: phase `ended`, holds cleared, `owesReport` false, effect `end`;
   - automatic effort on: effect `setEffortLow`;
   - it owed a report: effect `report { status: 'done', text }`.
   The epilogue stops the run clock (adds the running stretch to `run.ms`) and clears `liveSince`.
5. **The shell carries out the effects in order** (`exec()`):
   - `end` → `charlie.end('done')`: cancels any queued slot request, closes the session (gracefully, or at once if background commands were running), releases the Sonnet slot (and `pump()` may grant it to a queued Sonnet straight away), and sets status `done`. That status change calls `agentChanged()`, which sees the machine already says `done` and applies no `Status` event. Then `releaseWaitsOn(charlie)`: any agent waiting for `charlie`'s answer gets `RecipientEnded` and is told there is no answer.
   - `setEffortLow` → `charlie.setEffort('low')`.
   - `report` → `Conversation.report(bravo, charlie, 'done', text)`.
6. **`report()`.** `bravo` can receive (it is live). It gets:
   - an `inbound` item `{ via: 'report', from: 'charlie', text, status: 'done' }` (what the screen shows; an empty text shows as "(no report text)");
   - `deliverTo(bravo, reportEnvelope('charlie', 'sonnet', 'done', text), 'agent')`, where the envelope is

     ```text
     <agent-report from="charlie" tier="sonnet" status="done">
     …charlie's final message…
     </agent-report>
     ```

7. **Through `bravo`'s machine.** `deliverTo()` applies `{ type: 'Input', from: 'agent' }` to `bravo`. `apply()` recounts `bravo`'s live children (`charlie` no longer counts). `step()` returns `send`, which `exec()` ignores; the phase stays `waiting`. `bravo` is not paused, so `deliverTo()` calls `bravo.deliver(envelope)`.
8. **`bravo` wakes.** A `waiting` agent still has its session open (it kept its slot), so the runtime sends the envelope into it and sets status `running`. `agentChanged()` sees the runtime's `running` differs from the machine's `waiting` and applies `Status: running`; the machine's phase becomes `running` and its run clock starts. The backend starts a turn to read the report.
9. **`charlie`'s `turnEnded()` returns.** Its state is ended, so it skips `checkWaitsOn()` (that is for a recipient whose turn ended while it lives on).
10. **`bravo` decides.** When its turn ends, `TurnEnded` finds what still holds it: other live children keep it `waiting` (row 9); with none, it finishes the same way and its own report goes to the lead.

## Variations

- **Failure.** A turn that ends with an error: `finish('failed')` stops `charlie`'s children (`stopChildren`) and reports "The agent failed: <error>", plus "Its last message:" and the text when there is one, with status `failed`.
- **Lost process.** `Agent` calls `processLost()`; `ProcessLost` adds an error notice and `releaseSlot`, then fails the sub-agent with an empty text, so the report is "The agent failed: <error>".
- **Usage limit.** A turn or process ended by the usage limit pauses `charlie` instead (row 11): no report, the slot is given back, its children carry on. See [State machine](State-Machine.md).
- **Stopped by the person.** `Stop { by: 'person' }` reports status `stopped` with "Stopped by the person." if `charlie` owed a report.
- **Stopped by `bravo`** (`stop_agent`): `Stop { by: 'agent' }` emits `childEndedQuietly`, never a report.
- **No report owed.** `childEndedQuietly` makes the shell run `settle(bravo)`, which applies `ChildEnded { reported: false }`. If `bravo` is `waiting`, not busy, and nothing holds it any more (`released()`), it finishes `done` with its own `lastText`, which goes to the lead as its report. The lead in that position goes `idle`.
- **Woken by someone else.** If `charlie` had finished and a sibling woke it, `message()` applied `Woken { parentCanReceive: true }` (if `bravo` is live or the lead), so it owes `bravo` a report again and its new result comes back to `bravo`. The sibling hears back only through `send_message`.
- **A question is not a report.** `send_message` with `wait: true` to `bravo` applies `Asked` to `charlie`. When `charlie`'s turn ends, the answer hold keeps it `waiting` (row 9); it keeps its slot and still owes the report. Any message from `bravo` applies `AnswerArrived`. If `bravo`'s turn ends without answering, it is reminded once; after that, or at once if its turn was interrupted or it ended, `charlie` is told 'No answer from "bravo"; carry on with your best judgment or report what you have.'
- **Background work.** If background commands still run when `charlie`'s turn ends, the background hold keeps it `waiting`. When they end and no turn follows within the grace time, the runtime calls `backgroundIdle()`, which applies `BackgroundIdle`, and `released()` finishes it with its `lastText`. After 10 minutes waiting on background work alone, a `Tick` finishes it with the text plus "A background command was still running when Masthead closed this agent."
- **Parent paused.** If `bravo` is paused at a usage limit, `deliverTo()` keeps the envelope in the conversation's `held` list; `resumeRuntime` delivers it, in order, when the pause ends.
- **Parent cannot receive.** If the parent is not the lead and not live, `report()` does nothing.
- **Tier switched off while queued.** The scheduler refuses `charlie` with `TierOff`; the runtime calls `processLost()`, and `bravo` gets "The agent failed: This tier was switched off in the settings while the agent was waiting to start."
- **Escaping.** `reportEnvelope()` escapes any `<agent-report` or `<agent-message` tag in the text, so it cannot close the envelope early.
- **Report to the lead.** The lead can always receive. Idle with a session, the report starts a turn; with no session (after a restart), the runtime resumes its session to read it.

What was not verified by running: this follows the code and the unit tests in `test/conversation.test.ts` and `test/machine.test.ts`; no real backend session was run.

Related pages: [Team rules](Team-Rules.md#reports) · [State machine](State-Machine.md) · [Agent life cycle](Agent-Life-Cycle.md) · [Source: core/conversation.ts](Source-Core-Conversation.md) · [Source: core/prompts.ts](Source-Core-Prompts.md)
