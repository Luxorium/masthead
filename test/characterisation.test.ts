// Characterisation tests (0.2.0 Core 0): they pin what 0.1.4 does today, so the 0.2.0 refactors can
// prove they change nothing. When one of these fails during a refactor, the refactor changed
// behaviour; change the test only on purpose, with the reason in the commit.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { App, type Client } from '../server/app/app.ts';
import { defaultSettings, sanitizeSettings } from '../server/settings/settings.ts';
import { Conversation, type ConversationHost } from '../server/core/conversation.ts';
import { Scheduler } from '../server/core/scheduler.ts';
import { Store } from '../server/storage/store.ts';
import type { Item, ServerMsg } from '../shared/protocol.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'v0.1');
const tick = () => new Promise((r) => setImmediate(r));
async function ticks(n = 8) {
  for (let i = 0; i < n; i++) await tick();
}

/** The shape of a value: object keys (sorted) and value types, recursively; arrays by their first element. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = shape((v as Record<string, unknown>)[k]);
    return out;
  }
  return v === null ? 'null' : typeof v;
}

// ---- 0.1.x data on disk ----

test('characterisation: 0.1.x settings load with today\'s fallbacks', () => {
  const s = sanitizeSettings(JSON.parse(readFileSync(join(FIXTURES, 'settings.json'), 'utf8')));
  assert.equal(s.tiers.opus.effort, 'high');
  assert.equal(s.tiers.opus.max, 2);
  assert.equal(s.tiers.haiku.max, 0);
  assert.equal(s.tiers.lead.max, 1);
  assert.equal(s.permissionMode, 'acceptEdits');
  assert.equal(s.leanSubagents, false);
  assert.equal(s.leanOpus, true);
  assert.equal(s.maxRunMinutes, 30);
  assert.equal(s.defaultCwd, '/tmp');
  assert.equal((s as unknown as Record<string, unknown>).unknownField, undefined, 'unknown fields are dropped');
  assert.deepEqual(Object.keys(s).sort(), Object.keys(defaultSettings()).sort());
});

function fixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), 'masthead-char-'));
  cpSync(join(FIXTURES, 'conversations'), join(dir, 'conversations'), { recursive: true });
  return new Store(join(dir, 'conversations'));
}

function quietHost(): ConversationHost & { items: Array<{ agent: string; item: Item }> } {
  const settings = defaultSettings();
  const items: Array<{ agent: string; item: Item }> = [];
  return {
    items,
    scheduler: new Scheduler((t) => settings.tiers[t].max),
    settings: () => settings,
    claudePath: () => null,
    agentChanged() {},
    itemChanged: (_c, a, item) => void items.push({ agent: a.name, item }),
    draftChanged() {},
    metaChanged() {},
    rateLimit() {},
    askPermission: async () => ({ behavior: 'deny', message: 'test' }),
    cancelPermissions() {},
  };
}

test('characterisation: 0.1.x conversations restore as today', async () => {
  const store = fixtureStore();
  const all = store.loadAll().sort((a, b) => a.meta.id.localeCompare(b.meta.id));
  assert.deepEqual(all.map((c) => c.meta.id), ['conv-a', 'conv-old']);
  const host = quietHost();
  const conv = Conversation.restore(host, all[0]!);
  const by = (n: string) => [...conv.agents.values()].find((a) => a.name === n)!;
  assert.equal(by('alpha').status, 'idle', 'a waiting lead becomes idle');
  assert.equal(by('bravo').status, 'stopped');
  assert.equal(by('bravo').info.error, 'Masthead was closed while this agent was working.');
  assert.equal(by('bravo').info.activity, undefined);
  assert.equal(by('bravo').info.pausedUntil, undefined);
  assert.equal(by('bravo').owesReport, false, 'nobody owes a report after a restart');
  assert.equal(by('bravo').sessionId, 's-b');
  assert.equal(by('charlie').status, 'stopped');
  assert.equal(by('charlie').pendingSeed, 'never started, full task');
  assert.equal(by('delta').status, 'done');
  const stored = conv.toStored();
  assert.deepEqual(stored.stoppedByPerson, ['d'], 'marks for agents that do not exist are dropped');
  assert.equal(stored.agentMessages, 12);
  assert.equal(stored.meta.busy, undefined);
  await tick();
  const notes = host.items.filter((x) => x.agent === 'alpha' && x.item.kind === 'notice').map((x) => (x.item as { text: string }).text);
  // An old chat (idle for longer than the resume window): the lead is not woken, it is told with the next message.
  assert.deepEqual(notes, ['Masthead was restarted while helpers were working, so they were stopped: bravo (Review, started by alpha); charlie (started by bravo). The lead is told with your next message.']);
  assert.match(conv.message(by('alpha'), 'delta', 'x'), /^Error: the person stopped "delta"/);

  const old = Conversation.restore(quietHost(), all[1]!);
  assert.equal(old.lead.info.title, '', 'a missing title becomes empty');
  assert.deepEqual(old.toStored().stoppedByPerson, []);
  assert.equal(old.toStored().agentMessages, 0);
});

test('characterisation: a 0.1.x transcript reads back in order, last line per id wins, torn line skipped', () => {
  const items = fixtureStore().loadItems('conv-a', 'lead-a');
  assert.deepEqual(items.map((i) => i.id), ['i1', 't1', 'i2']);
  assert.equal((items[1] as { result?: string }).result, 'ok');
});

// ---- protocol v1 as the page sees it ----

function appSetup() {
  const store = fixtureStore();
  const dir = mkdtempSync(join(tmpdir(), 'masthead-char-app-'));
  const app = new App({ store, settingsFile: join(dir, 'settings.json'), settings: defaultSettings(), claude: { path: null, version: null, error: 'none' } });
  const got: ServerMsg[] = [];
  // As the page receives them: JSON on the wire drops undefined fields.
  const client: Client = { send: (m) => void got.push(JSON.parse(JSON.stringify(m))) };
  app.connect(client);
  const send = (msg: unknown) => {
    got.length = 0;
    app.handle(client, msg);
    return [...got];
  };
  return { app, send, got };
}

test('characterisation: protocol v1 state, conversation and items messages keep their shape', () => {
  const { send } = appSetup();
  const [state] = send({ t: 'hello' });
  assert.equal(state!.t, 'state');
  assert.deepEqual(Object.keys((state as Extract<ServerMsg, { t: 'state' }>).state).sort(), ['claude', 'conversations', 'home', 'pending', 'settings', 'usage', 'version']);
  assert.deepEqual(shape((state as Extract<ServerMsg, { t: 'state' }>).state.conversations[0]), {
    busy: 'boolean', createdAt: 'number', cwd: 'string', id: 'string', leadId: 'string', title: 'string', updatedAt: 'number',
    // Added on purpose in 0.2.0: each conversation's copy of its team's tiers (bravo's data-safety review).
    team: [{ backend: 'string', colour: 'string', effort: 'string', id: 'string', label: 'string', lean: 'boolean', max: 'number', model: 'string' }],
  });
  const opened = send({ t: 'open', convId: 'conv-a' });
  assert.deepEqual(opened.map((m) => m.t), ['conversation']);
  const conv = opened[0] as Extract<ServerMsg, { t: 'conversation' }>;
  assert.deepEqual(Object.keys(conv).sort(), ['agents', 'conv', 'pending', 't']);
  assert.deepEqual(Object.keys(conv.agents[0]!).sort(), ['convId', 'createdAt', 'effort', 'id', 'model', 'name', 'parentId', 'status', 'task', 'tier', 'title', 'usage']);
  const items = send({ t: 'items', convId: 'conv-a', agentId: 'lead-a' });
  assert.deepEqual(items.map((m) => m.t), ['items']);
  assert.deepEqual(Object.keys(items[0]!).sort(), ['agentId', 'convId', 'draft', 'items', 't']);
});

test('characterisation: protocol v1 send without Claude Code is refused with its ref and the reason', () => {
  const { send } = appSetup();
  const out = send({ t: 'send', convId: null, cwd: tmpdir(), text: 'Hello there', ref: 'r1' });
  assert.deepEqual(out, [{ t: 'error', message: 'none', ref: 'r1' }]);
});

// ---- a recorded run replayed through a fake Claude Code ----

class FakeProcess {
  readonly received: SDKUserMessage[] = [];
  private out: unknown[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  readonly q: Query;
  constructor(prompt: AsyncIterable<SDKUserMessage>, readonly options: Options) {
    void (async () => {
      for await (const m of prompt) {
        this.received.push(m);
        this.onInput?.(m);
      }
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
      getContextUsage: async () => ({ totalTokens: 10, maxTokens: 200_000 }),
    } as unknown as Query;
  }
  onInput?: (m: SDKUserMessage) => void;
  say(m: Record<string, unknown>): void {
    this.out.push(m);
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
}

test('characterisation: replay of a lead → Opus → report run through a fake Claude Code', async () => {
  const host = quietHost();
  (host as { claudePath: () => string | null }).claudePath = () => '/usr/bin/false';
  const conv = Conversation.create(host, tmpdir());
  const processes = new Map<string, FakeProcess>();
  // Seam used by test/agent.test.ts: the Agent asks its host for `query`; Conversation is that host.
  (conv as unknown as { query: unknown }).query = ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const name = /You are "([a-z]+)"/.exec(String((options.systemPrompt as { append?: string }).append))?.[1] ?? '?';
    const p = new FakeProcess(prompt, options);
    processes.set(name, p);
    return p.q;
  };
  const turn = (p: FakeProcess, text: string, sid: string) => {
    p.say({ type: 'system', subtype: 'init', session_id: sid, model: 'm' });
    p.say({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    p.say({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.01, user_message_uuids: p.received.map((m) => m.uuid) });
  };

  conv.userSend('Review the code', undefined);
  await ticks();
  const lead = processes.get('alpha')!;
  assert.equal(lead.received[0]!.message.content, 'Review the code');
  assert.equal(lead.options.model, 'claude-fable-5-2');
  // The lead calls spawn_agent (the tool's effect), then ends its turn.
  assert.match(conv.spawn(conv.lead, 'Review', 'Review server/', undefined), /^Started Opus 5\.5 agent "bravo" \(Review\) at low effort\./);
  turn(lead, 'Started bravo.', 'lead-session');
  await ticks();
  assert.equal(conv.lead.status, 'waiting');
  const bravo = processes.get('bravo')!;
  assert.equal(bravo.received[0]!.message.content, 'Review server/');
  turn(bravo, 'Found two bugs.', 'bravo-session');
  await ticks();
  const b = [...conv.agents.values()].find((a) => a.name === 'bravo')!;
  assert.equal(b.status, 'done');
  assert.equal(lead.received.length, 2, 'the report reaches the lead as its next input');
  assert.equal(lead.received[1]!.message.content, '<agent-report from="bravo" tier="opus" status="done">\nFound two bugs.\n</agent-report>');
  turn(lead, 'Bravo found two bugs.', 'lead-session');
  await ticks();
  assert.equal(conv.lead.status, 'idle');
  const seq = host.items.map((x) => `${x.agent}:${x.item.kind}${x.item.kind === 'inbound' ? `/${x.item.via}` : ''}`);
  assert.deepEqual(seq, ['alpha:user', 'bravo:inbound/task', 'alpha:text', 'bravo:text', 'alpha:inbound/report', 'alpha:text']);
  const stored = conv.toStored();
  assert.equal(stored.agents.find((a) => a.info.name === 'bravo')!.sessionId, 'bravo-session');
});
