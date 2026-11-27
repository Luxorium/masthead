# server/core/machine.ts

**Role:** the life cycle of one agent as a **pure state machine**. `step(state, event, ctx)` returns the next state and a list of *effects*; it never touches a process, a timer, the disk or another agent. The shell, `Conversation` in `server/core/conversation.ts`, keeps one `AgentState` per agent, feeds it events and carries out the effects (see [server/core/conversation.ts](Source-Core-Conversation.md#the-state-machine)). Effects that concern other agents (a report, a reminder, stopping children) are requests: the shell fulfils them by feeding events to *those* agents' machines.

The transition table (rows 1–27) and the reasoning behind it are on [State machine](State-Machine.md); this page is the code reference. The design is `docs/plans/0.2.0/core.md` §3; where the two differ, the code is described here. Every row has a test in `test/machine.test.ts` (the test names start with the row number, e.g. "row 11: a usage limit pauses…"; rows 12–14 share the test "rows 12-14: …").

The file imports only the `AgentStatus` type from `shared/protocol.ts`.

## Types

### `Phase`

`'queued' | 'running' | 'waiting' | 'idle' | 'ended'`. The first four are also `AgentStatus` values. `ended` stands for the three end statuses; which one is in `AgentState.end.kind`. `idle` is used only by the lead.

### `EndKind`

`'done' | 'failed' | 'stopped'`: how an agent ended.

### `StopBy`

`'person' | 'agent' | 'limit' | 'restart'`: who or what stopped an agent. `person` marks it `stoppedByPerson` and sends a report if one is owed; `agent` (an agent above used `stop_agent`, or a parent ended) sends none; `limit` is the run-time limit; `restart` is the app shutting down.

### `Holds`

Why a `waiting` agent is not finished. Several can hold at once.

| Field | Meaning |
|---|---|
| `children: number` | Live agents it started. The shell overwrites this from its own records before every step. |
| `answer?: { from, reminded }` | It asked `from` (an agent id: its parent or the lead) with `send_message` and `wait: true`; `reminded` is set once the recipient has been reminded. |
| `background: number` | Background commands its backend reports. The shell overwrites it before every step with 1 or 0 (it knows only whether there is background work). |
| `backgroundSince?: number` | Awake time since which a sub-agent has waited on background work **alone**; drives the background cap. |
| `pause?: { until, personWoke, backgroundStopped }` | Paused at a usage limit until the wall-clock time `until`. `personWoke`: the person's message reached it during the pause (a later limit then counts as a new pause). `backgroundStopped`: closing the process at the limit ended background commands. |
| `approvals: number` | Approval cards open while it runs; the run-time clock stops meanwhile. |

### `AgentState`

| Field | Meaning |
|---|---|
| `lead` | It is the lead (never ends). |
| `phase` | See `Phase`. |
| `end?: { kind, error?, by? }` | Set while `phase` is `ended`. |
| `holds` | See `Holds`. |
| `owesReport` | Its parent waits for a report. The shell reads it fresh from the `Agent` before each step and writes it back after. |
| `limitStreak` | Usage-limit pauses in a row; a turn that gets through resets it. |
| `run: { ms, since? }` | Run-time clock for the current piece of work: counts only `running` with no approval open. `since` is set while the clock runs. |
| `liveSince?` | Awake time it last became live (queued, running or waiting). |
| `stoppedByPerson` | The person stopped it while it was working; other agents may not wake it. Saved with the conversation. |
| `archived?` | Archived by a team compaction: a finished helper out of the team, never woken until the person restores it. Saved (the shell keeps the time in `AgentInfo.archived`). See [Compact team](Compact-Team.md). |

### `UsageLimit`

`{ resetsAt?: number; backgroundStopped?: boolean }`: what the runtime knows about a usage limit it ran into.

### `Event`

A union on `type`:

| Event | Fields | Sent by the shell today? |
|---|---|---|
| `Spawned` | | no (`spawn()` sets `initial(false)` directly) |
| `Launched` | | no (the runtime's `running` status arrives as `Status`) |
| `LaunchFailed` | `error` | no (a failed launch arrives as `ProcessLost`) |
| `Input` | `from: 'agent' \| 'person' \| 'masthead'` | yes |
| `TurnStarted` | | no (arrives as `Status`) |
| `TurnEnded` | `text`, `error?`, `interrupted`, `usageLimit?` | yes |
| `ProcessLost` | `error`, `usageLimit?` | yes |
| `Asked` | `from` (recipient id) | yes |
| `AnswerArrived` | | yes |
| `RecipientTurnEnded` | `recipientIsLead`, `interrupted` | yes |
| `RecipientEnded` | | yes |
| `ChildStarted` | | no (the child count is read fresh) |
| `ChildEnded` | `reported` | yes, always with `reported: false` (`settle()`) |
| `Background` | `active` | no (the background count is read fresh) |
| `BackgroundIdle` | | yes |
| `Tick` | `maxRunMs`, `backgroundCapMs` | yes |
| `Stop` | `by: StopBy`, `why` | yes |
| `ApprovalOpened`, `ApprovalClosed` | | yes |
| `Woken` | `by: 'person' \| 'agent'`, `parentCanReceive` | yes |
| `Restored` | | no (`Conversation.restore()` converts the saved statuses itself) |
| `Status` | `status: AgentStatus` | yes: the runtime changed the agent's status itself |
| `Archive` | | yes (`archiveAndCompact()`, a team compaction) |
| `Unarchive` | | yes (`restoreAgent()`, the person restores it) |

The events marked "no" are handled by `step()` and tested in `test/machine.test.ts`, but `server/core/conversation.ts` does not send them (checked by searching for each `type:` literal).

### `Effect`

| Effect | What the shell does (`Conversation.exec()`) |
|---|---|
| `send { urgent }` | Nothing in `exec`: the caller delivers the content (`deliverTo()` / `userSend()`). `urgent` marks the person's own message, which passes a pause. |
| `report { status, text }` | `report()` to the parent. |
| `end { kind, error? }` | `agent.end(kind, error)` (which also releases the slot), then `releaseWaitsOn(agent)`. |
| `setEffortLow` | `agent.setEffort('low')`. |
| `releaseSlot` | `scheduler.release(tier, id)`. |
| `pauseRuntime` | Nothing: messages are held in the conversation's `held` map. |
| `resumeRuntime { note }` | Delivers held messages in order, then `note` if not null. |
| `dropHeld` | Drops held messages here and in the `Agent`. |
| `stopChildren { why? }` | Stops each live child tree; default `why` is `"<name>" ended before this agent finished.` |
| `notice { text, level? }` | Adds a notice item (level `info` by default). |
| `remind { recipient }` | Nothing in `exec`: `checkWaitsOn()` batches reminders per recipient. |
| `noAnswer { from }` | Notice and message "No answer from …". |
| `childEndedQuietly` | `settle(parent)`: a parent waiting only on this child may move on. |
| `save` | `host.metaChanged()`, so the stop mark is saved. |

### `Ctx`

What the shell tells `step()` about the world:

| Field | Meaning |
|---|---|
| `now` | **Awake** time, for the run clock, `liveSince` and the background cap (a sleep must not count). |
| `wall?` | Wall-clock time, for deadlines (a usage limit's reset). Defaults to `now`. |
| `inTurn?` | The agent is in a turn right now. Defaults to `phase === 'running' && busy`. |
| `busy` | The runtime still has input no finished turn has consumed, or a start pending. |
| `autoEffort` | Automatic effort is on (effort goes back to low after a piece of work). |
| `lastText` | The agent's last run's text, used when it finishes without a turn of its own. |

### `WaitReason`

`'paused' | 'approval' | 'answer' | 'children' | 'background'`.

## Constants

| Name | Value |
|---|---|
| `DEFAULT_PAUSE_MS` | 15 minutes: the pause when the reset time is unknown or already past. |
| `MAX_PAUSES` | 3: the fourth separate pause in a row gives up (row 11a). |
| `BACKGROUND_CLOSED` | "A background command was still running when Masthead closed this agent." |
| `RESUME_NOTE` | "The usage limit has reset. Carry on from where you stopped." |
| `BACKGROUND_STOPPED_NOTE` | " Background commands you had running were stopped." (appended to `RESUME_NOTE`) |

## Helpers

- **`initial(lead)`**: a new state. The lead starts `idle` and owes nothing; a sub-agent starts `queued` with `owesReport: true`. All holds zero, `limitStreak` 0, run clock 0, not stopped by the person.
- **`live(s)`**: `phase` is `queued`, `running` or `waiting`.
- **`holding(s)`**: anything still has to happen before a waiting agent may finish: children, an answer, background work or a pause. Open approvals do not count.
- **`backgroundOnly(s)`**: a sub-agent that is `waiting` with background work and no children, answer or pause.
- **`waitReason(s)`**: the one reason to show, by priority: `paused`; `approval` (only while running); then, only while waiting, `answer`, `children`, `background`. No caller outside the file and its tests at present.
- **`statusOf(s)`**: the `AgentStatus` the page and agents see: `end.kind` when ended, else the phase. The shell compares it with the runtime's status in `agentChanged()`.
- **`ranMs(s, now)`**: run time so far, including the running stretch since `run.since`.
- `clone(s)` (private): a deep enough copy that `step()` never changes its input.
- `clockTime(ms)` (private): "HH:MM" in local time, for the pause notice.

## `step(prev, ev, ctx)`

Returns `{ state, effects }`. The input state is not changed (the invariant tests check this).

1. **Archived guard, then ended guard.** An agent with `archived` set reacts only to `Unarchive`; every other event (`Woken`, `Input` and `Status` included) returns `prev` with no effects. An `ended` agent reacts only to `Woken`, `Restored`, `Input`, `Archive`, `Unarchive` and a `Status` of `queued` or `running`; anything else is stale news and returns `prev` with no effects.
2. **Inner helpers** (closures over the copy `s` and the effect list):
   - `endAs(kind, error?, by?)`: phase `ended`, sets `end`, clears `owesReport`, all holds and `limitStreak`, emits `end`. No `releaseSlot`: the runtime's `end()` gives the slot back.
   - `finish(kind, text, error?)`: emits `stopChildren` if it has children, `endAs()`, `setEffortLow` with automatic effort, then `report` if a report was owed (for a failure: "The agent failed: <error>" plus "Its last message:" and the text) or `childEndedQuietly` otherwise.
   - `released()`: a `waiting` agent whose last hold went away (and that is not `busy`): the lead goes `idle` (effort low with automatic effort); a sub-agent `finish('done', ctx.lastText)`.
   - `pause(limit)`: rows 11/11a. The pause lasts until `resetsAt` if it is in the future, else wall time + `DEFAULT_PAUSE_MS`. A limit while already paused (and not woken by the person) is the same window: no notice, no count. Otherwise the streak goes up and the notice "Paused at the usage limit until HH:MM; Masthead resumes it then." is emitted, unless the streak would pass `MAX_PAUSES`: then the pause is dropped (the lead also gets `resumeRuntime` with no note, so what was held goes out) and `pause()` returns false so the caller fails the agent as usual. A pause sets phase `waiting` and emits `releaseSlot` and `pauseRuntime`.
3. **The event.** One `case` per event type; the comments name the table rows. Points worth knowing that the table does not spell out:
   - `TurnStarted` and `Status` `queued`/`running` do not change the phase while paused: during a pause the shell owns the status.
   - `TurnEnded` and `ProcessLost` without a usage limit reset the streak and end any pause with `resumeRuntime` (a turn got through: send what was held).
   - `RecipientTurnEnded` and `RecipientEnded` that end a wait set a `waiting` agent with nothing else holding it back to `running`, because the "No answer" note starts its next turn.
   - `Tick`: first a pause whose time has come ends. If the agent is in a turn (the person woke it), the pause just ends and the phase stays `running`; otherwise it emits the notice "The usage limit has reset; resumed.", `resumeRuntime` with `RESUME_NOTE` (plus `BACKGROUND_STOPPED_NOTE` if so) and goes `queued`, since the process was closed at the limit. Then, for a live sub-agent that is not paused: the run-time limit (row 21, "Stopped after N minutes: the run-time limit set by the person.", reported if owed), then the background cap (row 22: `finish('done', lastText + BACKGROUND_CLOSED)`).
   - `Stop` on the lead ends its pause, drops what was held and calls `released()`; the lead never ends. On a live sub-agent: `stoppedByPerson` if `by` is `person`, `stopChildren` with the same `why`, `dropHeld`, `endAs('stopped', why, by)`, a notice, then `report` only for the person's stop with a report owed, `childEndedQuietly` for other stops, and nothing for `restart`.
   - `Woken` by the person clears `stoppedByPerson`. An ended sub-agent goes back to `queued` with its run clock reset and owes a report if `parentCanReceive`.
   - `Status` (the runtime's own change): `waiting`/`idle` are taken as they are. An end status makes the lead `waiting` or `idle` instead (**the lead never ends**), and is **ignored for a `queued` state**: that is a wake-up the runtime has not shown yet. Otherwise the agent ends with no effects (this is how a shutdown outside the machine is recorded).
   - `Archive`: only for a sub-agent in phase `ended`: sets `archived`, clears `owesReport`, emits `save`. Ignored for the lead and for an agent that is not ended. `Unarchive` clears `archived` and emits `save`; the phase stays `ended`, so a later `Woken` follows the usual path.
   - `Restored`: clears holds, streak, report debt and run clock; the lead goes `idle`; a sub-agent that was live ends `stopped` with "Masthead was closed while this agent was working." and `by: 'restart'`.
4. **Bookkeeping after every event:** sets `liveSince` when it becomes live (clears it when not); starts or stops the run clock (`running` with no approvals open); sets or clears `backgroundSince` for an agent waiting on background work alone, however it got there; emits `save` when `stoppedByPerson` changed.

## Tests

`test/machine.test.ts`: one test per row of the table (rows 12–14 share one test), two "fix" regressions (the background cap starting when a child ends; a pause ending during a person's turn keeps the clock on), "archive: only a finished helper is archived; nothing but Unarchive changes it; never the lead", and two invariant sweeps that run many event sequences and check that a waiting sub-agent always has a hold, the lead never ends, an ended agent holds nothing and `step()` is pure. Not run for this page; read only.

## Related pages

[State machine](State-Machine.md) · [Compact team](Compact-Team.md) · [server/core/conversation.ts](Source-Core-Conversation.md) · [Agent life cycle](Agent-Life-Cycle.md) · [Team rules](Team-Rules.md)
