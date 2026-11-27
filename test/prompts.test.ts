// The prompt and team tools per capability set (core 7): shared text, lines dropped by capability,
// tier labels from the profile, no backend or model name baked in, tool names as the backend shows them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemAppend } from '../server/core/prompts.ts';
import { teamToolDefs, type TeamActions } from '../server/core/tools.ts';
import { defaultSettings } from '../server/settings/settings.ts';

const settings = defaultSettings();
const lead = (caps = {}, extra = {}) => systemAppend({ tier: 'lead', name: 'alpha', parentName: null, settings, effort: 'low', caps, ...extra });
const sub = (caps = {}) => systemAppend({ tier: 'sonnet', name: 'charlie', parentName: 'bravo', settings, effort: 'medium', caps });

test('prompts: shared text names no backend or model; tier labels come from the profile', () => {
  for (const p of [lead(), sub()]) {
    assert.doesNotMatch(p, /Claude/, 'no backend name');
    assert.match(p, /tiered team of AI agents/);
    assert.match(p, /never carry the person's authority/);
  }
  const opusLabel = settings.profiles[0]!.tiers[1]!.label;
  assert.match(lead(), new RegExp(`You can start ${opusLabel} agents with spawn_agent`));
  const relabelled = structuredClone(settings);
  relabelled.profiles[0]!.tiers[1]!.label = 'Senior';
  assert.match(systemAppend({ tier: 'lead', name: 'alpha', parentName: null, settings: relabelled }), /You can start Senior agents/);
});

test('prompts: lines follow capabilities', () => {
  // Full capabilities (Claude Code today).
  assert.match(lead(), /You run at low thinking effort/);
  assert.doesNotMatch(lead(), /background will not wake you/);
  assert.doesNotMatch(lead(), /arrive when your turn ends/);
  // No effort control, or a single level: no effort line.
  assert.doesNotMatch(lead({ efforts: [] }), /thinking effort/);
  assert.doesNotMatch(lead({ efforts: ['high'] }), /thinking effort/);
  // No background tracking; no mid-turn delivery.
  assert.match(sub({ background: false }), /background will not wake you/);
  assert.match(sub({ midTurnDelivery: false }), /Messages sent to you while you work arrive when your turn ends\./);
  // The old `background` option still works.
  assert.match(systemAppend({ tier: 'sonnet', name: 'c', parentName: 'b', settings, background: false }), /background will not wake you/);
});

test('prompts: tool names appear as the backend shows them', () => {
  const p = lead({}, { toolName: (n: string) => `masthead.${n}` });
  assert.match(p, /with masthead\.spawn_agent/);
  assert.match(p, /masthead\.send_message reaches any agent/);
  assert.match(p, /masthead\.list_agents shows/);
  assert.match(p, /use masthead\.set_effort/);
  assert.doesNotMatch(p, /(^|[^.])\bspawn_agent\b/m);
});

test('prompts: the appended text is no longer than in 0.1.4', () => {
  // 0.1.4 measured 1576 (lead) and 1823 (sub) characters with the default profile.
  assert.ok(lead().length <= 1576, String(lead().length));
  assert.ok(sub().length <= 1823, String(sub().length));
});

function team(efforts?: string[]): TeamActions {
  return {
    spawn: () => 'spawned',
    message: (_f, to, text, wait) => `message ${to} ${text} ${wait}`,
    list: () => 'list',
    stop: () => 'stopped',
    setOwnEffort: (_a, l) => `own ${l}`,
    setAgentEffort: (_c, n, l) => `agent ${n} ${l}`,
    autoEffort: () => true,
    label: (t) => (t === 'opus' ? 'Opus 5.5' : t),
    childTier: (t) => (t === 'lead' ? 'opus' : null),
    ...(efforts ? { caps: () => ({ efforts: efforts as never }) } : {}),
  };
}
const leadAgent = { tier: 'lead', info: { parentId: null } } as never;
const leafAgent = { tier: 'haiku', info: { parentId: 'x' } } as never;

test('tools: one neutral definition per agent; spawn only with a child tier; effort tools only with levels', async () => {
  assert.deepEqual(teamToolDefs(leadAgent, team()).map((t) => t.name), ['send_message', 'list_agents', 'spawn_agent', 'stop_agent', 'set_effort', 'set_agent_effort']);
  assert.deepEqual(teamToolDefs(leafAgent, team()).map((t) => t.name), ['send_message', 'list_agents', 'set_effort']);
  assert.deepEqual(teamToolDefs(leadAgent, team([])).map((t) => t.name), ['send_message', 'list_agents', 'spawn_agent', 'stop_agent']);
  const spawn = teamToolDefs(leadAgent, team([])).find((t) => t.name === 'spawn_agent')!;
  assert.equal('effort' in (spawn.input.properties as object), false, 'no effort field without levels');
  const own = teamToolDefs(leadAgent, team(['low', 'high'])).find((t) => t.name === 'set_effort')!;
  assert.deepEqual((own.input.properties as { level: { enum: string[] } }).level.enum, ['low', 'high'], "the backend's own levels");
  assert.equal(await own.run({ level: 'high', reason: 'r' }), 'own high');
  assert.equal(await own.run({ level: 'xhigh', reason: 'r' }), 'Error: unknown effort level.', 'a level the backend lacks');
  const send = teamToolDefs(leafAgent, team()).find((t) => t.name === 'send_message')!;
  assert.ok('wait' in (send.input.properties as object), 'sub-agents may wait');
  assert.equal(await send.run({ to: 'bravo', message: 'hi', wait: true }), 'message bravo hi true');
  assert.equal('wait' in (teamToolDefs(leadAgent, team()).find((t) => t.name === 'send_message')!.input.properties as object), false);
  for (const t of teamToolDefs(leadAgent, team())) {
    assert.equal(t.input.type, 'object');
    assert.doesNotMatch(t.description, /Claude/);
  }
  assert.match(teamToolDefs(leadAgent, team()).find((t) => t.name === 'spawn_agent')!.description, /^Start an Opus 5\.5 agent/);
});

test('tools: compact_team accepts plain names as well as {name, why}', async () => {
  const seen: unknown[] = [];
  const t = { ...team(), compactTeam: (_c: unknown, keep: unknown) => (seen.push(keep), 'ok') } as TeamActions;
  const tool = teamToolDefs(leadAgent, t).find((d) => d.name === 'compact_team')!;
  assert.equal(await tool.run({ keep: ['bravo', { name: 'echo', why: 'knows it' }, { name: 'golf' }] }), 'ok');
  assert.deepEqual(seen[0], [{ name: 'bravo', why: '' }, { name: 'echo', why: 'knows it' }, { name: 'golf', why: '' }]);
});
