// Settings v2 and team profiles (0.2.0 Core 4): migration from 0.1.x, validation in one place, the
// compatibility view the page still uses, and conversations on a chosen profile.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { test } from 'node:test';
import { Conversation, type ConversationHost } from '../server/core/conversation.ts';
import { Scheduler } from '../server/core/scheduler.ts';
import { absoluteFolder, claudeProfile, defaultSettings, loadSettings, sanitizeSettings, tierLimit } from '../server/settings/settings.ts';
import { childTierOf, findTier, isLeadTier, type Settings } from '../shared/protocol.ts';

const twoTier = { id: 'duo', label: 'Duo', tiers: [{ model: 'claude-opus-5-5', effort: 'high' }, { model: 'claude-haiku-5-5', max: 2, colour: 'rose' }] };

test('settings v2: defaults hold the claude profile, and the compatibility view mirrors it', () => {
  const s = defaultSettings();
  assert.equal(s.version, 2);
  assert.deepEqual(s.profiles.map((p) => p.id), ['claude']);
  assert.equal(s.defaultProfile, 'claude');
  assert.deepEqual(s.profiles[0]!.tiers.map((t) => t.id), ['lead', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(s.profiles[0]!.tiers.map((t) => t.colour), ['amber', 'violet', 'blue', 'teal']);
  assert.equal(s.tiers.opus.model, 'claude-opus-5-5');
  assert.equal(s.leanSubagents, true);
  assert.equal(s.leanOpus, true);
  assert.deepEqual(sanitizeSettings(JSON.parse(JSON.stringify(s))), s, 'a saved v2 file reads back the same');
});

test('settings v2: a 0.1.x file migrates into the claude profile, with a backup written first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'masthead-settings-'));
  const file = join(dir, 'settings.json');
  const v1 = { tiers: { opus: { model: 'my-opus', effort: 'high', max: 2 }, haiku: { max: 0 } }, leanSubagents: false, leanOpus: true, permissionMode: 'acceptEdits', defaultCwd: '/tmp' };
  writeFileSync(file, JSON.stringify(v1));
  const s = loadSettings(file);
  assert.equal(readFileSync(`${file}.v1.bak`, 'utf8'), JSON.stringify(v1), 'backup is the original file');
  const c = s.profiles.find((p) => p.id === 'claude')!;
  const opus = c.tiers.find((t) => t.id === 'opus')!;
  assert.equal(opus.model, 'my-opus');
  assert.equal(opus.label, 'my-opus', 'the label follows the model');
  assert.equal(opus.max, 2);
  assert.equal(c.tiers.find((t) => t.id === 'haiku')!.max, 0);
  assert.equal(c.tiers.find((t) => t.id === 'sonnet')!.lean, false);
  assert.equal(opus.lean, true);
  assert.equal(s.permissionMode, 'acceptEdits');
  // A later load of a v2 file does not touch the backup.
  writeFileSync(`${file}.v1.bak`, 'kept');
  writeFileSync(file, JSON.stringify(s));
  loadSettings(file);
  assert.equal(readFileSync(`${file}.v1.bak`, 'utf8'), 'kept');
  const fresh = join(dir, 'v2.json');
  writeFileSync(fresh, JSON.stringify(defaultSettings()));
  loadSettings(fresh);
  assert.equal(existsSync(`${fresh}.v1.bak`), false);
});

test('settings v2: profiles are validated in one place', () => {
  const s = sanitizeSettings({
    profiles: [
      twoTier,
      { id: 'duo', tiers: [{ model: 'x' }] }, // duplicate
      { id: 'Bad Id', tiers: [{ model: 'x' }] },
      { id: 'six', tiers: Array.from({ length: 6 }, () => ({ model: 'm' })) }, // too many tiers
      { id: 'empty', tiers: [] },
      { id: 'nomodel', tiers: [{ effort: 'low' }] },
      { id: 'claude', tiers: [{ model: 'claude-fable-5-2', max: 9 }, { max: 99, effort: 'max', colour: 'neon' }] },
    ],
    defaultProfile: 'duo',
  });
  assert.deepEqual(s.profiles.map((p) => p.id), ['duo', 'claude']);
  const duo = s.profiles[0]!;
  assert.deepEqual(duo.tiers.map((t) => t.id), ['duo:0', 'duo:1']);
  assert.equal(duo.tiers[0]!.max, 1, 'the lead tier keeps max 1');
  assert.equal(duo.tiers[1]!.colour, 'rose');
  assert.equal(duo.tiers[1]!.label, 'Haiku 5.5');
  assert.equal(duo.builtIn, false);
  const c = s.profiles[1]!;
  assert.deepEqual(c.tiers.map((t) => t.id), ['lead', 'opus', 'sonnet', 'haiku'], 'the claude profile keeps its four tiers');
  assert.equal(c.tiers[1]!.max, 12, 'clamped');
  assert.equal(c.tiers[1]!.effort, 'xhigh', 'no max effort');
  assert.equal(c.tiers[1]!.colour, 'violet', 'unknown colour ignored');
  assert.equal(s.defaultProfile, 'duo');
  assert.equal(sanitizeSettings({ defaultProfile: 'nope' }, s).defaultProfile, 'duo');
  assert.equal(sanitizeSettings({ profiles: [twoTier] }).profiles.some((p) => p.id === 'claude'), true, 'claude is always there');
  assert.equal(sanitizeSettings({ profiles: [] }, s).defaultProfile, 'claude', 'a default that disappears falls back');
});

test('settings v2: a page patch in the old shape changes the claude profile', () => {
  const s = sanitizeSettings({ tiers: { opus: { max: 1 } }, leanOpus: false }, defaultSettings());
  assert.equal(s.profiles[0]!.tiers[1]!.max, 1);
  assert.equal(s.tiers.opus.max, 1);
  assert.equal(s.profiles[0]!.tiers[1]!.lean, false);
  assert.equal(s.leanOpus, false);
});

test('settings v2: the default folder must be absolute on this system (C:\\ on Windows)', () => {
  assert.equal(absoluteFolder('C:\\Users\\me', path.win32), true);
  assert.equal(absoluteFolder('\\\\server\\share', path.win32), true);
  assert.equal(absoluteFolder('relative\\x', path.win32), false);
  assert.equal(absoluteFolder('C:\\Users\\me', path.posix), false);
  assert.equal(absoluteFolder('/home/me', path.posix), true);
  assert.equal(absoluteFolder('relative', path.posix), false);
  assert.equal(absoluteFolder('', path.posix), false);
  assert.equal(absoluteFolder(42, path.posix), false);
  assert.equal(sanitizeSettings({ defaultCwd: 'relative' }).defaultCwd, defaultSettings().defaultCwd);
});

test('profiles: tier lookups, the lead tier, children and limits', () => {
  const s = sanitizeSettings({ profiles: [claudeProfile(), twoTier] });
  assert.equal(childTierOf(s, 'lead'), 'opus');
  assert.equal(childTierOf(s, 'haiku'), null);
  assert.equal(childTierOf(s, 'duo:0'), 'duo:1');
  assert.equal(childTierOf(s, 'duo:1'), null);
  assert.equal(childTierOf(s, 'gone'), null);
  assert.equal(isLeadTier(s, 'duo:0'), true);
  assert.equal(findTier(s, 'duo:1')!.model, 'claude-haiku-5-5');
  assert.equal(tierLimit(s, 'lead'), Infinity);
  assert.equal(tierLimit(s, 'duo:0'), Infinity);
  assert.equal(tierLimit(s, 'duo:1'), 2);
  assert.equal(tierLimit(s, 'gone'), 0);
  const sched = new Scheduler((t) => tierLimit(s, t));
  assert.equal(sched.running('duo:0' as never), 0);
});

function host(settings: Settings): ConversationHost {
  return {
    scheduler: new Scheduler((t) => tierLimit(settings, t)),
    settings: () => settings,
    claudePath: () => null,
    agentChanged() {},
    itemChanged() {},
    draftChanged() {},
    metaChanged() {},
    rateLimit() {},
    askPermission: async () => ({ decision: 'deny' }) as never,
    cancelPermissions() {},
  };
}

test('profiles: a conversation runs on the profile chosen for it; 0.1.x conversations are claude', () => {
  const s = sanitizeSettings({ profiles: [claudeProfile(), twoTier] });
  const conv = Conversation.create(host(s), tmpdir(), 'duo');
  assert.equal(conv.meta.profileId, 'duo');
  assert.equal(conv.lead.tier, 'duo:0');
  assert.equal(conv.lead.info.model, 'claude-opus-5-5');
  assert.match(conv.spawn(conv.lead, 'A', 'task', undefined), /^Started Haiku 5\.5 agent "bravo"/);
  const bravo = [...conv.agents.values()].find((a) => a.name === 'bravo')!;
  assert.equal(bravo.tier, 'duo:1');
  assert.match(conv.spawn(bravo, 'B', 'task', undefined), /^Error: Haiku 5\.5 agents cannot start other agents\./, 'the last tier starts nothing');
  const plain = Conversation.create(host(s), tmpdir());
  assert.equal(plain.meta.profileId, 'claude');
  assert.equal(plain.lead.tier, 'lead');
  const unknown = Conversation.create(host(s), tmpdir(), 'nope');
  assert.equal(unknown.meta.profileId, 'claude', 'an unknown profile falls back to the default');
});

test('settings v2: a whole settings object whose compatibility view was edited applies the edit', () => {
  const s = defaultSettings();
  s.tiers.opus.max = 1; // as test/live.e2e.ts and older pages do
  s.leanOpus = false;
  const out = sanitizeSettings(JSON.parse(JSON.stringify(s)), defaultSettings());
  assert.equal(out.profiles[0]!.tiers[1]!.max, 1);
  assert.equal(out.profiles[0]!.tiers[1]!.lean, false);
  assert.equal(out.profiles[0]!.tiers[2]!.lean, true, 'unchanged fields stay');
});

test('settings v2: generated built-in profiles are added once; a stored copy wins', async () => {
  const { withBuiltInProfiles } = await import('../server/settings/settings.ts');
  const codex = { id: 'codex', label: 'Codex', builtIn: true, tiers: [0, 1].map((i) => ({ id: `codex:${i}`, label: `M${i}`, backend: 'codex', model: `m-${i}`, effort: 'medium' as const, max: i ? 3 : 1, lean: i > 0, colour: 'amber' as const })) };
  const s = withBuiltInProfiles(defaultSettings(), [codex]);
  const p = s.profiles.find((x) => x.id === 'codex')!;
  assert.equal(p.builtIn, true);
  assert.deepEqual(p.tiers.map((t) => t.id), ['codex:0', 'codex:1']);
  assert.equal(p.tiers[1]!.backend, 'codex');
  const edited = sanitizeSettings({ profiles: s.profiles.map((x) => (x.id === 'codex' ? { ...x, tiers: [x.tiers[0], { ...x.tiers[1], max: 1 }] } : x)) }, s);
  const again = withBuiltInProfiles(edited, [codex]);
  assert.equal(again.profiles.find((x) => x.id === 'codex')!.tiers[1]!.max, 1);
  assert.equal(again.profiles.find((x) => x.id === 'codex')!.builtIn, true);
});

test('settings v2: a profile keeps a short description', () => {
  const s = sanitizeSettings({ profiles: [{ ...twoTier, description: `  Built from\nthe list. ${'x'.repeat(300)}` }] });
  const d = s.profiles.find((p) => p.id === 'duo')!.description!;
  assert.ok(d.startsWith('Built from the list.'));
  assert.equal(d.length, 200);
});
