// golf's review of the 0.2.1-beta.1 restart/report changes (R2/R3). Failing tests here are findings, not fixes.
// The helpers are copied from test/agent.test.ts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Agent, type AgentHost, type TurnOutcome } from '../server/runtime/agent.ts';
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
  readonly modes: string[] = [];
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
      setPermissionMode: async (mode: string) => {
        self.modes.push(mode);
        return { mode };
      },
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

test('review R3: a long text from the turn a finished background command starts does not drop the report written before it', async () => {
  const sched = new Scheduler(() => 1);
  const { host, processes, turns } = fakeHost(sched);
  const a = new Agent(info('bravo'), host, { owesReport: true, seed: 'audit the module and run the slow suite' });
  a.start();
  await ticks();
  const p = processes[0]!;
  const report = `REPORT: ${'finding; '.repeat(70)}`; // the real report, 600+ characters
  p.init();
  p.tasks('b1');
  p.result(report, [p.uuids[0]!]);
  await ticks();
  // The background suite ends; Claude Code starts a turn by itself and comments at length on its log.
  p.tasks();
  p.init();
  const comment = `The background suite finished. ${'log line summary; '.repeat(30)}`; // 400+ characters
  p.say({ type: 'result', subtype: 'success', is_error: false, result: comment, total_cost_usd: 0, origin: { kind: 'task-notification' } });
  await ticks();
  assert.equal(turns.length, 2);
  assert.match(turns[1]!.text, /^REPORT: /m, 'the report the parent receives still holds the real report');
});
