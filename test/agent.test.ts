import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Agent, BACKGROUND_GRACE_MS, type AgentHost, type TurnOutcome } from '../server/agent.ts';
import { defaultSettings } from '../server/config.ts';
import { Scheduler } from '../server/scheduler.ts';
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
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 1 }),
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
  const items: Item[] = [];
  const host: AgentHost = {
    cwd: '/tmp',
    scheduler,
    settings,
    claudePath: () => '/usr/bin/false',
    parentName: () => 'alpha',
    tools: () => ({}) as ReturnType<AgentHost['tools']>,
    agentChanged: () => {},
    itemChanged: (_a, item) => void items.push(item),
    draftChanged: () => {},
    rateLimit: () => {},
    askPermission: async () => ({ behavior: 'allow', updatedInput: {} }),
    turnEnded: (_a, outcome) => void turns.push(outcome),
    backgroundIdle: (a) => void idle.push(a.name),
    processLost: (a, message) => {
      lost.push(message);
      scheduler.release(a.tier, a.id);
    },
    query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const p = new FakeProcess(prompt, options);
      processes.push(p);
      return p.q;
    }) as unknown as AgentHost['query'],
  };
  return { host, processes, turns, lost, items, idle };
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
  settings = { ...settings, tiers: { ...settings.tiers, sonnet: { ...settings.tiers.sonnet, effort: 'medium' } } };
  s.applySettings(settings);
  await ticks();
  assert.equal(s.info.effort, 'medium');
  assert.deepEqual(processes[0]!.flags, [{ effortLevel: 'medium' }]);
  settings = { ...settings, autoEffort: false, tiers: { ...settings.tiers, sonnet: { ...settings.tiers.sonnet, effort: 'low' } } };
  s.applySettings(settings);
  await ticks();
  assert.equal(s.info.effort, 'low');

  const lead = new Agent({ ...info('alpha', 'lead'), parentId: null, model: settings.tiers.lead.model }, host);
  lead.deliver('hi');
  await ticks();
  settings = { ...settings, tiers: { ...settings.tiers, lead: { ...settings.tiers.lead, model: 'claude-opus-5-5' } } };
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
