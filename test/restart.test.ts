// 0.2.1: restarts, reports and person messages (R1-R5 from the analysis of real chats).
// Each test first reproduced the problem (on the fake backend, or Claude's adapter with a stand-in
// process where the trigger is Claude Code's own), then pins the fix.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { FakeBackend } from '../server/backends/fake/index.ts';
import { Conversation, type ConversationHost } from '../server/core/conversation.ts';
import { Scheduler } from '../server/core/scheduler.ts';
import { Agent, type AgentHost, type TurnOutcome } from '../server/runtime/agent.ts';
import { defaultSettings, tierLimit } from '../server/settings/settings.ts';
import type { AgentInfo, Item, Settings } from '../shared/protocol.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(5);
  }
}

function info(name: string, over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: randomUUID(),
    convId: 'conv',
    name,
    tier: 'sonnet',
    parentId: 'parent',
    title: '',
    task: 'task',
    status: 'queued',
    model: 'claude-sonnet-5-5',
    effort: 'low',
    createdAt: Date.now(),
    usage: { context: 0, contextMax: 1_000_000, output: 0, costUsd: 0, turns: 0 },
    ...over,
  };
}

/** An AgentHost that records turns; `query` (a Claude Code stand-in) or `backend` is set by the test. */
function agentHost() {
  const sched = new Scheduler(() => 4);
  const turns: TurnOutcome[] = [];
  const lost: string[] = [];
  const host: AgentHost = {
    cwd: '/tmp',
    scheduler: sched,
    settings: defaultSettings,
    claudePath: () => '/usr/bin/false',
    parentName: () => 'alpha',
    tools: () => [],
    agentChanged: () => {},
    itemChanged: () => {},
    draftChanged: () => {},
    rateLimit: () => {},
    askPermission: async () => ({ decision: 'allow' }),
    turnEnded: (_a, o) => void turns.push(o),
    processLost: (a, m) => {
      lost.push(m);
      sched.release(a.tier, a.id);
    },
  };
  return { host, turns, lost };
}

/** A stand-in for one Claude Code process: the test decides what it says. */
class StandIn {
  readonly received: SDKUserMessage[] = [];
  private out: unknown[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  readonly q: Query;
  constructor(prompt: AsyncIterable<SDKUserMessage>) {
    void (async () => {
      for await (const m of prompt) this.received.push(m);
      this.end();
    })();
    const self = this;
    this.q = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (self.out.length > 0) yield self.out.shift();
          if (self.ended) return;
          await new Promise<void>((r) => (self.wake = r));
          self.wake = null;
        }
      },
      close: () => self.end(),
      interrupt: async () => {},
      applyFlagSettings: async () => {},
      setModel: async () => {},
      setPermissionMode: async (mode: string) => ({ mode }),
      getContextUsage: async () => ({ totalTokens: 1, maxTokens: 200_000 }),
    } as unknown as Query;
  }
  say(m: Record<string, unknown>): void {
    this.out.push(m);
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
}

// ---- R2: a helper woken after a restart was marked done at once with an empty report ----

test('R2: a result naming no message, from a Claude Code that names them, does not answer what was sent', async () => {
  const { host, turns } = agentHost();
  const procs: StandIn[] = [];
  host.query = (({ prompt }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const p = new StandIn(prompt);
    procs.push(p);
    return p.q;
  }) as unknown as AgentHost['query'];
  // Restored after a restart: it has a session to resume and no process.
  const a = new Agent(info('golf', { status: 'stopped' }), host, { sessionId: 'session-golf' });
  a.deliver('Masthead restarted and stopped you mid-task. Please resume.');
  await until('a process', () => procs.length === 1 && procs[0]!.received.length === 1);
  const p = procs[0]!;
  // The resumed process starts with a turn of its own (a background task the crash killed), which
  // names no message: this Claude Code says (capabilities) that it names the messages turns consume.
  p.say({ type: 'system', subtype: 'init', session_id: 'session-golf', model: 'm', capabilities: ['interrupt_receipt_v1'] });
  p.say({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0 });
  await sleep(20);
  assert.equal(turns.length, 0, 'the message is still unanswered: the run goes on');
  assert.equal(a.busy, true);
  const uuid = p.received[0]!.uuid as string;
  p.say({ type: 'system', subtype: 'init', session_id: 'session-golf', model: 'm', capabilities: ['interrupt_receipt_v1'] });
  p.say({ type: 'result', subtype: 'success', is_error: false, result: 'Verdict: issues.', total_cost_usd: 0, user_message_uuids: [uuid] });
  await until('the real turn', () => turns.length === 1);
  assert.equal(turns[0]!.text, 'Verdict: issues.');
  a.dispose();
});

// ---- R2/R3: woken while its old process is still finishing ----

test('R2/R3: woken while the old process still runs a turn: shown as queued, and the old turn\'s text is not joined to the new report', async () => {
  const { host, turns } = agentHost();
  const backend = new FakeBackend({ slowMs: 80 });
  host.backend = () => backend;
  const a = new Agent(info('golf'), host, { owesReport: true, seed: 'Count slowly please' });
  a.start();
  await until('running', () => a.status === 'running' && a.hasProcess);
  await sleep(10);
  // Ended while a turn is still running (what the bogus empty result did): a clean end lets it finish.
  a.end('done');
  assert.equal(a.status, 'done');
  a.deliver('Reply with exactly the word NEW');
  await sleep(5);
  assert.equal(a.status, 'queued', 'it is not done: it waits for its old process to exit, then resumes');
  await until('the new turn', () => turns.length >= 1, 3000);
  assert.equal(turns.at(-1)!.text, 'NEW', 'only the new run\'s text');
  a.dispose();
});

// ---- R3: two reports joined ----

test('R3: a run that ends with a full answer reports only that answer; a short last word keeps what came before', async () => {
  const { host, turns } = agentHost();
  const backend = new FakeBackend();
  host.backend = () => backend;
  const a = new Agent(info('golf'), host, { owesReport: true, seed: 'Reply with exactly the word FIRSTVERDICT [[background 150ms]]' });
  a.start();
  await until('first turn', () => turns.length === 1);
  assert.equal(a.hasBackgroundWork, true);
  // While the background command runs it is asked again and writes a full, rewritten verdict…
  a.deliver(`Reply with exactly the word SECONDVERDICT${'-issues'.repeat(70)}`);
  await until('the full answer', () => turns.length === 2);
  // …then the background command ends and the backend's own short turn closes the run.
  await until('the run ends', () => turns.length === 3 && !a.hasBackgroundWork, 3000);
  const report = turns.at(-1)!.text;
  assert.doesNotMatch(report, /FIRSTVERDICT/, 'the stale first verdict is not joined to the new one');
  assert.match(report, /^SECONDVERDICT/);
  assert.match(report, /finished/, 'a short last turn keeps the full answer before it');
  a.dispose();
});

// ---- conversations on the fake backend ----

function convHost(backend: FakeBackend, stored: Map<string, Item[]> = new Map()) {
  const settings: Settings = defaultSettings();
  const scheduler = new Scheduler((t) => tierLimit(settings, t));
  const items: Array<{ agent: string; item: Item }> = [];
  const saves: number[] = [];
  const host: ConversationHost = {
    scheduler,
    settings: () => settings,
    claudePath: () => null,
    agentChanged() {},
    itemChanged(_c, a, item) {
      items.push({ agent: a.name, item });
      const list = stored.get(a.id) ?? [];
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) list[i] = item;
      else list.push(item);
      stored.set(a.id, list);
    },
    draftChanged() {},
    metaChanged() {},
    rateLimit() {},
    askPermission: async () => ({ decision: 'allow' }),
    cancelPermissions() {},
    backend: () => backend,
    readItems: (_c, id) => stored.get(id) ?? [],
    saveNow: () => void saves.push(Date.now()),
  };
  return { host, items, settings, stored, saves };
}

const texts = (items: Array<{ agent: string; item: Item }>, agent: string, kind: string) =>
  items.filter((x) => x.agent === agent && x.item.kind === kind).map((x) => (x.item as { text: string }).text);

// ---- R1: after a restart nothing resumed until the person typed ----

test('R1: after a restart that cut off helpers, the lead gets a turn of its own with who was stopped, their parent and task', async () => {
  const backend = new FakeBackend({ slowMs: 400 });
  const { host, items, stored } = convHost(backend);
  const conv = Conversation.create(host, '/tmp');
  conv.spawn(conv.lead, 'Audit web page', 'Count slowly please', undefined);
  await until('bravo running', () => [...conv.agents.values()].some((a) => a.name === 'bravo' && a.status === 'running'));
  // The server dies: what was saved last shows bravo working.
  const saved = JSON.parse(JSON.stringify(conv.toStored()));
  for (const a of conv.agents.values()) a.dispose();

  const backend2 = new FakeBackend();
  const t2 = convHost(backend2, stored);
  const again = Conversation.restore(t2.host, saved);
  await until('the lead acts by itself', () => t2.items.some((x) => x.agent === 'alpha' && x.item.kind === 'text'), 3000);
  const sent = backend2.sessions.flatMap((s) => s.received.map((m) => String(m.content)));
  assert.equal(sent.length, 1, 'one turn, with no message from the person');
  assert.match(sent[0]!, /bravo \(Audit web page, started by alpha\)/);
  const notice = texts(t2.items, 'alpha', 'notice').find((t) => /restart/i.test(t));
  assert.ok(notice, 'the page says so too');
  assert.match(notice!, /bravo/);
  // Told once: the person's next message carries no note.
  await until('idle', () => again.lead.status === 'idle');
  again.userSend('hello', undefined);
  await until('second turn', () => backend2.sessions.flatMap((s) => s.received).length === 2);
  assert.equal(String(backend2.sessions.flatMap((s) => s.received)[1]!.content), 'hello');
  assert.ok(items.length > 0);
  again.shutdown();
});

test('R1: a helper stopped by a restart is not archived as finished work without saying so', async () => {
  const backend = new FakeBackend({ slowMs: 400 });
  const { host } = convHost(backend);
  const conv = Conversation.create(host, '/tmp');
  conv.spawn(conv.lead, 'Wiki pages', 'Count slowly please', undefined);
  await until('bravo running', () => [...conv.agents.values()].some((a) => a.name === 'bravo' && a.status === 'running'));
  const saved = JSON.parse(JSON.stringify(conv.toStored()));
  for (const a of conv.agents.values()) a.dispose();
  const t2 = convHost(new FakeBackend());
  const again = Conversation.restore(t2.host, saved);
  await until('the lead acts', () => t2.items.some((x) => x.agent === 'alpha' && x.item.kind === 'text'), 3000);
  const list = again.list(again.lead);
  assert.match(list, /bravo: .*stopped by a restart/i, 'list_agents says it was cut off, not finished');
  // Tidying (the fake lead keeps only what it names): it is kept anyway, and the kept list says why.
  await until('idle', () => again.lead.status === 'idle');
  again.startCompact('');
  await until('tidied', () => !!again.meta.compact && ['proposed', 'done', 'archiving', 'compacting'].includes(again.meta.compact.phase), 3000);
  const kept = again.meta.compact!.keep.find((k) => k.name === 'bravo');
  assert.ok(kept, 'bravo is kept');
  assert.match(kept!.why, /restart/);
  assert.ok(!again.meta.compact!.archive.includes('bravo'));
  again.shutdown();
});

// ---- R4: a person message accepted just before a crash was never acted on ----

test('R4: on restore, the person\'s last message that the lead never answered is delivered again, once, with a notice', async () => {
  const backend = new FakeBackend();
  const { host, stored } = convHost(backend);
  const conv = Conversation.create(host, '/tmp');
  // The message is shown and saved, then the server dies before the lead's process answers.
  conv.lead.addItem({ kind: 'user', text: 'Please check the VM' });
  const saved = JSON.parse(JSON.stringify(conv.toStored()));
  conv.shutdown();

  const backend2 = new FakeBackend();
  const t2 = convHost(backend2, stored);
  const again = Conversation.restore(t2.host, saved);
  await until('answered', () => t2.items.some((x) => x.agent === 'alpha' && x.item.kind === 'text'), 3000);
  const sent = backend2.sessions.flatMap((s) => s.received.map((m) => String(m.content)));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /Please check the VM/);
  assert.ok(texts(t2.items, 'alpha', 'notice').some((t) => /restart/i.test(t) && /again/i.test(t)));
  await until('idle', () => again.lead.status === 'idle');
  // Saved and restored again: not sent a second time.
  const backend3 = new FakeBackend();
  const t3 = convHost(backend3, t2.stored);
  Conversation.restore(t3.host, JSON.parse(JSON.stringify(again.toStored())));
  await sleep(50);
  assert.equal(backend3.sessions.length, 0);
  again.shutdown();
});

// ---- R5: two quick person messages got two near-identical answers ----

test('R5: a person message sent while the lead is answering the previous one is marked as such', async () => {
  const backend = new FakeBackend({ slowMs: 100 });
  const { host } = convHost(backend);
  const conv = Conversation.create(host, '/tmp');
  conv.userSend('Count slowly please', undefined);
  await until('running', () => conv.lead.status === 'running' && conv.lead.hasProcess);
  await sleep(10);
  conv.userSend('it stopped working', undefined);
  await until('idle', () => conv.lead.status === 'idle' && !conv.lead.busy, 3000);
  const sent = backend.sessions.flatMap((s) => s.received.map((m) => String(m.content)));
  assert.equal(sent[0], 'Count slowly please');
  assert.match(sent[1]!, /while you were (still )?answering/i);
  assert.match(sent[1]!, /it stopped working$/);
  // Not marked when the lead was idle.
  conv.userSend('thanks', undefined);
  await until('third', () => backend.sessions.flatMap((s) => s.received).length === 3);
  assert.equal(String(backend.sessions.flatMap((s) => s.received)[2]!.content), 'thanks');
  conv.shutdown();
});

// ---- R3: a report held back by a background command ----

test('R3: while a helper waits only on a background command, its parent sees that its report is coming', async () => {
  const backend = new FakeBackend();
  const { host, items } = convHost(backend);
  const conv = Conversation.create(host, '/tmp');
  conv.spawn(conv.lead, 'Capture', 'Reply with exactly the word CAPTURED [[background 200ms]]', undefined);
  await until('waiting on the command', () => [...conv.agents.values()].some((a) => a.name === 'bravo' && a.status === 'waiting'));
  await sleep(10);
  const note = texts(items, 'alpha', 'notice').find((t) => /bravo/.test(t) && /background command/.test(t));
  assert.ok(note, 'the parent is told the report waits on a background command');
  await until('the report', () => items.some((x) => x.agent === 'alpha' && x.item.kind === 'inbound' && (x.item as { via?: string }).via === 'report'), 3000);
  assert.equal(texts(items, 'alpha', 'notice').filter((t) => /background command/.test(t)).length, 1, 'said once');
  conv.shutdown();
});

// ---- W1 (for the page): how long an agent has been in its current state ----

test('W1: activitySince moves with status and activity, not with usage; lastOutputAt with output', async () => {
  const { host } = agentHost();
  const a = new Agent(info('golf', { status: 'idle' }), host);
  assert.equal(a.info.activitySince, undefined);
  a.setStatus('running');
  const since = a.info.activitySince!;
  assert.ok(since > 0);
  await sleep(3);
  a.info.usage.output += 10; // usage changes alone leave it
  a.setStatus('running');
  assert.equal(a.info.activitySince, since);
  a.addItem({ kind: 'text', text: 'hi' });
  assert.ok(a.info.lastOutputAt! >= since);
  a.setStatus('done');
  assert.ok(a.info.activitySince! > since);
});

// ---- golf's review of the above (six findings) ----

test('review 2/3: a lead cut off mid-turn (crash or clean stop), with no helpers, gets a turn to carry on, once, saved at once', async () => {
  for (const how of ['crash', 'stop'] as const) {
    const backend = new FakeBackend({ slowMs: 400 });
    const { host, stored } = convHost(backend);
    const conv = Conversation.create(host, '/tmp');
    conv.userSend('[[think]] Count slowly please', undefined);
    // It has started on it (a thinking item), so the message is not "unanswered": the lead itself was cut off.
    await until('thinking', () => (stored.get(conv.lead.id) ?? []).some((i) => i.kind === 'thinking'));
    if (how === 'stop') conv.shutdown();
    const saved = JSON.parse(JSON.stringify(conv.toStored()));
    if (how === 'crash') for (const a of conv.agents.values()) a.dispose();

    const backend2 = new FakeBackend();
    for (const [k, v] of backend.stored) backend2.stored.set(k, v); // its session files survive the restart
    const t2 = convHost(backend2, stored);
    const again = Conversation.restore(t2.host, saved);
    await until(`${how}: the lead carries on`, () => backend2.sessions.flatMap((x) => x.received).length === 1);
    assert.match(String(backend2.sessions[0]!.received[0]!.content), /cut off mid-turn by a restart/, how);
    assert.ok(t2.saves.length >= 1, `${how}: the mark is saved at once`);
    assert.ok(texts(t2.items, 'alpha', 'notice').some((t) => /while the lead was working/.test(t)), how);
    await until('idle', () => again.lead.status === 'idle' && !again.lead.busy);
    // Once: restored again, nothing more is sent.
    const backend3 = new FakeBackend();
    Conversation.restore(convHost(backend3, t2.stored).host, JSON.parse(JSON.stringify(again.toStored())));
    await sleep(30);
    assert.equal(backend3.sessions.length, 0, `${how}: once`);
    again.shutdown();
  }
});

test('review 4: a turn that ends with a message still unanswered, and no turn after it, ends the run after the grace time', async () => {
  const { host, turns } = agentHost();
  const procs: StandIn[] = [];
  host.query = (({ prompt }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const p = new StandIn(prompt);
    procs.push(p);
    return p.q;
  }) as unknown as AgentHost['query'];
  const before = Agent.unansweredGraceMs;
  Agent.unansweredGraceMs = 40;
  try {
    const a = new Agent(info('golf'), host, { owesReport: true, seed: 'task' });
    a.start();
    await until('process', () => procs.length === 1 && procs[0]!.received.length === 1);
    const p = procs[0]!;
    p.say({ type: 'system', subtype: 'init', session_id: 's', model: 'm', capabilities: ['interrupt_receipt_v1'] });
    a.deliver('one more thing');
    await until('sent', () => p.received.length === 2);
    p.say({ type: 'result', subtype: 'success', is_error: false, result: 'Task done.', total_cost_usd: 0, user_message_uuids: [p.received[0]!.uuid] });
    await sleep(10);
    assert.equal(turns.length, 0, 'waits for the turn that answers the second message');
    // The backend never starts it.
    await until('the run ends anyway', () => turns.length === 1, 1000);
    assert.equal(turns[0]!.text, 'Task done.');
    assert.equal(a.busy, false);
    a.dispose();
  } finally {
    Agent.unansweredGraceMs = before;
  }
});

test('review 5: the "sent while answering" note only when the busy turn answers the person, not a helper\'s message', async () => {
  const backend = new FakeBackend({ slowMs: 100 });
  const { host } = convHost(backend);
  const conv = Conversation.create(host, '/tmp');
  conv.spawn(conv.lead, 'Quick', 'Reply with exactly the word OK', undefined);
  const bravo = [...conv.agents.values()].find((a) => a.name === 'bravo')!;
  await until('bravo done and the lead idle', () => bravo.status === 'done' && conv.lead.status === 'idle' && !conv.lead.busy, 3000);
  const leadSent = () => backend.sessions.filter((x) => x.spec.canAskPerson).flatMap((x) => x.received.map((m) => String(m.content)));
  const n = leadSent().length;
  conv.message(bravo, 'alpha', 'Count slowly please');
  await until('the lead is busy with it', () => conv.lead.status === 'running' && conv.lead.busy);
  conv.userSend('hello', undefined);
  await until('sent', () => leadSent().length === n + 2);
  assert.equal(leadSent()[n + 1], 'hello');
  conv.shutdown();
});

test('review 6: a helper woken again while it waits on a background command tells its parent again', async () => {
  const backend = new FakeBackend();
  const { host, items } = convHost(backend);
  const conv = Conversation.create(host, '/tmp');
  conv.spawn(conv.lead, 'Capture', 'Reply with exactly the word A [[background 300ms]]', undefined);
  const bravo = () => [...conv.agents.values()].find((a) => a.name === 'bravo')!;
  await until('waiting', () => bravo()?.status === 'waiting');
  const told = () => texts(items, 'alpha', 'notice').filter((t) => /background command/.test(t)).length;
  await until('told', () => told() === 1);
  conv.message(conv.lead, 'bravo', 'Reply with exactly the word B');
  await until('told again after its next turn', () => told() === 2, 2000);
  conv.shutdown();
});

test('OOM: after an out-of-memory restart every chat active in the window says why once, even with nothing cut off; old chats do not', async () => {
  const why = 'Masthead was restarted because the computer ran out of memory.';
  for (const age of [0, 7 * 60 * 60_000]) {
    const { host, stored } = convHost(new FakeBackend());
    const conv = Conversation.create(host, '/tmp');
    const saved = JSON.parse(JSON.stringify(conv.toStored()));
    saved.meta.updatedAt = Date.now() - age;
    const t2 = convHost(new FakeBackend(), stored);
    t2.host.restartReason = () => why;
    Conversation.restore(t2.host, saved);
    await sleep(10);
    assert.equal(texts(t2.items, 'alpha', 'notice').filter((t) => t === why).length, age ? 0 : 1, `age ${age}`);
  }
});
