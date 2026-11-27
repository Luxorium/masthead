// The agent state machine (server/core/machine.ts): one test per row of the transition table in
// docs/plans/0.2.0/core.md §3.3, plus invariants. Pure: no process, no timer, no disk.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BACKGROUND_CLOSED,
  DEFAULT_PAUSE_MS,
  RESUME_NOTE,
  holding,
  initial,
  live,
  ranMs,
  statusOf,
  step,
  waitReason,
  type AgentState,
  type Ctx,
  type Effect,
  type Event,
} from '../server/core/machine.ts';

const T0 = 1_800_000_000_000;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ now: T0, busy: false, autoEffort: true, lastText: 'last words', ...over });

/** Runs events in order; returns the final state and every effect. */
function run(s: AgentState, events: Array<Event | [Event, Partial<Ctx>]>) {
  const all: Effect[] = [];
  for (const e of events) {
    const [ev, c] = Array.isArray(e) ? e : [e, {}];
    const r = step(s, ev, ctx(c));
    s = r.state;
    all.push(...r.effects);
  }
  return { s, fx: all };
}
const has = (fx: Effect[], type: Effect['type']) => fx.some((f) => f.type === type);
const of = <T extends Effect['type']>(fx: Effect[], type: T) => fx.filter((f) => f.type === type) as Array<Extract<Effect, { type: T }>>;

const sub = () => initial(false);
const lead = () => initial(true);
const running = () => run(sub(), [{ type: 'Launched' }]).s;
const ended = (text = 'ok') => run(running(), [{ type: 'TurnEnded', text, interrupted: false }]).s;

test('row 1: Spawned → queued, owes a report', () => {
  const s = run(lead(), [{ type: 'Spawned' }]).s;
  assert.equal(s.phase, 'queued');
  assert.equal(s.owesReport, true);
  assert.equal(statusOf(sub()), 'queued');
});

test('row 2: Launched → running, live since now, run clock on', () => {
  const s = running();
  assert.equal(s.phase, 'running');
  assert.equal(s.liveSince, T0);
  assert.equal(s.run.since, T0);
});

test('row 3: launch failed (TierOff, no Claude Code) → failed with a report', () => {
  const { s, fx } = run(sub(), [{ type: 'LaunchFailed', error: 'This tier was switched off' }]);
  assert.equal(statusOf(s), 'failed');
  assert.match(of(fx, 'report')[0]!.text, /^The agent failed: This tier was switched off/);
  assert.ok(has(fx, 'releaseSlot'));
});

test('row 4: input from an agent to a running agent is sent', () => {
  const { fx } = run(running(), [{ type: 'Input', from: 'agent' }]);
  assert.deepEqual(of(fx, 'send'), [{ type: 'send', urgent: false }]);
});

test('row 5: input from an agent to a paused agent is not urgent (the runtime holds it)', () => {
  const paused = run(running(), [{ type: 'TurnEnded', text: '', interrupted: false, usageLimit: {} }]).s;
  const { s, fx } = run(paused, [{ type: 'Input', from: 'agent' }]);
  assert.deepEqual(of(fx, 'send'), [{ type: 'send', urgent: false }]);
  assert.equal(s.holds.pause!.personWoke, false);
});

test('row 6: the person\'s input to a paused agent is urgent and marks personWoke', () => {
  const paused = run(running(), [{ type: 'TurnEnded', text: '', interrupted: false, usageLimit: {} }]).s;
  const { s, fx } = run(paused, [{ type: 'Input', from: 'person' }]);
  assert.deepEqual(of(fx, 'send'), [{ type: 'send', urgent: true }]);
  assert.equal(s.holds.pause!.personWoke, true);
});

test('row 7: a sub-agent\'s turn ends with nothing holding it → done, report, effort low', () => {
  const { s, fx } = run(running(), [{ type: 'TurnEnded', text: 'Found two bugs.', interrupted: false }]);
  assert.equal(statusOf(s), 'done');
  assert.deepEqual(of(fx, 'report'), [{ type: 'report', status: 'done', text: 'Found two bugs.' }]);
  assert.ok(has(fx, 'setEffortLow'));
  assert.ok(has(fx, 'releaseSlot'));
  assert.equal(s.owesReport, false);
});

test('row 8: the lead\'s turn ends with nothing holding it → idle, effort low', () => {
  const { s, fx } = run(lead(), [{ type: 'TurnStarted' }, { type: 'TurnEnded', text: 'hi', interrupted: false }]);
  assert.equal(s.phase, 'idle');
  assert.ok(has(fx, 'setEffortLow'));
  assert.ok(!has(fx, 'report'));
});

test('row 9: a turn ends while something holds it → waiting, not finished', () => {
  for (const hold of [{ type: 'ChildStarted' }, { type: 'Asked', from: 'b' }, { type: 'Background', active: 1 }] as Event[]) {
    const { s, fx } = run(running(), [hold, { type: 'TurnEnded', text: 'x', interrupted: false }]);
    assert.equal(s.phase, 'waiting', hold.type);
    assert.ok(!has(fx, 'report'));
  }
  const bg = run(running(), [{ type: 'Background', active: 1 }, { type: 'TurnEnded', text: 'x', interrupted: false }]).s;
  assert.equal(bg.holds.backgroundSince, T0, 'waiting on background alone is timed');
  assert.equal(waitReason(bg), 'background');
});

test('row 10: a turn that ends with an error fails the sub-agent and stops its children', () => {
  const { s, fx } = run(running(), [{ type: 'ChildStarted' }, { type: 'TurnEnded', text: 'partial', error: 'boom', interrupted: false }]);
  assert.equal(statusOf(s), 'failed');
  assert.ok(has(fx, 'stopChildren'));
  assert.equal(of(fx, 'report')[0]!.text, 'The agent failed: boom\n\nIts last message:\npartial');
});

test('row 11: a usage limit pauses (slot freed, one notice per window, repeats in the window do not count)', () => {
  const limit = { type: 'TurnEnded', text: '', interrupted: false, usageLimit: { resetsAt: T0 + 60_000 } } as Event;
  const { s, fx } = run(running(), [{ type: 'ChildStarted' }, limit, { type: 'TurnStarted' }, limit, limit]);
  assert.equal(s.phase, 'waiting', 'a late start does not flip a paused agent to running');
  assert.equal(s.holds.pause!.until, T0 + 60_000);
  assert.equal(s.limitStreak, 1);
  assert.equal(of(fx, 'notice').filter((n) => /Paused at the usage limit/.test(n.text)).length, 1);
  assert.ok(has(fx, 'pauseRuntime') && has(fx, 'releaseSlot'));
  assert.ok(!has(fx, 'stopChildren') && !has(fx, 'report'), 'children keep going, no report');
  assert.equal(waitReason(s), 'paused');
  const unknown = run(running(), [{ type: 'TurnEnded', text: '', interrupted: false, usageLimit: {} }]).s;
  assert.equal(unknown.holds.pause!.until, T0 + DEFAULT_PAUSE_MS);
});

test('row 11a: a fourth separate pause in a row fails as before (the lead goes idle)', () => {
  let s = running();
  for (let i = 0; i < 3; i++) {
    s = run(s, [[{ type: 'TurnEnded', text: '', interrupted: false, usageLimit: {} }, { now: T0 + i * DEFAULT_PAUSE_MS * 2 }]]).s;
    s = run(s, [[{ type: 'Tick', maxRunMs: 0, backgroundCapMs: 1e9 }, { now: T0 + i * DEFAULT_PAUSE_MS * 2 + DEFAULT_PAUSE_MS }]]).s;
  }
  const { s: last, fx } = run(s, [{ type: 'TurnEnded', text: '', error: 'usage limit', interrupted: false, usageLimit: {} }]);
  assert.equal(statusOf(last), 'failed');
  assert.ok(has(fx, 'report'));
  let l = lead();
  for (let i = 0; i < 4; i++) {
    l = run(l, [{ type: 'TurnEnded', text: '', interrupted: false, usageLimit: {} }]).s;
    l = run(l, [[{ type: 'Tick', maxRunMs: 0, backgroundCapMs: 1e9 }, { now: T0 + DEFAULT_PAUSE_MS + 1 }]]).s;
  }
  assert.equal(l.phase, 'idle');
});

test('rows 12-14: the recipient\'s turn ends unanswered: remind once; then no answer (or keep waiting for the lead)', () => {
  const asked = run(running(), [{ type: 'Asked', from: 'bravo' }, { type: 'TurnEnded', text: 'q?', interrupted: false }]).s;
  const first = run(asked, [{ type: 'RecipientTurnEnded', recipientIsLead: false, interrupted: false }]);
  assert.deepEqual(of(first.fx, 'remind'), [{ type: 'remind', recipient: 'bravo' }]);
  const second = run(first.s, [{ type: 'RecipientTurnEnded', recipientIsLead: false, interrupted: false }]);
  assert.deepEqual(of(second.fx, 'noAnswer'), [{ type: 'noAnswer', from: 'bravo' }]);
  assert.equal(second.s.holds.answer, undefined);

  const toLead = run(running(), [{ type: 'Asked', from: 'alpha' }, { type: 'TurnEnded', text: 'q?', interrupted: false }]).s;
  const l1 = run(toLead, [{ type: 'RecipientTurnEnded', recipientIsLead: true, interrupted: false }, { type: 'RecipientTurnEnded', recipientIsLead: true, interrupted: false }]);
  assert.equal(of(l1.fx, 'remind').length, 1);
  assert.equal(of(l1.fx, 'noAnswer').length, 0, 'row 14: the lead may be asking the person');
  const l2 = run(l1.s, [{ type: 'RecipientTurnEnded', recipientIsLead: true, interrupted: true }]);
  assert.equal(of(l2.fx, 'noAnswer').length, 1, 'an interrupted lead releases the asker');
});

test('row 15: an answer arrives: the wait ends (the turn it starts decides the rest)', () => {
  const asked = run(running(), [{ type: 'Asked', from: 'bravo' }, { type: 'TurnEnded', text: 'q?', interrupted: false }]).s;
  const { s, fx } = run(asked, [[{ type: 'AnswerArrived' }, { busy: true }]]);
  assert.equal(s.holds.answer, undefined);
  assert.equal(s.phase, 'waiting');
  assert.ok(!has(fx, 'end'), 'busy with the answer: not finished');
});

test('row 16: a child ends with a report: one hold fewer; the report arrives as input', () => {
  const w = run(running(), [{ type: 'ChildStarted' }, { type: 'ChildStarted' }, { type: 'TurnEnded', text: 'x', interrupted: false }]).s;
  const { s, fx } = run(w, [[{ type: 'ChildEnded', reported: true }, { busy: true }]]);
  assert.equal(s.holds.children, 1);
  assert.ok(!has(fx, 'end'));
});

test('row 17: the last child ends quietly → the waiting agent finishes with its last text (the lead goes idle)', () => {
  const w = run(running(), [{ type: 'ChildStarted' }, { type: 'TurnEnded', text: 'x', interrupted: false }]).s;
  const { s, fx } = run(w, [{ type: 'ChildEnded', reported: false }]);
  assert.equal(statusOf(s), 'done');
  assert.deepEqual(of(fx, 'report'), [{ type: 'report', status: 'done', text: 'last words' }]);
  const l = run(lead(), [{ type: 'ChildStarted' }, { type: 'TurnEnded', text: 'x', interrupted: false }, { type: 'ChildEnded', reported: false }]).s;
  assert.equal(l.phase, 'idle');
});

test('row 18: background count follows the backend; alone it starts the cap timer', () => {
  const w = run(running(), [{ type: 'ChildStarted' }, { type: 'Background', active: 2 }, { type: 'TurnEnded', text: 'x', interrupted: false }]).s;
  assert.equal(w.holds.background, 2);
  assert.equal(w.holds.backgroundSince, undefined, 'a child holds it too');
  const alone = run(w, [[{ type: 'ChildEnded', reported: true }, { busy: true, now: T0 + 5 }]]).s;
  const again = run(alone, [[{ type: 'Background', active: 1 }, { now: T0 + 9 }]]).s;
  assert.equal(again.holds.backgroundSince, T0 + 9);
});

test('row 19: background work ends with no new turn → finished (lead: idle, not finished)', () => {
  const w = run(running(), [{ type: 'Background', active: 1 }, { type: 'TurnEnded', text: 'x', interrupted: false }]).s;
  const { s, fx } = run(w, [{ type: 'BackgroundIdle' }]);
  assert.equal(statusOf(s), 'done');
  assert.ok(has(fx, 'report'));
  const l = run(lead(), [{ type: 'Background', active: 1 }, { type: 'TurnEnded', text: 'x', interrupted: false }]).s;
  assert.equal(l.phase, 'waiting');
  assert.equal(run(l, [{ type: 'BackgroundIdle' }]).s.phase, 'idle');
});

test('row 20: the pause ends on a tick: resume with the note (background note if any), none when already in a turn', () => {
  const p = run(running(), [{ type: 'TurnEnded', text: '', interrupted: false, usageLimit: { resetsAt: T0 + 1000, backgroundStopped: true } }]).s;
  const early = run(p, [[{ type: 'Tick', maxRunMs: 0, backgroundCapMs: 1e9 }, { now: T0 + 500 }]]);
  assert.ok(early.s.holds.pause && !has(early.fx, 'resumeRuntime'));
  const { s, fx } = run(p, [[{ type: 'Tick', maxRunMs: 0, backgroundCapMs: 1e9 }, { now: T0 + 1000 }]]);
  assert.equal(s.holds.pause, undefined);
  assert.equal(of(fx, 'resumeRuntime')[0]!.note, `${RESUME_NOTE} Background commands you had running were stopped.`);
  // The person woke it and its turn is under way when the reset passes: no extra turn.
  const woke = run(p, [{ type: 'Input', from: 'person' }]).s;
  const inTurn = { ...woke, phase: 'running' as const };
  const r = run(inTurn, [[{ type: 'Tick', maxRunMs: 0, backgroundCapMs: 1e9 }, { now: T0 + 1000, busy: true }]]);
  assert.deepEqual(of(r.fx, 'resumeRuntime'), [{ type: 'resumeRuntime', note: null }]);
});

test('row 21: past the run-time limit (running time only) → stopped with a report; never the lead', () => {
  let s = running(); // clock on at T0
  s = run(s, [[{ type: 'ApprovalOpened' }, { now: T0 + 4 * 60_000 }]]).s; // 4 min running, then an approval card
  s = run(s, [[{ type: 'ApprovalClosed' }, { now: T0 + 64 * 60_000 }]]).s; // an hour waiting for the person: not counted
  assert.equal(ranMs(s, T0 + 64 * 60_000), 4 * 60_000);
  const before = run(s, [[{ type: 'Tick', maxRunMs: 10 * 60_000, backgroundCapMs: 1e9 }, { now: T0 + 69 * 60_000 }]]);
  assert.ok(live(before.s));
  const { s: stopped, fx } = run(s, [[{ type: 'Tick', maxRunMs: 10 * 60_000, backgroundCapMs: 1e9 }, { now: T0 + 71 * 60_000 }]]);
  assert.equal(statusOf(stopped), 'stopped');
  assert.equal(of(fx, 'report')[0]!.text, 'Stopped after 10 minutes: the run-time limit set by the person.');
  const l = run(lead(), [{ type: 'TurnStarted' }, [{ type: 'Tick', maxRunMs: 1, backgroundCapMs: 1e9 }, { now: T0 + 1e9 }]]).s;
  assert.equal(l.phase, 'running');
});

test('row 22: waiting on background work alone for the cap → finished with the note', () => {
  const w = run(running(), [{ type: 'Background', active: 1 }, { type: 'TurnEnded', text: 'Server up.', interrupted: false }]).s;
  const early = run(w, [[{ type: 'Tick', maxRunMs: 0, backgroundCapMs: 600_000 }, { now: T0 + 599_999 }]]);
  assert.ok(live(early.s));
  const { s, fx } = run(w, [[{ type: 'Tick', maxRunMs: 0, backgroundCapMs: 600_000 }, { now: T0 + 600_000, lastText: 'Server up.' }]]);
  assert.equal(statusOf(s), 'done');
  assert.equal(of(fx, 'report')[0]!.text, `Server up.\n\n${BACKGROUND_CLOSED}`);
});

test('row 23: the person stops a working agent → stopped, marked, held dropped, report if owed', () => {
  const { s, fx } = run(running(), [{ type: 'ChildStarted' }, { type: 'Stop', by: 'person', why: 'Stopped by the person.' }]);
  assert.equal(statusOf(s), 'stopped');
  assert.equal(s.stoppedByPerson, true);
  assert.ok(has(fx, 'dropHeld') && has(fx, 'stopChildren') && has(fx, 'save'));
  assert.deepEqual(of(fx, 'report'), [{ type: 'report', status: 'stopped', text: 'Stopped by the person.' }]);
  const done = ended();
  const again = run(done, [{ type: 'Stop', by: 'person', why: 'x' }]);
  assert.equal(again.s.stoppedByPerson, false, 'a finished helper is not marked');
  assert.equal(again.fx.length, 0);
});

test('row 24: an agent stops one below it → stopped, no report, not marked', () => {
  const { s, fx } = run(running(), [{ type: 'Stop', by: 'agent', why: 'Stopped by "alpha".' }]);
  assert.equal(statusOf(s), 'stopped');
  assert.equal(s.stoppedByPerson, false);
  assert.ok(!has(fx, 'report'));
  assert.ok(has(fx, 'childEndedQuietly'));
});

test('row 25: an open approval card stops the run-time clock and shows as the wait reason', () => {
  const s = run(running(), [[{ type: 'ApprovalOpened' }, { now: T0 + 1000 }]]).s;
  assert.equal(waitReason(s), 'approval');
  assert.equal(s.run.since, undefined);
  assert.equal(s.run.ms, 1000);
});

test('row 26: woken after finishing → queued again, owes a report if its parent can receive one', () => {
  const s = run(ended(), [{ type: 'Woken', by: 'agent', parentCanReceive: true }]).s;
  assert.equal(s.phase, 'queued');
  assert.equal(s.owesReport, true);
  assert.equal(s.run.ms, 0, 'a new piece of work');
  const quiet = run(ended(), [{ type: 'Woken', by: 'agent', parentCanReceive: false }]).s;
  assert.equal(quiet.owesReport, false);
  const marked = run(running(), [{ type: 'Stop', by: 'person', why: 'x' }]).s;
  assert.equal(run(marked, [{ type: 'Woken', by: 'person', parentCanReceive: true }]).s.stoppedByPerson, false, 'the person clears the mark');
});

test('row 27: restored after a restart → working agents stopped, the lead idle, nobody owes a report', () => {
  const w = run(running(), [{ type: 'ChildStarted' }, { type: 'TurnEnded', text: 'x', interrupted: false }]).s;
  const s = run(w, [{ type: 'Restored' }]).s;
  assert.equal(statusOf(s), 'stopped');
  assert.equal(s.end!.error, 'Masthead was closed while this agent was working.');
  assert.equal(s.owesReport, false);
  assert.equal(holding(s), false);
  const l = run(run(lead(), [{ type: 'ChildStarted' }, { type: 'TurnEnded', text: 'x', interrupted: false }]).s, [{ type: 'Restored' }]).s;
  assert.equal(l.phase, 'idle');
  assert.equal(statusOf(run(ended(), [{ type: 'Restored' }]).s), 'done', 'finished agents stay as they were');
});

test('invariants: no sequence leaves a sub-agent waiting with nothing holding it; ended agents hold nothing; step is pure', () => {
  const events: Event[] = [
    { type: 'ChildStarted' }, { type: 'ChildEnded', reported: false }, { type: 'Asked', from: 'b' }, { type: 'AnswerArrived' },
    { type: 'Background', active: 1 }, { type: 'BackgroundIdle' }, { type: 'TurnStarted' }, { type: 'TurnEnded', text: 't', interrupted: false },
    { type: 'TurnEnded', text: '', interrupted: false, usageLimit: {} }, { type: 'Tick', maxRunMs: 0, backgroundCapMs: 1e12 },
    { type: 'RecipientTurnEnded', recipientIsLead: false, interrupted: false }, { type: 'ApprovalOpened' }, { type: 'ApprovalClosed' },
  ];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed);
  for (let trial = 0; trial < 300; trial++) {
    let s = running();
    let now = T0;
    for (let i = 0; i < 25; i++) {
      const ev = events[rnd() % events.length]!;
      now += 20 * 60_000;
      const frozen = JSON.stringify(s);
      const r = step(s, ev, ctx({ now }));
      assert.equal(JSON.stringify(s), frozen, 'step does not change its input');
      s = r.state;
      if (s.phase === 'waiting' && !s.lead) assert.ok(holding(s), `waiting with nothing holding it after ${ev.type}`);
      if (s.phase === 'ended') assert.equal(holding(s), false);
    }
  }
});
