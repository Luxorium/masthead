import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { FakeBackend, fakeBackendSelected } from '../server/backends/fake/index.ts';
import { plan } from '../server/backends/fake/script.ts';
import { Recorder, runConformance, spec } from './backend-conformance.ts';

runConformance('fake', () => new FakeBackend());
runConformance('fake without mid-turn delivery or consumed ids', () => new FakeBackend({ caps: { midTurnDelivery: false, consumedIds: false, liveModel: false } }));

const turnDone = (r: Recorder, n = 1) => r.until(`${n} turns`, () => r.turns.length >= n || r.exitedWith !== null, 5000);

test('fake: selected only on purpose', () => {
  assert.equal(fakeBackendSelected({}), false);
  assert.equal(fakeBackendSelected({ MASTHEAD_BACKEND: 'fake' }), false);
  assert.equal(fakeBackendSelected({ MASTHEAD_ALLOW_FAKE: '1' }), false);
  assert.equal(fakeBackendSelected({ MASTHEAD_BACKEND: 'fake', MASTHEAD_ALLOW_FAKE: '1' }), true);
});

test('fake: the script is decided by the text alone', () => {
  assert.deepEqual(plan('hello'), [{ kind: 'reply', text: 'Fake reply: hello' }]);
  assert.deepEqual(plan('[[limit 30s]]'), [{ kind: 'limit', seconds: 30 }]);
  assert.deepEqual(plan('[[background 200ms]]').map((s) => s.kind), ['background', 'reply']);
  assert.deepEqual(plan('Reply with exactly the word X'), [{ kind: 'word', word: 'X' }]);
});

test('fake: thinking, an image tool result and a question', async () => {
  const b = new FakeBackend();
  const r = new Recorder((ask) => (ask.kind === 'question' ? { decision: 'allow', answers: { 'Which colour?': 'teal' } } : { decision: 'allow' }));
  const s = b.open(spec({ model: 'fake-large' }), r);
  s.send(randomUUID(), '[[think]] [[image]] [[question]]');
  await turnDone(r);
  assert.equal(r.count('thinking'), 1);
  const img = r.log.find((e) => e.ev === 'toolFinished' && (e.data as { images?: unknown[] }).images?.length);
  assert.ok(img, 'a tool result with an image');
  assert.equal(r.asks[0]!.kind, 'question');
  assert.match(r.turns[0]!.text, /COLOUR=teal/);
});

test('fake: a non-lead session cannot ask the person', async () => {
  const b = new FakeBackend();
  const r = new Recorder();
  b.open(spec({ model: 'fake-large', canAskPerson: false }), r).send(randomUUID(), '[[question]]');
  await turnDone(r);
  assert.equal(r.asks.length, 0);
});

test('fake: background work, then a turn the backend starts by itself', async () => {
  const b = new FakeBackend({ backgroundMs: 20 });
  const r = new Recorder();
  const s = b.open(spec({ model: 'fake-large' }), r);
  const id = randomUUID();
  s.send(id, 'Build it [[background]]');
  await turnDone(r, 2);
  const bg = r.log.filter((e) => e.ev === 'background').map((e) => (e.data as string[]).length);
  assert.deepEqual(bg, [1, 0]);
  assert.deepEqual(r.turns[0]!.consumed, [id]);
  assert.deepEqual(r.turns[1]!.consumed, [], 'self-started: consumes nothing');
  assert.match(r.turns[1]!.text, /finished/);
  assert.ok(r.index('background') < r.index('turnEnded'));
});

test('fake: a silent background task ends with no new turn', async () => {
  const b = new FakeBackend({ backgroundMs: 10 });
  const r = new Recorder();
  b.open(spec({ model: 'fake-large' }), r).send(randomUUID(), '[[background-silent]]');
  await r.until('emptied', () => r.log.filter((e) => e.ev === 'background').length === 2, 2000);
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(r.turns.length, 1);
});

test('fake: the usage limit is a rejected rate limit plus a rate_limit error', async () => {
  const b = new FakeBackend();
  const r = new Recorder();
  b.open(spec({ model: 'fake-large' }), r).send(randomUUID(), '[[limit 60s]]');
  await turnDone(r);
  const n = r.log.find((e) => e.ev === 'rateLimit')!.data as { status: string; resetsAt: number };
  assert.equal(n.status, 'rejected');
  assert.ok(n.resetsAt > Date.now() / 1000 && n.resetsAt < Date.now() / 1000 + 120, 'seconds since the epoch');
  assert.equal(r.turns[0]!.apiError, 'rate_limit');
  assert.ok(r.turns[0]!.error);
});

test('fake: an ordinary error and a crash', async () => {
  const b = new FakeBackend();
  const r1 = new Recorder();
  b.open(spec({ model: 'fake-large' }), r1).send(randomUUID(), '[[error tool broke]]');
  await turnDone(r1);
  assert.equal(r1.turns[0]!.error, 'tool broke');
  assert.equal(r1.turns[0]!.apiError, undefined);
  const r2 = new Recorder();
  b.open(spec({ model: 'fake-large' }), r2).send(randomUUID(), '[[crash]]');
  await r2.until('exited', () => r2.exitedWith !== null, 2000);
  assert.equal(r2.exitedWith!.sessionMissing, undefined);
  assert.equal(r2.turns.length, 0);
});

test('fake: a deleted session cannot be resumed', async () => {
  const b = new FakeBackend();
  const r1 = new Recorder();
  const s1 = b.open(spec({ model: 'fake-large' }), r1);
  s1.send(randomUUID(), 'hi');
  await turnDone(r1);
  s1.close('graceful');
  b.forget(r1.sessionId!);
  const r2 = new Recorder();
  b.open(spec({ model: 'fake-large', resume: r1.sessionId! }), r2).send(randomUUID(), 'hi again');
  await r2.until('exited', () => r2.exitedWith !== null, 2000);
  assert.equal(r2.exitedWith!.sessionMissing, true);
});

test('fake: without mid-turn delivery a message sent during a turn waits for the next turn', async () => {
  const b = new FakeBackend({ caps: { midTurnDelivery: false } });
  const r = new Recorder();
  const s = b.open(spec({ model: 'fake-large' }), r);
  const a = randomUUID();
  const c = randomUUID();
  s.send(a, 'Count slowly please');
  await r.until('started', () => r.count('turnStarted') === 1, 2000);
  s.send(c, 'Reply with exactly the word LATER');
  await turnDone(r, 2);
  assert.deepEqual(r.turns.map((t) => t.consumed), [[a], [c]]);
});
