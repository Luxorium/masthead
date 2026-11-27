import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultSettings, sanitizeSettings } from '../server/config.ts';
import { messageEnvelope, reportEnvelope, systemAppend } from '../server/prompts.ts';
import { Scheduler, SlotCancelled } from '../server/scheduler.ts';
import { Store } from '../server/store.ts';
import { CHILD_TIER, EFFORTS, agentName, capEffort, displayName, modelLabel, type Item, type Tier } from '../shared/protocol.ts';
import { toolLine } from '../shared/toolline.ts';

const tick = () => new Promise((r) => setImmediate(r));

function tracker(sched: Scheduler, tier: Tier) {
  const started: string[] = [];
  const ask = (id: string, owner: string) =>
    sched.acquire(tier, id, owner).then(
      () => void started.push(id),
      (e) => void started.push(`${id}:${e instanceof SlotCancelled ? 'cancelled' : 'error'}`),
    );
  return { started, ask };
}

test('scheduler: never runs more than the limit, and starts the next when one finishes', async () => {
  const sched = new Scheduler(() => 2);
  const { started, ask } = tracker(sched, 'opus');
  ask('a', 'lead');
  ask('b', 'lead');
  ask('c', 'lead');
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(sched.running('opus'), 2);
  assert.equal(sched.queued('opus'), 1);
  sched.release('opus', 'a');
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(sched.running('opus'), 2);
});

test('scheduler: tiers are limited separately and the lead is never limited', async () => {
  const sched = new Scheduler((tier) => (tier === 'opus' ? 1 : 0));
  const opus = tracker(sched, 'opus');
  const lead = tracker(sched, 'lead');
  const sonnet = tracker(sched, 'sonnet');
  opus.ask('o1', 'x');
  lead.ask('l1', 'x');
  lead.ask('l2', 'x');
  sonnet.ask('s1', 'x');
  await tick();
  assert.deepEqual(opus.started, ['o1']);
  assert.deepEqual(lead.started, ['l1', 'l2']);
  assert.deepEqual(sonnet.started, ['s1:error'], 'a tier set to 0 refuses at once');
});

test('scheduler: a freed slot goes to the parent with the fewest running agents', async () => {
  const sched = new Scheduler(() => 2);
  const { started, ask } = tracker(sched, 'sonnet');
  ask('a1', 'A');
  ask('a2', 'A');
  ask('a3', 'A'); // queued first
  ask('b1', 'B'); // queued second, but B has nothing running
  await tick();
  sched.release('sonnet', 'a1');
  await tick();
  assert.deepEqual(started, ['a1', 'a2', 'b1']);
  sched.release('sonnet', 'a2');
  await tick();
  assert.deepEqual(started, ['a1', 'a2', 'b1', 'a3']);
});

test('scheduler: cancelling a queued agent frees its place; raising the limit starts waiters', async () => {
  let limit = 1;
  const sched = new Scheduler(() => limit);
  const { started, ask } = tracker(sched, 'haiku');
  ask('a', 'p');
  ask('b', 'p');
  ask('c', 'p');
  await tick();
  assert.equal(sched.cancel('haiku', 'b'), true);
  assert.equal(sched.cancel('haiku', 'zzz'), false);
  await tick();
  assert.deepEqual(started, ['a', 'b:cancelled']);
  limit = 2;
  sched.limitsChanged();
  await tick();
  assert.deepEqual(started, ['a', 'b:cancelled', 'c']);
  // Lowering the limit never stops something already running.
  limit = 0;
  sched.limitsChanged();
  assert.equal(sched.running('haiku'), 2);
});

test('scheduler: asking twice for the same agent holds one slot', async () => {
  const sched = new Scheduler(() => 1);
  await sched.acquire('opus', 'a', 'p');
  await sched.acquire('opus', 'a', 'p');
  assert.equal(sched.running('opus'), 1);
  sched.release('opus', 'a');
  sched.release('opus', 'a');
  assert.equal(sched.running('opus'), 0);
});

test('settings: defaults are valid and there is no max effort', () => {
  const d = defaultSettings();
  assert.deepEqual(sanitizeSettings(d), d);
  assert.equal(d.autoEffort, true);
  assert.ok(!(EFFORTS as readonly string[]).includes('max'));
  assert.equal(d.tiers.lead.model, 'claude-fable-5-2');
});

test('settings: bad values fall back instead of being stored', () => {
  const d = defaultSettings();
  const s = sanitizeSettings({
    tiers: {
      opus: { model: 'x; rm -rf /', effort: 'max', max: 999 },
      sonnet: { max: -4, effort: 'low' },
      haiku: { max: 2.9 },
      lead: { max: 50 },
    },
    permissionMode: 'yolo',
    autoEffort: 'yes',
    defaultCwd: 'relative/path',
  });
  assert.equal(s.tiers.opus.model, d.tiers.opus.model);
  assert.equal(s.tiers.opus.effort, d.tiers.opus.effort, 'max effort is not accepted');
  assert.equal(s.tiers.opus.max, 12);
  assert.equal(s.tiers.sonnet.max, 0);
  assert.equal(s.tiers.sonnet.effort, 'low');
  assert.equal(s.tiers.haiku.max, 2);
  assert.equal(s.tiers.lead.max, d.tiers.lead.max);
  assert.equal(s.permissionMode, 'inherit');
  assert.equal(s.autoEffort, true);
  assert.equal(s.defaultCwd, d.defaultCwd);
  assert.deepEqual(sanitizeSettings(null), d);
  assert.deepEqual(sanitizeSettings('nonsense'), d);
});

test('tiers: each tier starts only the one below it', () => {
  assert.deepEqual(CHILD_TIER, { lead: 'opus', opus: 'sonnet', sonnet: 'haiku', haiku: null });
  assert.equal(capEffort('xhigh', 'medium'), 'medium');
  assert.equal(capEffort('low', 'high'), 'low');
});

test('store: a transcript keeps order and the last version of each item', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'masthead-test-')));
  const conv = 'c1';
  const a: Item = { id: 'a', ts: 1, kind: 'text', text: 'first' };
  const tool: Item = { id: 'tool-1', ts: 2, kind: 'tool', name: 'Bash', input: { command: 'ls' }, done: false };
  const b: Item = { id: 'b', ts: 3, kind: 'text', text: 'last' };
  store.appendItem(conv, 'agent', a);
  store.appendItem(conv, 'agent', tool);
  store.appendItem(conv, 'agent', b);
  store.appendItem(conv, 'agent', { ...tool, done: true, result: 'file.txt' });
  const items = store.loadItems(conv, 'agent');
  assert.deepEqual(items.map((i) => i.id), ['a', 'tool-1', 'b']);
  assert.equal((items[1] as Item & { kind: 'tool' }).result, 'file.txt');
  assert.deepEqual(store.loadItems(conv, 'nobody'), []);
});

test('store: conversations round-trip and ids cannot escape the data folder', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'masthead-test-')));
  const meta = { id: 'conv-1', title: 'T', cwd: '/tmp', createdAt: 1, updatedAt: 2, leadId: 'lead-1' };
  store.saveConversation({ meta, agents: [] });
  assert.deepEqual(store.loadAll(), [{ meta, agents: [] }]);
  assert.throws(() => store.appendItem('../../etc', 'x', { id: 'i', ts: 1, kind: 'text', text: '' }));
  assert.throws(() => store.loadItems('conv-1', '../conversation'));
  store.deleteConversation('conv-1');
  assert.deepEqual(store.loadAll(), []);
});

test('prompts: each tier is told what it can do', () => {
  const settings = defaultSettings();
  const lead = systemAppend({ tier: 'lead', name: 'lead', parentName: null, settings });
  assert.match(lead, /lead agent/);
  assert.match(lead, /start Opus 5\.5 agents/);
  assert.match(lead, /set_effort/);
  const haiku = systemAppend({ tier: 'haiku', name: 'h1', parentName: 's1', settings });
  assert.match(haiku, /"s1" started you/);
  assert.doesNotMatch(haiku, /spawn_agent/);
  settings.tiers.sonnet.max = 0;
  settings.autoEffort = false;
  const opus = systemAppend({ tier: 'opus', name: 'o1', parentName: 'lead', settings });
  assert.match(opus, /switched off/);
  assert.doesNotMatch(opus, /set_effort/);
  assert.match(reportEnvelope('o1', 'opus', 'done', ''), /ended without writing a report/);
  assert.match(messageEnvelope('o1', 'opus', 'hi'), /^<agent-message from="o1" tier="opus">\nhi\n<\/agent-message>/);
});

test('tool wording: past for the transcript, present for what is happening now', () => {
  assert.deepEqual(toolLine('Read', { file_path: '/a/b.ts' }), { verb: 'Read', target: '/a/b.ts' });
  assert.deepEqual(toolLine('Read', { file_path: '/a/b.ts' }, true), { verb: 'Reading', target: '/a/b.ts' });
  assert.deepEqual(toolLine('mcp__masthead__spawn_agent', { title: 'Review the API' }, true), { verb: 'Starting an agent:', target: 'Review the API' });
  assert.equal(toolLine('Bash', { command: 'a\n  b' }).target, 'a b');
  assert.deepEqual(toolLine('mcp__github__list_issues', {}), { verb: 'Used list_issues', target: 'github' });
  assert.equal(toolLine('Mystery', null).verb, 'Used Mystery');
});

test('model names: ids read as people say them', () => {
  assert.equal(modelLabel('claude-fable-5-2'), 'Fable 5.2');
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-haiku-5-5'), 'Haiku 5.5');
  assert.equal(modelLabel('claude-opus-5'), 'Opus 5');
  assert.equal(modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(modelLabel('my-custom-model'), 'my-custom-model');
});

test('agent names: handed out in order, and they carry on after zulu', () => {
  assert.equal(agentName(0), 'alpha');
  assert.equal(agentName(1), 'bravo');
  assert.equal(agentName(25), 'zulu');
  assert.equal(agentName(26), 'alpha-ii');
  assert.equal(agentName(27), 'bravo-ii');
  assert.equal(agentName(52), 'alpha-iii');
  assert.equal(agentName(26 * 3 + 1), 'bravo-iv');
  assert.equal(displayName('alpha-ii'), 'Alpha II');
  assert.equal(displayName('bravo'), 'Bravo');
  assert.equal(displayName('alpha-2'), 'Alpha-2', 'names from older conversations are left as they were');
  assert.equal(agentName(53), 'bravo-iii');
  assert.equal(displayName('charlie'), 'Charlie');
  assert.equal(new Set(Array.from({ length: 200 }, (_, i) => agentName(i))).size, 200);
});
