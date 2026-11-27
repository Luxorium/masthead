# server/core/scheduler.ts

**Role:** limits how many agents of each tier run at once across **all** conversations, and decides who goes next when a place frees up. The concepts and a diagram are on [Slot scheduling](Slot-Scheduling.md); this page is the code reference. The file imports only the `Tier` type from `shared/protocol.ts`.

## `class SlotCancelled extends Error`

The error a queued request is rejected with when `cancel()` drops it (message "cancelled while waiting for a slot"). `Agent.ensureProcess()` in `server/runtime/agent.ts` checks for it with `instanceof`, so a stop while queued is not reported as a failure.

## `class TierOff extends Error`

The error a request is rejected with when its tier's limit is 0: at once in `acquire()`, or for requests already queued when `limitsChanged()` finds the tier off. Its message is "This tier was switched off in the settings while the agent was waiting to start." and `toString()` returns just that, because `ensureProcess()` passes `String(error)` to `processLost()` and the agent shows it as its error. The agent then fails and reports to its parent.

## `interface Waiter` (private)

A queued request: `id` (agent id), `owner` (who asked, used for fairness), `seq` (order of arrival), and the promise's `grant()` / `refuse(reason)`.

## `class Scheduler`

Constructed by `App` (`server/app/app.ts`) as `new Scheduler((tier) => tierLimit(this.currentSettings, tier))`. `tierLimit()` (`server/settings/settings.ts`) looks the tier id up in every team profile: `Infinity` for a profile's first tier (its lead), the tier's `max` for the others, 0 for an unknown tier. Taking the limit as a **function** means the scheduler always reads the current settings; no update call is needed for the numbers themselves. Tier ids are strings: `lead`/`opus`/`sonnet`/`haiku` for the Claude profile, `<profile>:<index>` for others (see [Team profiles and settings](Team-Profiles-and-Settings.md)).

### State

- `active: Map<Tier, Map<agentId, owner>>`: who holds a slot, and for whom.
- `queue: Map<Tier, Waiter[]>`: waiting requests.
- `seq`: a counter giving each request its order of arrival.

`activeOf(tier)` and `queueOf(tier)` (private) create the inner collections on first use.

### Methods

| Method | Behaviour |
|---|---|
| `cap(tier)` (private) | `Infinity` when the tier id is `lead` or the limit function returns `Infinity` (first tiers of other profiles); otherwise `max(0, limit(tier))`. |
| `running(tier)`, `queued(tier)` | Counts, used by `Conversation.spawn()` to say in its reply whether the new agent will queue. |
| `acquire(tier, id, owner)` | Returns a promise. Resolves at once if the agent already holds a slot. Rejects at once with `TierOff` if the cap is 0, so a paused agent that resumes while its tier is off fails and reports instead of queuing for ever. Resolves at once if there is room **and** nobody is queued (so a newcomer never jumps the queue). Otherwise adds a `Waiter` and calls `pump()`. |
| `release(tier, id)` | Removes the agent from `active`; if it was there, calls `pump()`. Safe to call twice. |
| `cancel(tier, id)` | Removes a queued waiter and rejects it with `SlotCancelled`. Returns whether one was found. |
| `limitsChanged()` | For every tier with a queue: if its cap is now 0, removes every waiter and rejects it with `TierOff`; otherwise `pump()`, so a raised limit starts waiters. Lowering a limit stops nothing that already runs. |
| `pump(tier)` (private) | While there are waiters and room: count active slots per owner, choose the waiter whose owner has the fewest (ties: smallest `seq`), move it to `active`, call its `grant()`. |

### Why "fewest running for the same owner"

The owner is the parent agent's id (the conversation id for a lead). Choosing the parent with the smallest current share means a parent that queued ten agents cannot hold back a sibling parent that queued one. Ties go to whoever asked first, so within one parent the order is first-come, first-served.

An agent that is waiting for agents it started keeps its slot (the class comment: it is still part of the running team). A usage-limit pause releases it (`releaseSlot` effect, see [server/core/machine.ts](Source-Core-Machine.md#effect)); the agent asks again when it resumes.

## Callers

- `Agent.ensureProcess()` (`server/runtime/agent.ts`): `acquire` with `owner` = `parentId ?? convId`. It shows `queued` only when the slot is not granted within a microtask. If the agent was ended while waiting and the grant lands afterwards, it `release`s the slot again.
- `Agent.launch()` failure paths (no backend, `open()` throws), `Agent.end()`, `Agent.dispose()`: `release`; `end()` and `dispose()` also `cancel`.
- `Conversation.exec()` for the `releaseSlot` effect (a pause or a lost process): `release`.
- `Conversation.spawn()`: `running`, `queued`.
- `App.updateSettings()` (`server/app/app.ts`): `limitsChanged`.

## Tests

`test/unit.test.ts` has five scheduler tests: the limit is never exceeded and the next waiter starts when one finishes; tiers are separate and the lead is never limited; a freed slot goes to the parent with fewest running; cancelling frees a place and raising the limit starts waiters; asking twice for the same agent holds one slot. `test/conversation.test.ts` checks, through a `Conversation`, that switching a tier off fails its queued agents and reports to the parent, and that `acquire()` refuses at once with `TierOff` on a tier at 0. Read for this page, not run.

## Related pages

[Slot scheduling](Slot-Scheduling.md) · [server/core/conversation.ts](Source-Core-Conversation.md) · [server/runtime/agent.ts](Source-Runtime.md) · [Team profiles and settings](Team-Profiles-and-Settings.md)
