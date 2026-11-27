# server/scheduler.ts

**Role:** limits how many agents of each tier run at once across all conversations, and decides who goes next when a place frees up. The concepts and a diagram are on [Slot scheduling](Slot-Scheduling.md); this page is the code reference.

## `class SlotCancelled extends Error`

The error a queued request is rejected with when it is cancelled. `Agent.ensureProcess()` checks for it with `instanceof` so a stop while queued is not reported as a failure.

## `class TierOff extends Error`

The error a request is rejected with when its tier's limit is 0: at once in `acquire()`, or for requests already queued when the limits change. Its message is "This tier was switched off in the settings while the agent was waiting to start." and `toString()` returns just that, because `ensureProcess()` passes `String(error)` to `processLost()` and the agent shows it as its error.

## `class Scheduler`

Constructed by `App` as `new Scheduler((tier) => this.currentSettings.tiers[tier].max)`. Taking the limit as a **function** rather than a number means it always reads the current settings; no update call is needed for the numbers themselves.

### State

- `active: Map<Tier, Map<agentId, owner>>`: who holds a slot, and for whom.
- `queue: Map<Tier, Waiter[]>`: waiting requests. A `Waiter` has `id`, `owner`, `seq`, and the promise's `grant` / `refuse` functions.
- `seq`: a counter giving each request its order of arrival.

`activeOf()` and `queueOf()` create the inner collections on first use.

### Methods

| Method | Behaviour |
|---|---|
| `cap(tier)` (private) | `Infinity` for the lead; otherwise `max(0, limit(tier))`. |
| `running(tier)`, `queued(tier)` | Counts, used by `Conversation.spawn()` to predict queueing. |
| `acquire(tier, id, owner)` | Returns a promise. Resolves at once if the agent already holds a slot. Rejects at once with `TierOff` if the tier's cap is 0 (never for the lead), so a paused agent that resumes while its tier is off fails and reports instead of queuing for ever. Resolves at once if there is room **and** nobody is queued. Otherwise adds a waiter and calls `pump()`. |
| `release(tier, id)` | Removes the agent from `active`; if it was there, calls `pump()`. Safe to call twice. |
| `cancel(tier, id)` | Removes a queued waiter and rejects it with `SlotCancelled`. Returns whether one was found. |
| `limitsChanged()` | For every tier with a queue: if its cap is now 0, removes every waiter and rejects it with `TierOff`; otherwise calls `pump()`. `App.updateSettings()` calls it. |
| `pump(tier)` (private) | While there are waiters and room: count active agents per owner, choose the waiter whose owner has the fewest (ties: smallest `seq`), move it to `active`, call its `grant()`. |

### Why "fewest running for the same owner"

The owner is the parent agent. Choosing the parent with the least current share means a parent that queued ten Sonnets cannot hold back a sibling parent that queued one. Ties go to whoever asked first, so within one parent the order is first-come, first-served.

## Tests

`test/agent.test.ts` builds a `Scheduler(() => 1)` for its agents. `test/conversation.test.ts` checks, through a `Conversation`, that switching a tier off fails its queued agents and reports to the parent, and that `acquire()` refuses a new request at once on a tier at 0. `test/unit.test.ts` has five scheduler tests: the limit is never exceeded and the next waiter starts when one finishes; tiers are separate and the lead is unlimited (and a limit of 0 refuses at once with an error); a freed slot goes to the parent with fewest running; cancelling frees a place and raising the limit starts waiters (while lowering it stops nothing); asking twice for the same agent holds one slot.

## Callers

- `Agent.ensureProcess()`: `acquire`, with `owner` = the agent's `parentId`, or the conversation id for the lead; and `release` when a slot is granted after the agent was already ended while waiting (the grant can land in the same pass that freed it, after `end()` had nothing left to cancel).
- `Agent.launch()` (failure paths), `Agent.end()`, `Conversation.processLost()`: `release`.
- `Agent.end()`, `Agent.dispose()`: `cancel` and `release`.
- `Conversation.spawn()`: `running`, `queued`.
- `App.updateSettings()`: `limitsChanged`.

## Related pages

[Slot scheduling](Slot-Scheduling.md) · [server/agent.ts](Source-Agent.md)
