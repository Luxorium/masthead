// The prompt and team tools per capability set (core 7): shared text, lines dropped by capability,
// tier labels from the profile, no backend or model name baked in, tool names as the backend shows them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effortHeader, systemAppend } from '../server/core/prompts.ts';
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

test('prompts: the appended text stays within its budget', () => {
  // 0.1.4 measured 1576 (lead) and 1823 (sub) characters with the default profile. 0.2.1 added the
  // lead's reporting rule, pictures, light levels and effort changes: 2144 and 2264.
  assert.ok(lead().length <= 2150, String(lead().length));
  assert.ok(sub().length <= 2270, String(sub().length));
});

test('prompts: the lead batches updates; pictures are explained to lead and helpers', () => {
  assert.match(lead(), /do not write to the person about each report/);
  assert.match(lead(), /answer only what is new/);
  assert.match(lead(), /picture a tool returns .* is shown to the person in your chat/);
  assert.match(sub(), /picture a tool returns shows in your chat, which the person sees only if they open it; give "bravo" the path/);
  assert.doesNotMatch(sub(), /about each report/);
});

test('prompts: light (lean) levels are named from the team profile', () => {
  // Default profile: Sonnet and Haiku run light; Opus (since 0.2.1) and the lead do not.
  assert.doesNotMatch(lead(), /Opus 5\.5 agents run light/);
  assert.match(sub(), /Haiku 5\.5 agents run light: no connected services/);
  assert.doesNotMatch(lead(), /You run light/, 'the lead is never light');
  assert.match(sub(), /You run light: .*tell "bravo"/);
  assert.match(sub(), /Haiku 5\.5 agents run light/);
  const heavy = structuredClone(settings);
  for (const tier of heavy.profiles[0]!.tiers) tier.lean = false;
  const p = systemAppend({ tier: 'lead', name: 'alpha', parentName: null, settings: heavy });
  assert.doesNotMatch(p, /run light/);
  assert.doesNotMatch(systemAppend({ tier: 'sonnet', name: 'c', parentName: 'b', settings: heavy }), /run light/);
});

test('prompts: the effort line says it is reset and announced, and not to ask for the same level', () => {
  assert.match(sub(), /You run at medium thinking effort; Masthead resets you to low .* tells you at the top of a message when it changes/);
  assert.match(sub(), /never ask for the level you have/);
  assert.equal(effortHeader('low'), '(Your thinking effort is now low.)\n');
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

test('tools: spawn_agent warns when the level below runs light; read_archive reads any finished helper', () => {
  const desc = (lean?: boolean) => teamToolDefs(leadAgent, { ...team(), ...(lean === undefined ? {} : { lean: () => lean }) }).find((d) => d.name === 'spawn_agent')!.description;
  assert.match(desc(true), /It has no connected services/);
  assert.doesNotMatch(desc(false), /connected services/);
  assert.doesNotMatch(desc(), /connected services/);
  const archive = teamToolDefs(leadAgent, { ...team(), readArchive: () => '' }).find((d) => d.name === 'read_archive')!;
  assert.match(archive.description, /finished or archived helper/);
});

test('prompts: the scratch folder line appears only when the folder is given', () => {
  assert.doesNotMatch(lead(), /temporary folder/);
  assert.match(lead({}, { tmpDir: '/data/tmp/c1' }), /Your temporary folder is \/data\/tmp\/c1 \(\$TMPDIR\)/);
  assert.match(lead({}, { tmpDir: '/data/tmp/c1', tmpIsEnv: false }), /Your temporary folder is \/data\/tmp\/c1, private/, 'a shared process (Codex): no $TMPDIR claim');
});
