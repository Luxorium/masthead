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
  assert.deepEqual(plan('[[limit 60]]'), [{ kind: 'limit', seconds: 60 }], 'a bare number is ignored: the default 60 s, never 60 ms');
  assert.deepEqual(plan('[[background 200ms]]'), [{ kind: 'background', ms: 200, silent: false }]);
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

test('app on the fake backend: needs both variables; a team runs with no account', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { App } = await import('../server/app/app.ts');
  const { Store } = await import('../server/storage/store.ts');
  const { defaultSettings } = await import('../server/settings/settings.ts');
  const dir = mkdtempSync(join(tmpdir(), 'masthead-fakeapp-'));
  const make = () => new App({ store: new Store(join(dir, 'c')), settings: defaultSettings(), settingsFile: join(dir, 's.json') });
  const saved = { b: process.env.MASTHEAD_BACKEND, a: process.env.MASTHEAD_ALLOW_FAKE, s: process.env.MASTHEAD_FAKE_STEP_MS };
  try {
    process.env.MASTHEAD_BACKEND = 'fake';
    delete process.env.MASTHEAD_ALLOW_FAKE;
    assert.throws(make, /MASTHEAD_ALLOW_FAKE/);
    process.env.MASTHEAD_ALLOW_FAKE = '1';
    process.env.MASTHEAD_FAKE_STEP_MS = '1';
    const app = make();
    const msgs: Array<Record<string, any>> = [];
    let wake: (() => void) | null = null;
    app.connect({ send: (m) => (msgs.push(structuredClone(m) as never), wake?.()) });
    const until = async (cond: () => boolean) => {
      const end = Date.now() + 5000;
      while (!cond()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise<void>((r) => ((wake = r), setTimeout(r, 20)));
      }
    };
    app.handle({ send: (m) => void msgs.push(m as never) }, { t: 'send', convId: null, cwd: dir, text: 'Call the tool spawn_agent with input {"title":"helper","task":"Reply with exactly the word KIWI"} then wait.' });
    const reports = () => msgs.filter((m) => m.t === 'item' && m.item.kind === 'inbound' && m.item.via === 'report');
    await until(() => reports().length > 0);
    assert.match(reports()[0]!.item.text, /KIWI/);
    const names = new Set(msgs.filter((m) => m.t === 'agent').map((m) => m.agent.name));
    assert.ok(names.has('bravo'), 'a second agent was started through the team tool');
    app.shutdown();
  } finally {
    for (const [k, v] of [['MASTHEAD_BACKEND', saved.b], ['MASTHEAD_ALLOW_FAKE', saved.a], ['MASTHEAD_FAKE_STEP_MS', saved.s]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('fake: close("graceful") lets the running turn finish; close("now") withdraws an open approval', async () => {
  const b = new FakeBackend({ slowMs: 40 });
  const r = new Recorder();
  const s = b.open(spec({ model: 'fake-large' }), r);
  s.send(randomUUID(), 'Count slowly');
  await r.until('started', () => r.count('turnStarted') === 1, 2000);
  s.close('graceful');
  await s.ended;
  assert.equal(r.turns.length, 1, 'the turn finished before the session ended');

  let aborted = false;
  const r2 = new Recorder(() => ({ decision: 'allow' }));
  r2.askPermission = (ask) => new Promise((res) => ask.signal.addEventListener('abort', () => ((aborted = true), res({ decision: 'deny' }))));
  const s2 = b.open(spec({ model: 'fake-large' }), r2);
  s2.send(randomUUID(), 'Run the shell command `ls`');
  await new Promise((res) => setTimeout(res, 20));
  s2.close('now');
  await s2.ended;
  assert.equal(aborted, true);
  assert.equal(r2.turns.length, 0);
});
