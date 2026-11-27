// The conformance suite every backend must pass. It talks to a backend only through the interface in
// server/backends/types.ts and uses plain prompts that a real model follows too, so the same cases run
// against the fake (in `npm test`, via test/fake-backend.test.ts) and against a real backend in a live
// run (`runConformance('claude-code', …, { live: true })`). Cases the backend's caps rule out are skipped.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { EFFORTS } from '../shared/protocol.ts';
import type { Backend, PermissionAnswer, PermissionAsk, Session, SessionEvents, SessionSpec, ToolDef, TurnResult } from '../server/backends/types.ts';

export interface ConformanceOptions {
  /** A model id the backend lists; the cheapest is best for live runs. Defaults to the first listed. */
  model?: string;
  /** Per-case time limit. */
  timeoutMs?: number;
  /** Real backend: skip cases that only a scripted backend can make happen on demand. */
  live?: boolean;
  /** Answer given to permission requests (default allow). */
  answer?: (ask: PermissionAsk) => PermissionAnswer;
}

/** Everything a session reported, in order, plus helpers to wait for it. */
export class Recorder implements SessionEvents {
  readonly log: Array<{ ev: string; data?: unknown }> = [];
  readonly turns: TurnResult[] = [];
  readonly asks: PermissionAsk[] = [];
  sessionId: string | null = null;
  exitedWith: { failure?: string; sessionMissing?: boolean } | null = null;
  private waiters: Array<() => void> = [];

  constructor(private answer: (ask: PermissionAsk) => PermissionAnswer = () => ({ decision: 'allow' })) {}

  private add(ev: string, data?: unknown): void {
    this.log.push({ ev, data });
    for (const w of this.waiters.splice(0)) w();
  }
  until(what: string, cond: () => boolean, ms = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for: ${what}`)), ms);
      const check = () => {
        if (cond()) {
          clearTimeout(timer);
          resolve();
        } else this.waiters.push(check);
      };
      check();
    });
  }
  index(ev: string): number {
    return this.log.findIndex((e) => e.ev === ev);
  }
  count(ev: string): number {
    return this.log.filter((e) => e.ev === ev).length;
  }

  sessionStarted(id: string): void {
    this.sessionId = id;
    this.add('sessionStarted', id);
  }
  turnStarted(): void {
    this.add('turnStarted');
  }
  text(final: string, isError?: boolean): void {
    this.add('text', { final, isError });
  }
  thinking(text: string): void {
    this.add('thinking', text);
  }
  draft(d: { kind: 'text' | 'thinking'; append: string } | null): void {
    this.add('draft', d);
  }
  toolStarted(t: { id: string; name: string; input: unknown }): void {
    this.add('toolStarted', t);
  }
  toolFinished(t: { id: string; result: string; isError: boolean; images?: unknown[] }): void {
    this.add('toolFinished', t);
  }
  turnEnded(r: TurnResult): void {
    this.turns.push(r);
    this.add('turnEnded', r);
  }
  rateLimit(n: unknown): void {
    this.add('rateLimit', n);
  }
  background(ids: string[]): void {
    this.add('background', ids);
  }
  usage(u: unknown): void {
    this.add('usage', u);
  }
  exited(r: { failure?: string; sessionMissing?: boolean }): void {
    this.exitedWith = r;
    this.add('exited', r);
  }
  async askPermission(ask: PermissionAsk): Promise<PermissionAnswer> {
    this.asks.push(ask);
    this.add('askPermission', ask);
    return this.answer(ask);
  }
  compacted(): void {
    this.add('compacted');
  }
  activity(text: string | undefined): void {
    this.add('activity', text);
  }
}

/** Session folders made by spec(); removed when the test file ends (also for live runs outside run-tests). */
const folders: string[] = [];
after(() => {
  for (const d of folders.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
function workFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'masthead-conf-'));
  folders.push(dir);
  return dir;
}

export function spec(over: Partial<SessionSpec> & { model: string }): SessionSpec {
  return {
    effort: 'low',
    cwd: workFolder(),
    instructions: 'You are taking part in an automated test. Follow each instruction literally and briefly.',
    tools: [],
    canAskPerson: true,
    permissionMode: 'default',
    lean: true,
    env: { ...process.env },
    ...over,
  };
}

/** Collects every id consumed by any turn so far. */
const consumedIds = (r: Recorder) => r.turns.flatMap((t) => t.consumed ?? []);

export function runConformance(name: string, make: () => Backend, opts: ConformanceOptions = {}): void {
  const timeout = opts.timeoutMs ?? (opts.live ? 180_000 : 10_000);
  describe(`backend conformance: ${name}`, () => {
    const backend = make();
    const caps = backend.caps;
    let model = opts.model ?? '';
    const sessions: Session[] = [];
    const open = (r: Recorder, over: Partial<SessionSpec> = {}) => {
      const s = backend.open(spec({ model, ...over }), r);
      sessions.push(s);
      return s;
    };
    const recorder = () => new Recorder(opts.answer);

    test('detect() and models() describe a usable backend', { timeout }, async () => {
      const info = await backend.detect();
      assert.equal(info.id, backend.id);
      assert.equal(info.available, true, info.error);
      assert.ok(info.version, 'a version');
      const models = await backend.models();
      assert.ok(models.length > 0, 'at least one model');
      for (const m of models) {
        assert.ok(m.id && m.label);
        for (const e of m.efforts) assert.ok(EFFORTS.includes(e), `effort ${e} is a Masthead level`);
        for (const e of m.efforts) assert.ok(m.nativeEffort[e], `effort ${e} maps to a native value`);
      }
      for (const e of caps.efforts) assert.ok(EFFORTS.includes(e));
      if (!model) model = (models.find((m) => m.default) ?? models[0]!).id;
    });

    test('a session starts, answers, and names the message it consumed', { timeout }, async () => {
      const r = recorder();
      const s = open(r);
      const id = randomUUID();
      s.send(id, 'Reply with exactly the word PONG');
      await r.until('turn ended', () => r.turns.length >= 1 || r.exitedWith !== null, timeout);
      assert.equal(r.exitedWith, null, `exited: ${r.exitedWith?.failure}`);
      assert.ok(r.sessionId, 'sessionStarted');
      assert.ok(r.index('sessionStarted') < r.index('turnEnded'));
      assert.ok(r.index('turnStarted') >= 0 && r.index('turnStarted') < r.index('turnEnded'), 'turnStarted before turnEnded');
      const t = r.turns[0]!;
      assert.equal(t.interrupted, false);
      assert.equal(t.error, undefined);
      assert.match(t.text, /PONG/);
      if (caps.consumedIds) assert.deepEqual(t.consumed, [id]);
      else assert.equal(t.consumed, null);
      assert.ok(r.log.some((e) => e.ev === 'text' && /PONG/.test((e.data as { final: string }).final)), 'a final text event');
      s.close('graceful');
    });

    test('a team tool is called through the ToolDef given to the session', { timeout }, async () => {
      const calls: unknown[] = [];
      const tool: ToolDef = {
        name: 'echo_tool',
        description: 'Returns a confirmation for the given word. Call it when asked to.',
        input: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
        run: async (input) => {
          calls.push(input);
          return `TOOL-OK-${(input as { word?: string }).word}`;
        },
      };
      const r = recorder();
      const s = open(r, { tools: [tool] });
      s.send(randomUUID(), 'Call the tool echo_tool with input {"word":"kiwi"} and then reply with the result it returned.');
      await r.until('turn ended', () => r.turns.length >= 1 || r.exitedWith !== null, timeout);
      assert.deepEqual(calls, [{ word: 'kiwi' }]);
      const started = r.log.find((e) => e.ev === 'toolStarted')?.data as { id: string; name: string } | undefined;
      assert.ok(started && started.name.endsWith('echo_tool'), 'toolStarted names the tool');
      const finished = r.log.find((e) => e.ev === 'toolFinished')?.data as { id: string; result: string } | undefined;
      assert.equal(finished?.id, started.id);
      assert.match(finished!.result, /TOOL-OK-kiwi/);
      assert.match(r.turns[0]!.text, /TOOL-OK-kiwi/);
      s.close('graceful');
    });

    test('a session is resumed by id and remembers', { timeout, skip: !caps.resume }, async () => {
      const r1 = recorder();
      const s1 = open(r1);
      s1.send(randomUUID(), 'Reply with exactly the word MANGO');
      await r1.until('first turn', () => r1.turns.length >= 1, timeout);
      s1.close('graceful');
      await new Promise((res) => setTimeout(res, opts.live ? 2000 : 10));
      const r2 = recorder();
      const s2 = open(r2, { resume: r1.sessionId! });
      s2.send(randomUUID(), 'What word did you reply with before? Reply with only that word.');
      await r2.until('resumed turn', () => r2.turns.length >= 1 || r2.exitedWith !== null, timeout);
      assert.equal(r2.exitedWith, null, `exited: ${r2.exitedWith?.failure}`);
      assert.equal(r2.sessionId, r1.sessionId, 'same session');
      assert.match(r2.turns[0]!.text, /MANGO/);
      s2.close('graceful');
    });

    test('resuming a session that does not exist reports sessionMissing, before any sessionStarted', { timeout, skip: !caps.resume }, async () => {
      const r = recorder();
      const s = open(r, { resume: randomUUID() });
      s.send(randomUUID(), 'Reply with exactly the word NOPE');
      await r.until('exited', () => r.exitedWith !== null, timeout);
      assert.equal(r.exitedWith!.sessionMissing, true);
      assert.equal(r.count('sessionStarted'), 0);
      assert.equal(r.turns.length, 0);
    });

    test('a message sent during a turn is not lost', { timeout, skip: !caps.midTurnDelivery }, async () => {
      const r = recorder();
      const s = open(r);
      const a = randomUUID();
      const b = randomUUID();
      s.send(a, 'Count slowly from 1 to 5, one number per line, then reply DONE.');
      await r.until('turn started', () => r.count('turnStarted') >= 1, timeout);
      s.send(b, 'Also reply with the word EXTRA.');
      await r.until('both consumed', () => (caps.consumedIds ? [a, b].every((id) => consumedIds(r).includes(id)) : r.turns.length >= 1) || r.exitedWith !== null, timeout);
      assert.equal(r.exitedWith, null);
      assert.ok(r.turns.some((t) => /EXTRA/.test(t.text)), 'the second message was answered');
      s.close('graceful');
    });

    test('interrupt ends the running turn as interrupted', { timeout, skip: !caps.interrupt }, async () => {
      const r = recorder();
      const s = open(r);
      s.send(randomUUID(), 'Count slowly from 1 to 5, one number per line, then reply DONE.');
      await r.until('turn started', () => r.count('turnStarted') >= 1, timeout);
      await s.interrupt();
      await r.until('turn ended', () => r.turns.length >= 1 || r.exitedWith !== null, timeout);
      assert.equal(r.turns[0]!.interrupted, true);
      s.close('now');
    });

    test('a permission request goes through askPermission and its answer is obeyed', { timeout, skip: caps.permissions !== 'callback' || opts.live }, async () => {
      const r = new Recorder(() => ({ decision: 'deny', message: 'not in this test' }));
      const s = backend.open(spec({ model, permissionMode: 'default' }), r);
      sessions.push(s);
      s.send(randomUUID(), 'Run the shell command `echo conformance` and tell me what it printed.');
      await r.until('turn ended', () => r.turns.length >= 1 || r.exitedWith !== null, timeout);
      assert.equal(r.asks.length, 1);
      assert.equal(r.asks[0]!.kind, 'command');
      assert.match(r.turns[0]!.text, /denied/i);
      s.close('now');
    });

    test('effort and model changes on a live session do not throw; close("now") reports no exit', { timeout }, async () => {
      const r = recorder();
      const s = open(r);
      s.send(randomUUID(), 'Reply with exactly the word READY');
      await r.until('turn ended', () => r.turns.length >= 1, timeout);
      if (caps.liveEffort) s.setEffort(caps.efforts[0] ?? 'low');
      if (caps.liveModel) {
        assert.ok(s.setModel, 'liveModel needs setModel');
        s.setModel!(model);
      }
      if (caps.contextUsage) {
        assert.ok(s.contextUsage, 'contextUsage needs the method');
        const u = await s.contextUsage!();
        assert.ok(u.used > 0 && u.max >= u.used);
      }
      s.close('now');
      await new Promise((res) => setTimeout(res, opts.live ? 1500 : 10));
      assert.equal(r.exitedWith, null, 'a requested close is not an unexpected exit');
    });
  });
}
