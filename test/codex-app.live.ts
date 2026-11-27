// Live: Codex through the real App and registry, for what the backend conformance run cannot show: a
// permission prompt answered by the person, an image in a message, stop, and a mixed Claude+Codex team.
// Not part of `npm test` (real, small Codex and Claude usage). Run: node --import tsx test/codex-app.live.ts
// Codex tiers use MASTHEAD_CODEX_MODEL (default gpt-6-luna) at low effort; the Claude lead of the mixed
// team uses claude-haiku-5-5 at low effort. Everything runs in a temp folder and every Codex thread it
// creates is deleted afterwards (`codex delete --force <id>`).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { App } from '../server/app/app.ts';
import { findClaude } from '../server/backends/claude/env.ts';
import { BackendRegistry } from '../server/backends/registry.ts';
import type { SessionEvents, SessionSpec } from '../server/backends/types.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Store } from '../server/storage/store.ts';

const model = process.env.MASTHEAD_CODEX_MODEL ?? 'gpt-6-luna';
const dir = mkdtempSync(join(tmpdir(), 'masthead-codex-app-'));
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
const created = new Set<string>();
let failed = false;
const check = (name: string, ok: boolean) => {
  log(ok ? `PASS ${name}` : `FAIL ${name}`);
  if (!ok) failed = true;
};

/** A solid-colour 16x16 PNG, made here so the test needs no image file. */
function png(r: number, g: number, b: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    td.copy(out, 4);
    out.writeUInt32BE(crc(td), 8 + data.length);
    return out;
  };
  const w = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: w }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const registry = new BackendRegistry({ claude: findClaude(), findClaude, codex: {} });
let app: App | null = null;
const msgs: Array<Record<string, any>> = [];
const client = { send: (m: unknown) => void msgs.push(structuredClone(m) as never) };

async function until(what: string, ok: () => boolean, ms = 180_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    const err = msgs.find((m) => m.t === 'error');
    if (err) throw new Error(`${what}: ${err.message}`);
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
const convOf = (from: number) => msgs.slice(from).find((m) => m.t === 'created')?.convId as string | undefined;
const items = (conv: string, kind: string) => msgs.filter((m) => m.t === 'item' && m.convId === conv && m.item.kind === kind).map((m) => m.item);
const lastAgent = (conv: string, agentId?: string) =>
  msgs.filter((m) => m.t === 'agent' && m.agent.convId === conv && (!agentId || m.agent.id === agentId)).at(-1)?.agent;
const leadIdle = (conv: string) => {
  const a = msgs.filter((m) => m.t === 'agent' && m.agent.convId === conv && m.agent.parentId == null).at(-1)?.agent;
  return a?.status === 'idle';
};

try {
  const status = await registry.detectAll();
  const codex = status.find((s) => s.id === 'codex')!;
  const claude = status.find((s) => s.id === 'claude-code')!;
  log('codex:', codex.available ? codex.version : codex.error, '- claude:', claude.available ? claude.version : claude.error);
  check('codex is usable', codex.available);
  if (!codex.available) throw new Error('no Codex');

  const backend = registry.get('codex')!;
  const open = backend.open.bind(backend);
  backend.open = (spec: SessionSpec, ev: SessionEvents) =>
    open(spec, new Proxy(ev, { get: (t, k) => (k === 'sessionStarted' ? (id: string) => (created.add(id), t.sessionStarted(id)) : (t as any)[k]) }));

  const settings = { ...defaultSettings(), defaultCwd: dir, permissionMode: 'default' as const };
  app = new App({ store: new Store(join(dir, 'c')), settings, settingsFile: join(dir, 's.json'), registry });
  app.backendsDetected();
  const s = app.settings();
  const codexProfile = s.profiles.find((p) => p.id === 'codex')!;
  const cheap = (t: (typeof codexProfile.tiers)[number]) => ({ ...t, model, effort: 'low' as const });
  const mixed = {
    id: 'mixed',
    label: 'Mixed',
    builtIn: false,
    tiers: [
      { ...s.profiles.find((p) => p.id === 'claude')!.tiers.at(-1)!, id: 'mixed:0', backend: 'claude-code', model: 'claude-haiku-5-5', effort: 'low' as const },
      { ...cheap(codexProfile.tiers.at(-1)!), id: 'mixed:1' },
    ],
  };
  app.handle({ send: () => {} }, {
    t: 'settings',
    settings: { autoEffort: false, profiles: [...s.profiles.map((p) => (p.id === 'codex' ? { ...p, tiers: p.tiers.map(cheap) } : p)), mixed] },
  } as never);
  log('profiles:', app.settings().profiles.map((p) => `${p.id}[${p.tiers.map((t) => `${t.backend}/${t.model}${t.unusable ? ` UNUSABLE ${t.unusable}` : ''}`).join(',')}]`).join(' '));
  app.connect(client);

  // 1. Permission prompt: denied once, then allowed.
  {
    const from = msgs.length;
    app.handle(client, { t: 'send', convId: null, cwd: dir, profile: 'codex', text: 'Run exactly this shell command: touch denied.txt — then say DONE or say it was denied.' } as never);
    await until('a permission request', () => msgs.slice(from).some((m) => m.t === 'permission_request'));
    const conv = convOf(from)!;
    const req = msgs.slice(from).find((m) => m.t === 'permission_request')!.request;
    log('permission request:', req.toolName, JSON.stringify(req.input).slice(0, 120), 'canAlways', req.canAlways);
    check('a Codex shell command asks the person', !!req);
    app.handle(client, { t: 'permission', requestId: req.id, decision: 'deny', message: 'not now' } as never);
    await until('the turn ends after the denial', () => leadIdle(conv) && msgs.slice(from).some((m) => m.t === 'permission_resolved'));
    check('a denied command did not run', !existsSync(join(dir, 'denied.txt')));

    const from2 = msgs.length;
    app.handle(client, { t: 'send', convId: conv, text: 'Now run exactly: touch allowed.txt — then say DONE.' } as never);
    await until('a second permission request', () => msgs.slice(from2).some((m) => m.t === 'permission_request'));
    const req2 = msgs.slice(from2).find((m) => m.t === 'permission_request')!.request;
    app.handle(client, { t: 'permission', requestId: req2.id, decision: 'allow' } as never);
    await until('the command runs', () => existsSync(join(dir, 'allowed.txt')) && leadIdle(conv));
    check('an allowed command ran', existsSync(join(dir, 'allowed.txt')));

    // 2. An image in a message.
    const from3 = msgs.length;
    app.handle(client, { t: 'send', convId: conv, text: 'What single colour fills the attached image? Reply with one word.', images: [{ mediaType: 'image/png', data: png(255, 0, 0) }] } as never);
    await until('an answer about the image', () => leadIdle(conv) && msgs.slice(from3).some((m) => m.t === 'item' && m.item.kind === 'text'));
    const said = msgs.slice(from3).filter((m) => m.t === 'item' && m.item.kind === 'text').map((m) => m.item.text).join(' ');
    log('image answer:', said.slice(0, 80));
    check('Codex saw the image', /red/i.test(said));

    // 3. Stop all during a long turn.
    const from4 = msgs.length;
    app.handle(client, { t: 'send', convId: conv, text: 'Count slowly from 1 to 400, one number per line, in plain text. Do not use tools.' } as never);
    await until('the turn starts', () => lastAgent(conv)?.status === 'running' && msgs.slice(from4).some((m) => m.t === 'draft' && m.draft));
    app.handle(client, { t: 'stop_all', convId: conv } as never);
    const stoppedAt = Date.now();
    await until('everyone stops', () => !msgs.filter((m) => m.t === 'agent' && m.agent.convId === conv).some((m) => ['queued', 'running', 'waiting'].includes(lastAgent(conv, m.agent.id)?.status)), 30_000);
    log('stopped in', Date.now() - stoppedAt, 'ms; lead status', lastAgent(conv)?.status);
    check('stop all ends a Codex turn', true);
  }

  // 4. Mixed team: a Claude lead starts a Codex helper.
  if (!claude.available) log('SKIP mixed team: Claude Code not found');
  else {
    const from = msgs.length;
    app.handle(client, {
      t: 'send',
      convId: null,
      cwd: dir,
      profile: 'mixed',
      text: 'This is a wiring test; follow it literally. Use spawn_agent once with the title "leaf" and the task: Reply with only the word PINEAPPLE. Then end your turn. When its report arrives, tell me exactly the word it reported.',
    } as never);
    await until('the mixed team finishes', () => {
      const c = convOf(from);
      return !!c && items(c, 'inbound').some((i) => i.via === 'report') && items(c, 'text').some((i) => /PINEAPPLE/i.test(i.text)) && leadIdle(c);
    }, 240_000);
    const conv = convOf(from)!;
    const agents = new Map<string, any>();
    for (const m of msgs) if (m.t === 'agent' && m.agent.convId === conv) agents.set(m.agent.id, m.agent);
    log('agents:', [...agents.values()].map((a) => `${a.name}:${a.tier}:${a.model}:${a.status}`).join(' '));
    check('the Codex helper of a Claude lead ran and finished', [...agents.values()].some((a) => a.tier === 'mixed:1' && a.status === 'done'));
    check('its report reached the Claude lead', items(conv, 'text').some((i) => /PINEAPPLE/i.test(i.text)));
  }
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
  log(`deleted ${created.size} test thread(s); ${failed ? 'WITH FAILURES' : 'all passed'} - work folder: ${dir}`);
  process.exit(failed ? 1 : 0);
}
