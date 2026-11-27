// Live: restart handling (0.2.1) against the real Claude Code on this machine. Real (small) usage, so
// not part of `npm test`. Run: node --import tsx test/restart.live.ts [1] [2] [3]   (default: all three)
//  1. Clean stop while a helper runs a long command: a new App on the same folders gives the lead a turn
//     of its own, with a page notice naming the helper; the lead acts on it; a second restart sends nothing.
//  2. A person message accepted, then a clean stop before the lead answers: it is answered once, with a notice.
//  3. Hard kill (SIGKILL of the whole server process group) while the lead is mid-turn: the next start
//     finds the lead saved as running and it carries on.
// Every tier is Haiku at low effort, permissions bypassed (the commands are timed waits in node and nothing else), in
// fresh temp folders with their own data and config; remote access off; never port 7717. Scenario 3 runs
// the server as a child on port 7801 with its systemd variables removed (it must not read or delete the
// real service's last-stop marker). The work folder is removed when everything passed.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import type { AgentInfo, Item, ServerMsg, Settings } from '../shared/protocol.ts';
import { App, type Client } from '../server/app/app.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { findClaude } from '../server/backends/claude/env.ts';
import { Store } from '../server/storage/store.ts';
import { finishWorkFolder } from './workdir.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'masthead-restart-live-')));
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
let failed = false;
const check = (name: string, ok: boolean) => {
  log(ok ? `PASS ${name}` : `FAIL ${name}`);
  if (!ok) failed = true;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const claude = findClaude();
const HAIKU = 'claude-haiku-5-5';

function cheapSettings(cwd: string): Settings {
  const s = defaultSettings();
  for (const p of s.profiles) for (const t of p.tiers) Object.assign(t, { model: HAIKU, effort: 'low' });
  for (const t of Object.values(s.tiers)) Object.assign(t, { model: HAIKU, effort: 'low' });
  return { ...s, defaultCwd: cwd, permissionMode: 'bypassPermissions', autoEffort: false, keepAwake: false };
}

/** One App over a folder, with a client that records what the page would see. */
function openApp(dir: string, label: string) {
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const app = new App({ store: new Store(join(dir, 'conversations')), claude, settings: cheapSettings(work), settingsFile: join(dir, 'settings.json') });
  const agents = new Map<string, AgentInfo>();
  const items = new Map<string, Item[]>();
  let convId = '';
  const client: Client = {
    send(sent: ServerMsg) {
      const m = structuredClone(sent);
      if (m.t === 'created') convId = m.convId;
      else if (m.t === 'agent') {
        const before = agents.get(m.agent.id);
        agents.set(m.agent.id, m.agent);
        if (!before || before.status !== m.agent.status) log(`${label} [${m.agent.name}] ${m.agent.status}${m.agent.error ? ` (${m.agent.error})` : ''}`);
      } else if (m.t === 'item') {
        const list = items.get(m.agentId) ?? [];
        const i = list.findIndex((x) => x.id === m.item.id);
        if (i >= 0) list[i] = m.item;
        else list.push(m.item);
        items.set(m.agentId, list);
        const name = agents.get(m.agentId)?.name ?? '?';
        const it = m.item;
        if (it.kind === 'text') log(`${label} [${name}] says: ${it.text.replace(/\s+/g, ' ').slice(0, 220)}`);
        else if (it.kind === 'tool' && !it.done) log(`${label} [${name}] tool ${it.name.replace('mcp__masthead__', 'mh:')} ${JSON.stringify(it.input).slice(0, 160)}`);
        else if (it.kind === 'inbound') log(`${label} [${name}] <${it.via} from ${it.from}> ${it.text.replace(/\s+/g, ' ').slice(0, 160)}`);
        else if (it.kind === 'notice') log(`${label} [${name}] notice: ${it.text.slice(0, 240)}`);
        else if (it.kind === 'user') log(`${label} [${name}] person: ${it.text.slice(0, 120)}`);
      } else if (m.t === 'error') log(`${label} ERROR`, m.message);
    },
  };
  app.connect(client);
  const all = () => [...agents.values()];
  const lead = () => all().find((a) => a.parentId === null);
  const of = (name: string) => all().find((a) => a.name === name);
  const itemsOf = (name: string) => items.get(of(name)?.id ?? '') ?? [];
  return { app, client, all, lead, of, itemsOf, convId: () => convId };
}

async function until(what: string, cond: () => boolean, ms = 180_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(300);
  }
}
const texts = (list: Item[], kind: string) => list.filter((i) => i.kind === kind).map((i) => (i as { text: string }).text);
const live = (a?: AgentInfo) => !!a && (a.status === 'queued' || a.status === 'running' || a.status === 'waiting');

// ---- 1 ----
async function scenario1(): Promise<void> {
  log('=== 1. clean stop while a helper runs a long command');
  const dir = join(root, 's1');
  const a = openApp(dir, '1a');
  a.app.handle(a.client, {
    t: 'send',
    convId: null,
    text: 'This is a wiring test; follow it literally. Use spawn_agent once with the title "sleeper" and the task: "Run the shell command `timeout 40 tail -f /dev/null; echo waited` in the foreground (not in the background; it is a deliberate 40-second wait for a test and ends by itself), then reply with exactly the word AWAKE." Then end your turn and wait for its report. When the report arrives, tell me the word it reported.',
  } as never);
  await until('the helper runs sleep', () => a.itemsOf('bravo').some((i) => i.kind === 'tool' && !i.done && /timeout 40/.test(JSON.stringify(i.input))));
  await sleep(1500);
  log('lead status at the stop:', a.lead()?.status, '- helper:', a.of('bravo')?.status);
  a.app.shutdown(); // what SIGTERM does
  await sleep(1500);

  const b = openApp(dir, '1b');
  // Nothing is sent: the lead must act by itself.
  await until('the lead gets a turn of its own', () => b.lead()?.status === 'running' || texts(b.itemsOf('alpha'), 'text').length > 0, 30_000);
  const notices = texts(b.itemsOf('alpha'), 'notice');
  check('1: the page notice names the stopped helper', notices.some((t) => /restarted while a helper was working/.test(t) && /bravo \(sleeper, started by alpha\)/.test(t)));
  check('1: nobody typed anything', texts(b.itemsOf('alpha'), 'user').length === 0);
  await until('the lead acts on the note', () => b.itemsOf('alpha').some((i) => i.kind === 'tool' && /send_message|spawn_agent/.test(i.name)), 120_000);
  const acted = b.itemsOf('alpha').find((i) => i.kind === 'tool' && /send_message|spawn_agent/.test(i.name)) as Item & { kind: 'tool' };
  log('1: the lead did:', acted.name.replace('mcp__masthead__', ''), JSON.stringify(acted.input).slice(0, 200));
  check('1: the lead resumed or restarted the helper', /send_message|spawn_agent/.test(acted.name));
  await until('the work is finished', () => /AWAKE/i.test(texts(b.itemsOf('alpha'), 'text').join('\n')) && b.lead()?.status === 'idle' && !b.all().some((x) => x.parentId !== null && live(x)), 180_000);
  check('1: the helper\'s word reached the lead after the restart', /AWAKE/i.test(texts(b.itemsOf('alpha'), 'text').join('\n')));
  b.app.shutdown();
  await sleep(1000);

  const c = openApp(dir, '1c');
  await sleep(8000);
  check('1: a second restart sends nothing again', c.lead()?.status !== 'running' && texts(c.itemsOf('alpha'), 'notice').length === 0 && texts(c.itemsOf('alpha'), 'text').length === 0);
  c.app.shutdown();
}

// ---- 2 ----
async function scenario2(): Promise<void> {
  log('=== 2. a person message, then a clean stop before the lead answers');
  const dir = join(root, 's2');
  const a = openApp(dir, '2a');
  a.app.handle(a.client, { t: 'send', convId: null, text: 'Reply with exactly the word MANGO.' } as never);
  // Stopped at once: the lead's process has not answered (it may not even have started).
  a.app.shutdown();
  log('lead status at the stop:', a.lead()?.status, '- its items:', a.itemsOf('alpha').map((i) => i.kind).join(','));
  await sleep(1500);
  const b = openApp(dir, '2b');
  await until('answered', () => /MANGO/.test(texts(b.itemsOf('alpha'), 'text').join('\n')) && b.lead()?.status === 'idle', 120_000);
  check('2: the notice says the message was sent again', texts(b.itemsOf('alpha'), 'notice').some((t) => /before the lead answered your last message, so it was sent to the lead again/.test(t)));
  check('2: answered once', texts(b.itemsOf('alpha'), 'text').filter((t) => /MANGO/.test(t)).length === 1);
  check('2: no "cut off mid-turn" note on top of it', !texts(b.itemsOf('alpha'), 'notice').some((t) => /while the lead was working/.test(t)));
  b.app.shutdown();
  await sleep(1000);
  const c = openApp(dir, '2c');
  await sleep(8000);
  check('2: a second restart sends nothing again', c.lead()?.status !== 'running' && texts(c.itemsOf('alpha'), 'text').length === 0);
  c.app.shutdown();
}

// ---- 3 ----
const PORT = 7801;
function startServer(dir: string, label: string): ChildProcess {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MASTHEAD_DATA_DIR: join(dir, 'data'),
    MASTHEAD_CONFIG_DIR: join(dir, 'config'),
    MASTHEAD_TAILSCALE: 'off',
    XDG_RUNTIME_DIR: join(dir, 'run'),
    MASTHEAD_PORT: undefined,
    MASTHEAD_DEV: undefined,
  };
  // Not a unit's process: no last-stop marker is read or removed, and no service is involved.
  delete env.INVOCATION_ID;
  delete env.JOURNAL_STREAM;
  delete env.NOTIFY_SOCKET;
  const repo = resolve(import.meta.dirname, '..');
  const child = spawn(process.execPath, ['--disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED', '--import', 'tsx', join(repo, 'server', 'main.ts'), 'serve', '--port', String(PORT)], {
    cwd: repo,
    env: env as NodeJS.ProcessEnv,
    detached: true, // its own process group, so kill -9 takes Claude Code with it, as an OOM kill of the unit does
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => log(`${label} server: ${String(d).trim()}`));
  child.stderr!.on('data', (d) => log(`${label} server err: ${String(d).trim().slice(0, 300)}`));
  return child;
}
async function health(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1000) });
    return ((await r.json()) as { name?: string }).name === 'masthead';
  } catch {
    return false;
  }
}
function storedLead(dir: string): { status: string; items: Item[] } | null {
  const convs = join(dir, 'data', 'conversations');
  if (!existsSync(convs)) return null;
  const id = readdirSync(convs)[0];
  if (!id) return null;
  try {
    const c = JSON.parse(readFileSync(join(convs, id, 'conversation.json'), 'utf8')) as { meta: { leadId: string }; agents: Array<{ info: AgentInfo }> };
    const lead = c.agents.find((a) => a.info.id === c.meta.leadId)!;
    const file = join(convs, id, 'items', `${lead.info.id}.jsonl`);
    const byId = new Map<string, Item>();
    if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const it = JSON.parse(l) as Item;
      byId.set(it.id, it);
    }
    return { status: lead.info.status, items: [...byId.values()] };
  } catch {
    return null;
  }
}

async function scenario3(): Promise<void> {
  log('=== 3. hard kill (SIGKILL) while the lead is mid-turn');
  const dir = join(root, 's3');
  for (const d of ['data', 'config', 'run', 'work']) mkdirSync(join(dir, d), { recursive: true });
  const s = cheapSettings(join(dir, 'work'));
  writeFileSync(join(dir, 'config', 'settings.json'), JSON.stringify(s));
  if (await health()) throw new Error(`something already answers on port ${PORT}`);
  let server = startServer(dir, '3a');
  try {
    const end = Date.now() + 30_000;
    while (!(await health())) {
      if (Date.now() > end) throw new Error('the test server did not start');
      await sleep(300);
    }
    const key = readFileSync(join(dir, 'data', 'secret'), 'utf8').trim();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['masthead', `key.${key}`], { headers: { origin: `http://127.0.0.1:${PORT}` } });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    ws.send(JSON.stringify({ t: 'send', convId: null, cwd: join(dir, 'work'), text: 'Run the shell command `timeout 25 tail -f /dev/null; echo waited` in the foreground (not in the background; it is a deliberate 25-second wait for a test and ends by itself). When it has finished, reply with exactly the word PEAR.' }));
    await until('the lead is saved as running, mid-command', () => {
      const l = storedLead(dir);
      return !!l && l.status === 'running' && l.items.some((i) => i.kind === 'tool' && /timeout 25/.test(JSON.stringify(i.input)));
    }, 60_000);
    await sleep(1000);
    ws.terminate();
    log('3: kill -9 of the server process group');
    process.kill(-server.pid!, 'SIGKILL');
    await sleep(1500);
    check('3: the stored lead says running after the kill', storedLead(dir)?.status === 'running');

    server = startServer(dir, '3b');
    await until('the lead carries on and answers', () => {
      const l = storedLead(dir);
      return !!l && texts(l.items, 'text').some((t) => /PEAR/.test(t));
    }, 150_000);
    const l = storedLead(dir)!;
    check('3: the page notice says the lead was asked to carry on', texts(l.items, 'notice').some((t) => /restarted while the lead was working; it was asked to carry on/.test(t)));
    check('3: nobody typed again', texts(l.items, 'user').length === 1);
    check('3: answered once', texts(l.items, 'text').filter((t) => /PEAR/.test(t)).length === 1);
    log('3: the lead said:', texts(l.items, 'text').map((t) => t.replace(/\s+/g, ' ').slice(0, 160)).join(' | '));
    // Stop it cleanly through its own shutdown route.
    await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST', headers: { 'x-masthead': '1', 'x-masthead-key': key }, signal: AbortSignal.timeout(3000) }).catch(() => {});
    await sleep(2000);
    server = startServer(dir, '3c');
    await sleep(10_000);
    const again = storedLead(dir)!;
    check('3: a further restart sends nothing again', texts(again.items, 'text').filter((t) => /PEAR/.test(t)).length === 1 && again.status !== 'running');
    await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST', headers: { 'x-masthead': '1', 'x-masthead-key': key }, signal: AbortSignal.timeout(3000) }).catch(() => {});
    await sleep(2000);
  } finally {
    try {
      process.kill(-server.pid!, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

const want = process.argv.slice(2);
try {
  if (!claude.path) throw new Error('Claude Code was not found');
  if (!want.length || want.includes('1')) await scenario1();
  if (!want.length || want.includes('2')) await scenario2();
  if (!want.length || want.includes('3')) await scenario3();
} catch (e) {
  log('FAILED:', (e as Error).message);
  failed = true;
}
log(failed ? 'finished WITH FAILURES' : 'finished all passed');
finishWorkFolder(root, failed, log);
setTimeout(() => process.exit(failed ? 1 : 0), 500);
