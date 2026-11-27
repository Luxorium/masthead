// Live: a conversation on the generated Codex team, through the real App, registry and signed-in Codex CLI.
// Not part of `npm test` (real, small Codex usage). Run: node --import tsx test/codex-team.live.ts
// Every tier is set to the cheapest model (MASTHEAD_CODEX_MODEL, default gpt-6-luna) at low effort, in a
// temp folder; every thread it creates is deleted afterwards (`codex delete --force <id>`).
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../server/app/app.ts';
import { BackendRegistry } from '../server/backends/registry.ts';
import type { SessionEvents, SessionSpec } from '../server/backends/types.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Store } from '../server/storage/store.ts';
import { finishWorkFolder } from './workdir.ts';

const model = process.env.MASTHEAD_CODEX_MODEL ?? 'gpt-6-luna';
const dir = mkdtempSync(join(tmpdir(), 'masthead-codex-team-'));
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
const created = new Set<string>();
let failed = false;
const check = (name: string, ok: boolean) => {
  log(ok ? `PASS ${name}` : `FAIL ${name}`);
  if (!ok) failed = true;
};

const registry = new BackendRegistry({ claude: { path: null, version: null }, codex: {} });
let app: App | null = null;
try {
  const status = await registry.detectAll();
  const codex = status.find((s) => s.id === 'codex')!;
  log('codex:', codex.available ? `${codex.version}${codex.warning ? ` (${codex.warning})` : ''}` : codex.error, '- models:', codex.models.map((m) => m.id).join(' '));
  check('codex is usable', codex.available);
  const [profile] = registry.generatedProfiles();
  check('a Codex team was generated from the model list', !!profile && profile.tiers.length >= 2);
  log('generated team:', profile?.tiers.map((t) => `${t.id}=${t.model}/${t.effort}`).join(' '));
  if (!profile || profile.tiers.length < 2) throw new Error('no Codex team');

  // Remember every thread, to delete it afterwards.
  const backend = registry.get('codex')!;
  const open = backend.open.bind(backend);
  backend.open = (spec: SessionSpec, ev: SessionEvents) =>
    open(spec, new Proxy(ev, { get: (t, k) => (k === 'sessionStarted' ? (id: string) => (created.add(id), t.sessionStarted(id)) : (t as any)[k]) }));

  const settings = { ...defaultSettings(), defaultCwd: dir, permissionMode: 'default' as const };
  app = new App({ store: new Store(join(dir, 'c')), settings, settingsFile: join(dir, 's.json'), registry });
  app.backendsDetected();
  // The cheapest model at low effort on every tier of the generated team.
  const s = app.settings();
  const cheap = { ...s, autoEffort: false, profiles: s.profiles.map((p) => (p.id === 'codex' ? { ...p, tiers: p.tiers.map((t) => ({ ...t, model, effort: 'low' as const })) } : p)) };
  app.handle({ send: () => {} }, { t: 'settings', settings: cheap } as never);

  const msgs: Array<Record<string, any>> = [];
  const client = { send: (m: unknown) => void msgs.push(structuredClone(m) as never) };
  app.connect(client);
  app.handle(client, {
    t: 'send',
    convId: null,
    cwd: dir,
    profile: 'codex',
    text: 'This is a wiring test; follow it literally. Use spawn_agent once with the title "leaf" and the task: Reply with only the word PINEAPPLE. Then end your turn. When its report arrives, tell me exactly the word it reported.',
  } as never);
  const reports = () => msgs.filter((m) => m.t === 'item' && m.item.kind === 'inbound' && m.item.via === 'report');
  const leadSaid = () => msgs.filter((m) => m.t === 'item' && m.item.kind === 'text').map((m) => m.item.text as string);
  const end = Date.now() + 240_000;
  while (!(reports().length > 0 && leadSaid().some((x) => /PINEAPPLE/i.test(x)) && msgs.filter((m) => m.t === 'agent').at(-1)?.agent.status === 'idle')) {
    const err = msgs.find((m) => m.t === 'error');
    if (err) throw new Error(err.message);
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
  const agents = new Map<string, any>();
  for (const m of msgs) if (m.t === 'agent') agents.set(m.agent.id, m.agent);
  log('agents:', [...agents.values()].map((a) => `${a.name}:${a.tier}:${a.model}:${a.status}`).join(' '));
  check('the leaf ran on the second Codex tier and finished', [...agents.values()].some((a) => a.tier === 'codex:1' && a.status === 'done'));
  check('its report reached the lead', /PINEAPPLE/i.test(reports()[0]!.item.text));
  check('the lead passed it on', leadSaid().some((x) => /PINEAPPLE/i.test(x)));
} catch (e) {
  log('FAILED:', (e as Error).message);
  failed = true;
} finally {
  app?.shutdown();
  await registry.dispose();
  for (const id of created) {
    try {
      execFileSync(process.env.MASTHEAD_CODEX || 'codex', ['delete', '--force', id], { stdio: 'ignore', timeout: 30_000 });
    } catch {
      // ephemeral or already gone
    }
  }
  log(`deleted ${created.size} test thread(s); ${failed ? 'WITH FAILURES' : 'all passed'}`);
  finishWorkFolder(dir, failed, log);
  process.exit(failed ? 1 : 0);
}
