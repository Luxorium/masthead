import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Agent, BACKGROUND_GRACE_MS, type AgentHost, type TurnOutcome } from '../server/runtime/agent.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Scheduler } from '../server/core/scheduler.ts';
import type { AgentInfo, Item, Settings, Tier } from '../shared/protocol.ts';

const tick = () => new Promise((r) => setImmediate(r));
async function ticks(n = 5) {
  for (let i = 0; i < n; i++) await tick();
}

/** A stand-in for one Claude Code process: the test decides what it says. */
class FakeProcess {
  readonly received: SDKUserMessage[] = [];
  readonly flags: Array<Record<string, unknown>> = [];
  readonly models: Array<string | undefined> = [];
  private out: unknown[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private failure: Error | null = null;
  readonly q: Query;

  constructor(
    prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
  ) {
    void (async () => {
      for await (const m of prompt) this.received.push(m);
      // Like Claude Code, the process exits once its input ends.
      this.end();
    })();
    const self = this;
    this.q = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (self.out.length > 0) yield self.out.shift();
          if (self.failure) throw self.failure;
          if (self.ended) return;
          await new Promise<void>((r) => (self.wake = r));
          self.wake = null;
        }
      },
      close: () => self.end(),
      interrupt: async () => {},
      applyFlagSettings: async (f: Record<string, unknown>) => void self.flags.push(f),
      setModel: async (model?: string) => void self.models.push(model),
      getContextUsage: async () => ({ totalTokens: 1234, maxTokens: 200_000 }),
    } as unknown as Query;
  }

  get uuids(): string[] {
    return this.received.map((m) => m.uuid as string);
  }
  say(m: Record<string, unknown>): void {
    this.out.push(m);
    this.wake?.();
  }
  init(sessionId = 'session-1'): void {
    this.say({ type: 'system', subtype: 'init', session_id: sessionId, model: 'm' });
  }
  result(text: string, uuids?: string[]): void {
    this.say({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0, ...(uuids ? { user_message_uuids: uuids } : {}) });
  }
  tasks(...ids: string[]): void {
    this.say({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((id) => ({ task_id: id, task_type: 'local_bash', description: id })) });
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  fail(message: string): void {
    this.failure = new Error(message);
    this.wake?.();
  }
}

function fakeHost(scheduler: Scheduler, settings: () => Settings = defaultSettings) {
  const processes: FakeProcess[] = [];
  const idle: string[] = [];
  const turns: TurnOutcome[] = [];
  const lost: string[] = [];
  const limits: Array<{ resetsAt?: number } | undefined> = [];
  const items: Item[] = [];
  const host: AgentHost = {
    cwd: '/tmp',
    scheduler,
    settings,
    claudePath: () => '/usr/bin/false',
    parentName: () => 'alpha',
    tools: () => [],
    agentChanged: () => {},
    itemChanged: (_a, item) => void items.push(item),
    draftChanged: () => {},
    rateLimit: () => {},
    askPermission: async () => ({ decision: 'allow' }),
    turnEnded: (_a, outcome) => void turns.push(outcome),
    backgroundIdle: (a) => void idle.push(a.name),
    processLost: (a, message, usageLimit) => {
      lost.push(message);
      limits.push(usageLimit);
      scheduler.release(a.tier, a.id);
    },
    query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const p = new FakeProcess(prompt, options);
      processes.push(p);
      return p.q;
    }) as unknown as AgentHost['query'],
  };
  return { host, processes, turns, lost, items, idle, limits };
}

/** A copy of the settings with one tier changed, in the profiles and in the old `tiers` view. */
function withTier(s: Settings, id: 'lead' | 'opus' | 'sonnet' | 'haiku', patch: { model?: string; effort?: Settings['tiers']['lead']['effort'] }): Settings {
  return {
    ...s,
    profiles: s.profiles.map((p) => ({ ...p, tiers: p.tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
    tiers: { ...s.tiers, [id]: { ...s.tiers[id], ...patch } },
  };
}

function info(name: string, tier: Tier = 'sonnet'): AgentInfo {
  return {
    id: randomUUID(),
    convId: 'conv',
    name,
    tier,
    parentId: 'parent',
    title: '',
    task: 'task',
    status: 'queued',
    model: 'claude-sonnet-5-5',
    effort: 'low',
    createdAt: Date.now(),
    usage: { context: 0, contextMax: 1_000_000, output: 0, costUsd: 0, turns: 0 },
  };
}

test('agent: one ended while waiting for a slot is never launched, even if the slot is granted first', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'task a' });
  const b = new Agent(info('charlie'), host, { owesReport: true, seed: 'task b' });
  a.start();
  b.start();
  await ticks();
  assert.equal(processes.length, 1);
  assert.equal(b.status, 'queued');
  // As stopTree does: ending a hands its slot to b in the same pass, then b is ended too.
  a.end('stopped', 'Stopped.');
  b.end('stopped', 'Stopped.');
  await ticks();
  assert.equal(processes.length, 1, 'b must not start a process');
  assert.equal(b.status, 'stopped');
  assert.equal(b.hasProcess, false);
  assert.equal(sched.running('sonnet'), 0);
});

test('agent: an ended agent can still be resumed afterwards', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, turns } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  p.result('Done.', p.uuids);
  await ticks();
  assert.equal(turns.length, 1);
  a.end('done');
  p.end();
  await ticks();
  a.deliver('one more thing');
  await ticks();
  assert.equal(processes.length, 2);
  assert.equal(processes[1]!.options.resume, 'session-1');
  assert.equal(a.status, 'running');
});

test('agent: a follow-up turn does not replace the earlier turn in the outcome', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, turns } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'audit this' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  a.deliver('a late message');
  await ticks();
  const [task, late] = p.uuids;
  p.result('Findings: three bugs.', [task!]);
  await ticks();
  assert.equal(turns.length, 0, 'the late message is still unanswered');
  p.result('Noted.', [late!]);
  await ticks();
  assert.equal(turns.length, 1);
  assert.match(turns[0]!.text, /Findings: three bugs\./);
  assert.match(turns[0]!.text, /Noted\./);
  assert.ok(turns[0]!.text.indexOf('Findings') < turns[0]!.text.indexOf('Noted'));
  assert.equal(a.lastText, turns[0]!.text);

  // The next run starts empty.
  a.deliver('next');
  await ticks();
  p.result('Second run.', [p.uuids[2]!]);
  await ticks();
  assert.equal(turns[1]!.text, 'Second run.');
});

test('agent: a turn that names no messages does not clear ones still queued', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, turns } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  p.result('Started a build in the background.', [p.uuids[0]!]);
  await ticks();
  assert.equal(turns.length, 1);
  a.deliver('status?');
  await ticks();
  // A turn Claude Code started by itself (the background build finished) names nothing.
  p.result('The build finished.');
  await ticks();
  assert.equal(a.busy, true, 'the question is still unanswered');
  assert.equal(turns.length, 1);
  p.result('All green.', [p.uuids[1]!]);
  await ticks();
  assert.equal(a.busy, false);
  assert.equal(turns.length, 2);
  assert.match(turns[1]!.text, /All green\./);
});

test('agent: with a Claude Code that never names messages, a result still ends the turn', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, turns } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  p.result('Done.');
  await ticks();
  assert.equal(a.busy, false);
  assert.equal(turns.length, 1);
});

test('agent: a resume whose session is gone starts fresh once and re-sends the message', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, turns, lost, items } = fakeHost(sched);
  const a = new Agent({ ...info('bravo'), status: 'done' }, host, { sessionId: 'gone' });
  a.deliver('are you there?');
  await ticks();
  const first = processes[0]!;
  assert.equal(first.options.resume, 'gone');
  first.fail('Claude Code process exited with code 1. stderr: No conversation found with session ID: gone');
  await ticks();
  assert.equal(lost.length, 0);
  assert.equal(processes.length, 2);
  const second = processes[1]!;
  assert.equal(second.options.resume, undefined);
  assert.equal(a.sessionId, null);
  assert.ok(items.some((i) => i.kind === 'notice' && /starts fresh/.test(i.text)));
  const texts = second.received.map((m) => String(m.message.content));
  assert.ok(texts.includes('are you there?'));
  second.init('session-2');
  second.result('Yes.', second.uuids);
  await ticks();
  assert.equal(a.sessionId, 'session-2');
  assert.equal(turns.length, 1);
});

test('agent: a resume that fails for another reason is reported, not retried', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, lost } = fakeHost(sched);
  const a = new Agent({ ...info('bravo'), status: 'done' }, host, { sessionId: 'kept' });
  a.deliver('hello');
  await ticks();
  processes[0]!.fail('Claude Code process exited with code 1. stderr: network unreachable');
  await ticks();
  assert.equal(processes.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(a.sessionId, 'kept');
});

test('agent: background work keeps the run open until the turn Claude Code starts by itself', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, turns, idle } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'build it' });
  a.start();
  await ticks();
  const p = processes[0]!;
  // The sequence seen from Claude Code 2.1.331 for a Bash command with run_in_background.
  p.init();
  p.tasks('b1');
  p.result('Build started; I will report when it ends.', [p.uuids[0]!]);
  await ticks();
  assert.equal(turns.length, 1);
  assert.equal(a.hasBackgroundWork, true);
  p.tasks();
  p.init();
  p.say({ type: 'result', subtype: 'success', is_error: false, result: 'DONE: build passed.', total_cost_usd: 0, origin: { kind: 'task-notification' } });
  await ticks();
  assert.equal(a.hasBackgroundWork, false);
  assert.equal(turns.length, 2);
  assert.match(turns[1]!.text, /Build started/);
  assert.match(turns[1]!.text, /DONE: build passed\./);
  assert.deepEqual(idle, [], 'a turn followed, so no idle signal');
});

test('agent: background work that ends with no new turn is reported idle after the grace time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sched = new Scheduler(() => 1);
  const { host, processes, turns, idle } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'serve it' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  p.tasks('b1');
  p.say({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: '' }, { task_id: 'w', task_type: 'monitor', description: '', ambient: true }] });
  p.result('Started.', [p.uuids[0]!]);
  await ticks();
  assert.equal(turns.length, 1);
  // b1 ends; only an ambient watcher is left.
  p.say({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w', task_type: 'monitor', description: '', ambient: true }] });
  await ticks();
  assert.equal(a.hasBackgroundWork, false, 'ambient tasks do not count');
  t.mock.timers.tick(BACKGROUND_GRACE_MS - 1);
  assert.deepEqual(idle, []);
  t.mock.timers.tick(1);
  assert.deepEqual(idle, ['bravo']);
});

test('agent: a process that exits with background work running is lost as usual', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, lost } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  p.tasks('b1');
  p.result('Waiting.', [p.uuids[0]!]);
  await ticks();
  p.fail('killed');
  await ticks();
  assert.equal(a.hasBackgroundWork, false);
  assert.deepEqual(lost, ['killed']);
});

test('agent: applySettings caps effort, sets fixed effort and switches the lead model', async () => {
  let settings = defaultSettings();
  const sched = new Scheduler(() => 1);
  const { host, processes } = fakeHost(sched, () => settings);
  const s = new Agent({ ...info('bravo'), effort: 'high' }, host, { owesReport: true, seed: 'task' });
  s.start();
  await ticks();
  assert.equal(s.info.effort, 'high');
  settings = withTier(settings, 'sonnet', { effort: 'medium' });
  s.applySettings(settings);
  await ticks();
  assert.equal(s.info.effort, 'medium');
  assert.deepEqual(processes[0]!.flags, [{ effortLevel: 'medium' }]);
  settings = { ...withTier(settings, 'sonnet', { effort: 'low' }), autoEffort: false };
  s.applySettings(settings);
  await ticks();
  assert.equal(s.info.effort, 'low');

  const lead = new Agent({ ...info('alpha', 'lead'), parentId: null, model: settings.tiers.lead.model }, host);
  lead.deliver('hi');
  await ticks();
  settings = withTier(settings, 'lead', { model: 'claude-opus-5-5' });
  lead.applySettings(settings);
  await ticks();
  assert.equal(lead.info.model, 'claude-opus-5-5');
  assert.deepEqual(processes[1]!.models, ['claude-opus-5-5']);

  // An agent without a process is left alone; launch() reads the settings.
  const idleAgent = new Agent({ ...info('charlie'), effort: 'high', status: 'done' }, host, { sessionId: 's' });
  idleAgent.applySettings(settings);
  assert.equal(idleAgent.info.effort, 'high');
});

test('agent: a change to automatic effort relaunches the process before its next turn, not during one', async () => {
  let settings = defaultSettings();
  const sched = new Scheduler(() => 1);
  const { host, processes, turns } = fakeHost(sched, () => settings);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init('session-1');
  settings = { ...settings, autoEffort: false };
  a.applySettings(settings);
  // Mid-turn: a message goes into the running process.
  a.deliver('also this');
  await ticks();
  assert.equal(processes.length, 1);
  p.result('Done both.', p.uuids);
  await ticks();
  assert.equal(turns.length, 1);
  // Between turns: the next message resumes the session in a new process.
  a.deliver('next job');
  await ticks();
  assert.equal(processes.length, 2);
  assert.equal(processes[1]!.options.resume, 'session-1');
  assert.deepEqual(processes[1]!.received.map((m) => m.message.content), ['next job']);
  assert.equal(sched.running('sonnet'), 1);
  assert.equal(a.status, 'running');
});

test('agent: a sub-agent reads its real context size when a turn ends', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  p.result('Done.', p.uuids);
  await ticks();
  assert.equal(a.info.usage.contextMax, 200_000);
  assert.equal(a.info.usage.context, 1234);
});

const rejected = (resetsAt: number) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt, status: 'rejected' } } },
});
const limitTurn = (p: FakeProcess, uuids: string[]) => {
  p.say({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your limit" }] } });
  p.say({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit", total_cost_usd: 0, user_message_uuids: uuids });
};

test('agent: a usage-limit turn is reported at once, closes the process, and holds only unconsumed messages', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, turns } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'the task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init('session-1');
  a.deliver('a queued note');
  await ticks();
  const [task] = p.uuids;
  p.tasks('b1');
  p.say(rejected(1_796_144_400));
  limitTurn(p, [task!]);
  await ticks();
  assert.equal(turns.length, 1, 'reported although the note is still queued');
  assert.deepEqual(turns[0]!.usageLimit, { resetsAt: 1_796_144_400_000, backgroundStopped: true });
  assert.equal(a.busy, false, 'held messages do not count as busy');
  assert.equal(a.hasProcess, false, 'the process is closed at the limit');
  // Resuming starts a new process on the same session: the note (never consumed) goes first, then the
  // new message. The task was consumed by the failed turn and is already in the session.
  a.deliver('carry on');
  await ticks();
  assert.equal(processes.length, 2);
  assert.equal(processes[1]!.options.resume, 'session-1');
  assert.deepEqual(processes[1]!.received.map((m) => m.message.content), ['a queued note', 'carry on']);
  assert.equal(a.busy, true);
});

test('agent: turns already on their way at the limit do not mark a paused agent running, and are reported', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, turns } = fakeHost(sched);
  // Act as the conversation does: pause the agent when a turn reports the usage limit.
  host.turnEnded = (ag, outcome) => {
    turns.push(outcome);
    if (outcome.usageLimit) {
      ag.info.pausedUntil = outcome.usageLimit.resetsAt ?? 1;
      ag.setStatus('waiting');
    }
  };
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'the task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  a.deliver('a queued note');
  await ticks();
  const [task, note] = p.uuids;
  p.say(rejected(100));
  limitTurn(p, [task!]);
  // Already written by Claude Code before the close: the queued note's turn, and a self-started one.
  p.init();
  limitTurn(p, [note!]);
  p.init();
  p.say({ type: 'result', subtype: 'success', is_error: false, result: 'self-started', total_cost_usd: 0 });
  await ticks();
  assert.equal(a.status, 'waiting');
  assert.equal(turns.length, 3);
  assert.ok(turns.every((t) => t.usageLimit), 'every limited turn carries usageLimit');
});

test('agent: with settings stale and background work running, a message goes into the live process', async () => {
  let settings = defaultSettings();
  const sched = new Scheduler(() => 1);
  const { host, processes, turns } = fakeHost(sched, () => settings);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  p.tasks('b1');
  p.result('Started.', [p.uuids[0]!]);
  await ticks();
  settings = { ...settings, autoEffort: false };
  a.applySettings(settings);
  a.deliver('status?');
  await ticks();
  assert.equal(processes.length, 1, 'no relaunch while background work runs');
  assert.equal(p.received.length, 2);
  p.result('Still running.', [p.uuids[1]!]);
  await ticks();
  assert.equal(a.busy, false);
  assert.equal(turns.length, 2);
});

test('agent: the text of a long run keeps only the newest turns', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, turns } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  p.tasks('b1');
  p.result('turn 0', [p.uuids[0]!]);
  for (let i = 1; i < 12; i++) {
    p.init();
    p.say({ type: 'result', subtype: 'success', is_error: false, result: `turn ${i}`, total_cost_usd: 0 });
  }
  p.tasks();
  p.init();
  p.say({ type: 'result', subtype: 'success', is_error: false, result: 'x'.repeat(70_000), total_cost_usd: 0 });
  await ticks();
  const last = turns[turns.length - 1]!.text;
  assert.ok(last.startsWith('(earlier text not shown)'));
  assert.ok(!last.includes('turn 0'));
  assert.ok(last.length < 71_000, 'older texts are dropped once the total is too long');
});

test('agent: an ordinary error is not a usage limit, and end() drops held messages', async () => {
  const sched = new Scheduler(() => 4);
  const { host, processes, turns } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  // A 429 without a rejected rate_limit_event (a busy API, not the person's limit).
  limitTurn(p, [p.uuids[0]!]);
  await ticks();
  assert.equal(turns[0]!.usageLimit, undefined);
  assert.ok(turns[0]!.error);

  const b = new Agent(info('charlie'), host, { owesReport: true, seed: 'task b' });
  b.start();
  await ticks();
  const q = processes[1]!;
  q.init();
  q.say(rejected(100));
  limitTurn(q, [q.uuids[0]!]);
  await ticks();
  assert.ok(turns[1]!.usageLimit);
  b.end('stopped');
  b.deliver('after a stop');
  await ticks();
  assert.deepEqual(processes[2]!.received.map((m) => m.message.content), ['after a stop']);
});

test('agent: a process lost at the usage limit says so and keeps its messages', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, lost, limits } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'the task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init();
  p.say(rejected(50));
  p.say({ type: 'assistant', error: 'rate_limit', message: { content: [] } });
  await ticks();
  p.fail('Claude Code process exited with code 1');
  await ticks();
  assert.equal(lost.length, 1);
  assert.deepEqual(limits[0], { resetsAt: 50_000 });
  assert.equal(a.busy, false);
  a.deliver('carry on');
  await ticks();
  assert.deepEqual(processes[1]!.received.map((m) => m.message.content), ['the task', 'carry on']);
});

test('agent: messages delivered from inside a usage-limit turnEnded reach a new process, or are dropped by end()', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, turns } = fakeHost(sched);
  // As the conversation does when it gives up pausing: flush the held messages at once.
  host.turnEnded = (ag, outcome) => {
    turns.push(outcome);
    if (outcome.usageLimit) ag.deliver('the limit was reached again');
  };
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'the task' });
  a.start();
  await ticks();
  const p = processes[0]!;
  p.init('session-1');
  a.deliver('a queued note');
  await ticks();
  p.say(rejected(100));
  limitTurn(p, [p.uuids[0]!]);
  await ticks();
  assert.equal(p.received.length, 2, 'nothing more went into the closed process');
  assert.equal(processes.length, 2);
  assert.deepEqual(processes[1]!.received.map((m) => m.message.content), ['a queued note', 'the limit was reached again']);
  assert.equal(processes[1]!.options.resume, 'session-1');

  // The fourth stop in a row: the conversation fails the agent instead.
  const b = new Agent(info('charlie'), host, { owesReport: true, seed: 'task b' });
  host.turnEnded = (ag, outcome) => {
    turns.push(outcome);
    if (outcome.usageLimit) ag.end('failed', 'usage limit');
  };
  a.end('done');
  await ticks();
  b.start();
  b.deliver('note b');
  await ticks();
  const q = processes[2]!;
  q.init();
  q.say(rejected(100));
  limitTurn(q, [q.uuids[0]!]);
  await ticks();
  assert.equal(b.status, 'failed');
  assert.equal(b.busy, false);
  assert.equal(b.hasProcess, false);
  assert.equal(processes.length, 3, 'no process started for dropped messages');
  b.deliver('later');
  await ticks();
  assert.deepEqual(processes[3]!.received.map((m) => m.message.content), ['later'], 'held messages were dropped by end()');
});

test('claude adapter: approvals are translated both ways, and Masthead tools are allowed without asking', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes } = fakeHost(sched);
  const asked: unknown[] = [];
  host.askPermission = async (_a, ask) => {
    asked.push(ask.kind);
    if (ask.kind === 'question') return { decision: 'allow', answers: { 'Which?': 'A' } };
    return { decision: ask.canAlways ? 'always' : 'deny', message: 'no' };
  };
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'task' });
  a.start();
  await ticks();
  const can = processes[0]!.options.canUseTool!;
  const signal = new AbortController().signal;
  const rules = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }];
  assert.deepEqual(await can('mcp__masthead__spawn_agent', { x: 1 }, { signal } as never), { behavior: 'allow', updatedInput: { x: 1 } });
  assert.deepEqual(await can('Bash', { command: 'ls' }, { signal, suggestions: rules } as never), { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: rules });
  assert.deepEqual(await can('Bash', { command: 'rm' }, { signal } as never), { behavior: 'deny', message: 'no' });
  assert.deepEqual(await can('AskUserQuestion', { questions: [] }, { signal } as never), { behavior: 'allow', updatedInput: { questions: [], answers: { 'Which?': 'A' } } });
  assert.deepEqual(asked, ['command', 'command', 'question']);
  assert.deepEqual(processes[0]!.options.disallowedTools?.includes('AskUserQuestion'), true, 'a sub-agent may not ask the person');
});

// ---- The same runtime rules on the scripted fake backend (backend-neutral) ----

import { FakeBackend } from '../server/backends/fake/index.ts';

function onFake(opts: ConstructorParameters<typeof FakeBackend>[0] = {}) {
  const sched = new Scheduler(() => 4);
  const backend = new FakeBackend(opts);
  const h = fakeHost(sched);
  h.host.backend = () => backend;
  const wait = async (cond: () => boolean) => {
    const end = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { ...h, backend, sched, wait };
}

test('runtime on fake: a turn ends with the reply, and the context size is read', async () => {
  const { host, turns, wait } = onFake();
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'Reply with exactly the word KIWI' });
  a.start();
  await wait(() => turns.length === 1);
  assert.equal(turns[0]!.text, 'KIWI');
  assert.ok(a.sessionId?.startsWith('fake-'));
  await wait(() => a.info.usage.contextMax === 200_000);
});

test('runtime on fake: a message during a slow turn joins the run and its text is kept', async () => {
  const { host, turns, wait } = onFake({ slowMs: 60 });
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'Count slowly please' });
  a.start();
  await wait(() => a.status === 'running' && a.hasProcess);
  await new Promise((r) => setTimeout(r, 10));
  a.deliver('Also reply with the word EXTRA');
  await wait(() => turns.length === 1);
  assert.match(turns[0]!.text, /DONE/);
  assert.match(turns[0]!.text, /EXTRA/);
  assert.equal(a.busy, false);
});

test('runtime on fake: background work, then the self-started turn ends the run', async () => {
  const { host, turns, wait } = onFake({ backgroundMs: 30 });
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'Build [[background]]' });
  a.start();
  await wait(() => turns.length === 1);
  assert.equal(a.hasBackgroundWork, true);
  await wait(() => turns.length === 2);
  assert.equal(a.hasBackgroundWork, false);
  assert.match(turns[1]!.text, /Started a background task/);
  assert.match(turns[1]!.text, /finished/);
});

test('runtime on fake: the usage limit is recognised, the process closed, later messages kept', async () => {
  const { host, turns, wait, backend } = onFake();
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: '[[limit 60s]]' });
  a.start();
  await wait(() => turns.length === 1);
  assert.ok(turns[0]!.usageLimit?.resetsAt && turns[0]!.usageLimit.resetsAt > Date.now());
  await wait(() => !a.hasProcess);
  assert.equal(backend.sessions[0]!.closed, 'now');
  a.deliver('Reply with exactly the word BACK');
  await wait(() => turns.length === 2);
  assert.equal(turns[1]!.text, 'BACK');
  assert.equal(backend.sessions[1]!.spec.resume, a.sessionId);
});

test('runtime on fake: a deleted session starts fresh once; a crash is a lost process', async () => {
  const { host, turns, lost, wait, backend, items } = onFake();
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'Reply with exactly the word ONE' });
  a.start();
  await wait(() => turns.length === 1);
  const old = a.sessionId!;
  a.end('done');
  await wait(() => !a.hasProcess);
  backend.forget(old);
  a.deliver('Reply with exactly the word TWO');
  await wait(() => turns.length === 2);
  assert.notEqual(a.sessionId, old);
  assert.ok(items.some((i) => i.kind === 'notice' && /starts fresh/.test(i.text)));
  a.deliver('[[crash]]');
  await wait(() => lost.length === 1);
  assert.match(lost[0]!, /crashed/);
});

test('runtime on fake: tool-result images are stored as blobs and their refs put on the tool item', async () => {
  const { host, turns, wait, items } = onFake();
  const stored: string[] = [];
  host.storeImage = (_a, data, mediaType) => {
    stored.push(mediaType);
    return data ? { ref: { hash: 'h1', mediaType } } : { error: 'invalid' };
  };
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: '[[image]]' });
  a.start();
  await wait(() => turns.length === 1);
  const done = items.filter((i) => i.kind === 'tool' && (i as { done?: boolean }).done) as Array<Item & { images?: unknown[] }>;
  assert.deepEqual(stored, ['image/png']);
  assert.deepEqual(done.at(-1)!.images, [{ hash: 'h1', mediaType: 'image/png' }]);
});

test('runtime on fake: a self-started turn moves a waiting agent back to running', async () => {
  const { host, turns, wait } = onFake({ backgroundMs: 40 });
  const seen: string[] = [];
  host.agentChanged = (ag) => void (seen.at(-1) !== ag.status && seen.push(ag.status));
  host.turnEnded = (ag, o) => {
    turns.push(o);
    ag.setStatus(ag.hasBackgroundWork ? 'waiting' : 'done');
  };
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: '[[background]]' });
  a.start();
  await wait(() => turns.length === 2);
  const i = seen.indexOf('waiting');
  assert.ok(i >= 0 && seen.slice(i).includes('running'), `statuses: ${seen.join(' ')}`);
});

test('runtime on fake: agents on a backend without background tracking are told so', async () => {
  const withBg = onFake();
  const noBg = onFake({ caps: { background: false } });
  for (const h of [withBg, noBg]) new Agent(info('bravo'), h.host, { owesReport: true, seed: 'hi' }).start();
  await withBg.wait(() => withBg.backend.sessions.length === 1 && noBg.backend.sessions.length === 1);
  const a = withBg.backend.sessions[0]!.spec.instructions;
  const b = noBg.backend.sessions[0]!.spec.instructions;
  assert.notEqual(a, b, 'the instructions differ by the background line');
});

test('runtime on fake: an effort change that does not reach the session relaunches it before the next turn', async () => {
  const { host, turns, wait, backend } = onFake();
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'hi' });
  a.start();
  await wait(() => turns.length === 1);
  backend.sessions[0]!.setEffort = () => Promise.reject(new Error('refused'));
  a.setEffort('high');
  await new Promise((r) => setTimeout(r, 10));
  a.deliver('again');
  await wait(() => turns.length === 2);
  assert.equal(backend.sessions.length, 2, 'a new session process');
  assert.equal(backend.sessions[1]!.spec.resume, a.sessionId);
  assert.equal(backend.sessions[1]!.spec.effort, 'high');
});

test('runtime on fake: a lead on a non-Claude profile (tier "codex:0") may ask the person and follows the settings model', async () => {
  const { host, wait, backend } = onFake();
  const lead = new Agent({ ...info('alpha'), tier: 'codex:0' as never, parentId: null }, host);
  lead.deliver('hi');
  await wait(() => backend.sessions.length === 1);
  assert.equal(backend.sessions[0]!.spec.canAskPerson, true);
  assert.equal(backend.sessions[0]!.spec.lean, false);
});

test('runtime on fake: a team tool reported under its bare name is shown like Claude Code\'s', async () => {
  const { host, turns, wait, items } = onFake();
  host.tools = () => [{ name: 'list_agents', description: 'd', input: { type: 'object', properties: {} }, run: async () => 'none' }];
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'Call the tool list_agents with input {}' });
  a.start();
  await wait(() => turns.length === 1);
  assert.ok(items.some((i) => i.kind === 'tool' && (i as { name: string }).name === 'mcp__masthead__list_agents'));
});

test('runtime on fake: without mid-turn delivery a message waits for the turn to end, then starts the next', async () => {
  const { host, turns, wait, backend } = onFake({ slowMs: 60, caps: { midTurnDelivery: false } });
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'Count slowly please' });
  a.start();
  await wait(() => a.status === 'running' && a.hasProcess);
  await new Promise((r) => setTimeout(r, 15));
  a.deliver('Reply with exactly the word LATER');
  assert.equal(backend.sessions[0]!.received.length, 1, 'kept back while the turn runs');
  assert.equal(a.busy, true);
  await wait(() => turns.length === 1);
  assert.equal(backend.sessions[0]!.received.length, 2);
  assert.match(turns[0]!.text, /DONE/);
  assert.match(turns[0]!.text, /LATER/, 'one run: both turns in the outcome');
});

test('runtime on fake: a tier the settings mark unusable starts nothing and says why', async () => {
  const settings = defaultSettings();
  for (const p of settings.profiles) for (const t of p.tiers) if (t.id === 'sonnet') t.unusable = '"bad name" is not a valid agent program name.';
  const sched = new Scheduler(() => 4);
  const backend = new FakeBackend();
  const h = fakeHost(sched, () => settings);
  h.host.backend = () => backend;
  const a = new Agent(info('bravo'), h.host, { owesReport: true, seed: 'hi' });
  a.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(backend.sessions.length, 0);
  assert.match(h.lost[0] ?? '', /can't be used: "bad name" is not a valid agent program name\. Edit the team in settings\./);
  assert.equal(sched.running('sonnet'), 0);
});
