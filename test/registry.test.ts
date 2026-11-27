import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../server/app/app.ts';
import { codexTeamModels } from '../server/backends/codex/families.ts';
import { FakeCodex } from '../server/backends/codex/testing/fake-app-server.ts';
import { BackendRegistry, codexProfile } from '../server/backends/registry.ts';
import type { ModelInfo } from '../server/backends/types.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Store } from '../server/storage/store.ts';

const model = (id: string, order: number, efforts: ModelInfo['efforts'] = ['low', 'medium', 'high', 'xhigh']): ModelInfo => ({
  id,
  label: id.toUpperCase(),
  efforts,
  nativeEffort: Object.fromEntries(efforts.map((e) => [e, e])),
  order,
});

test('codex team: families in capability order, the newest of each, then unknown ones by catalogue order', () => {
  // The catalogue's own order (priority) puts sol first; capability puts astra first.
  const all = [model('gpt-6.2-sol', 1), model('gpt-6.2-astra', 2), model('gpt-6.1-terra', 3), model('gpt-6.1-astra', 4), model('gpt-6-luna', 8, ['low', 'medium', 'high'])];
  assert.deepEqual(codexTeamModels(all).map((m) => m.id), ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna']);
  const p = codexProfile(all)!;
  assert.equal(p.id, 'codex');
  assert.deepEqual(p.tiers.map((t) => t.id), ['codex:0', 'codex:1', 'codex:2', 'codex:3']);
  assert.deepEqual(p.tiers.map((t) => t.backend), ['codex', 'codex', 'codex', 'codex']);
  assert.equal(p.tiers[0]!.lean, false);
  assert.equal(p.tiers[0]!.max, 1);
  assert.equal(p.tiers[3]!.effort, 'medium');
  assert.match(p.description ?? '', /installed Codex/);

  const noTerra = all.filter((m) => !m.id.endsWith('terra'));
  assert.deepEqual(codexProfile(noTerra)!.tiers.map((t) => t.model), ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-luna']);

  const extra = [...all, model('gpt-7-nova', 5), model('o9-mini', 6)];
  assert.deepEqual(codexTeamModels(extra).map((m) => m.id), ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-7-nova', 'o9-mini']);
  assert.equal(codexProfile(extra)!.tiers.length, 4, 'at most four tiers');

  const one = codexProfile([model('gpt-6-luna', 8, ['low', 'medium'])])!;
  assert.equal(one.tiers.length, 1);
  assert.equal(one.tiers[0]!.effort, 'medium', 'capped to what the model supports');
  assert.equal(codexProfile([]), null);
});

test('registry: the fake needs the allow flag and then stands in for every backend', () => {
  assert.throws(() => new BackendRegistry({ env: { MASTHEAD_BACKEND: 'fake' } }), /MASTHEAD_ALLOW_FAKE/);
  const r = new BackendRegistry({ env: { MASTHEAD_BACKEND: 'fake', MASTHEAD_ALLOW_FAKE: '1' } });
  assert.equal(r.get('claude-code')?.id, 'fake');
  assert.equal(r.get('codex')?.id, 'fake');
  assert.deepEqual(r.generatedProfiles(), []);
});

function codexRegistry(fake = new FakeCodex()) {
  return new BackendRegistry({
    env: {},
    claude: { path: null, version: null, error: 'Claude Code was not found.' },
    codex: { path: '/fake/codex', dataDir: mkdtempSync(join(tmpdir(), 'masthead-codexreg-')), env: {}, runCli: fake.runCli, spawnAppServer: fake.spawnAppServer },
  });
}

test('registry: detection reports each backend, reads Codex models and builds its team', async () => {
  const r = codexRegistry();
  try {
    const status = await r.detectAll();
    const claude = status.find((s) => s.id === 'claude-code')!;
    assert.equal(claude.available, false);
    assert.match(claude.error ?? '', /not found/);
    const codex = status.find((s) => s.id === 'codex')!;
    assert.equal(codex.available, true, codex.error);
    assert.deepEqual(codex.models.map((m) => m.id), ['fake-astra', 'fake-luna']);
    assert.equal(r.get('claude-code'), undefined);
    assert.equal(r.get('codex')?.id, 'codex');
    const [p] = r.generatedProfiles();
    assert.deepEqual(p!.tiers.map((t) => t.model), ['fake-astra', 'fake-luna']);
  } finally {
    await r.dispose();
  }
});

test('a conversation on the generated Codex team runs end to end on the fake app-server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'masthead-codexapp-'));
  const registry = codexRegistry();
  const app = new App({ store: new Store(join(dir, 'c')), settings: { ...defaultSettings(), defaultCwd: dir }, settingsFile: join(dir, 's.json'), registry });
  try {
    await registry.detectAll();
    app.backendsDetected();
    const msgs: Array<Record<string, any>> = [];
    const client = { send: (m: unknown) => void msgs.push(structuredClone(m) as never) };
    app.connect(client);
    app.handle(client, {
      t: 'send',
      convId: null,
      cwd: dir,
      profile: 'codex',
      // \u0020 keeps the scripted lead from reading the helper's task as its own instruction.
      text: 'Call the tool spawn_agent with input {"title":"helper","task":"Reply with exactly the word\\u0020KIWI"} then wait.',
    } as never);
    const reports = () => msgs.filter((m) => m.t === 'item' && m.item.kind === 'inbound' && m.item.via === 'report');
    const end = Date.now() + 8000;
    while (reports().length === 0) {
      const err = msgs.find((m) => m.t === 'error');
      if (err) throw new Error(err.message);
      if (Date.now() > end) throw new Error(`no report; items: ${JSON.stringify(msgs.filter((m) => m.t === 'item').map((m) => [m.item.kind, m.item.text ?? m.item.name, m.item.result]))} agents: ${JSON.stringify(msgs.filter((m) => m.t === 'agent').map((m) => [m.agent.name, m.agent.status, m.agent.error]))}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(reports()[0]!.item.text, /KIWI/);
    const agents = msgs.filter((m) => m.t === 'agent').map((m) => m.agent);
    assert.ok(agents.some((a) => a.tier === 'codex:1' && a.model === 'fake-luna'), 'the helper ran on the second Codex tier');
  } finally {
    app.shutdown();
    await registry.dispose();
  }
});

test('registry: "check again" looks for Claude Code again and offers it without a restart', async () => {
  let installed = false;
  const r = new BackendRegistry({
    env: {},
    claude: { path: null, version: null, error: 'Claude Code was not found.' },
    findClaude: () => (installed ? { path: '/new/claude', version: '2.1.400' } : { path: null, version: null, error: 'Claude Code was not found.' }),
    codex: false,
  });
  await r.detectAll();
  assert.equal(r.get('claude-code'), undefined);
  installed = true;
  const s = await r.detectAll();
  const c = s.find((x) => x.id === 'claude-code')!;
  assert.equal(c.available, true);
  assert.equal(c.version, '2.1.400');
  assert.ok(r.get('claude-code'));
  assert.deepEqual(r.claudeInfo(), { path: '/new/claude', version: '2.1.400' });
  const broken = new BackendRegistry({ env: {}, findClaude: () => ({ path: '/x/claude', version: null, error: 'Could not run it.' }), codex: false });
  await broken.detectAll();
  assert.equal(broken.get('claude-code'), undefined, 'a binary that will not run is not usable');
});
