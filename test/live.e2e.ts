// A live end-to-end run against the real Claude Code on this machine. It spends real usage, so it is
// not part of `npm test`; run it with `npm run test:live`. Every tier uses Haiku to keep it cheap.
// It works in a fresh folder under the system temp directory and leaves that folder behind.
import { existsSync, mkdtempSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInfo, Item, ServerMsg } from '../shared/protocol.ts';
import { App, type Client } from '../server/app/app.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { findClaude } from '../server/backends/claude/env.ts';
import { Store } from '../server/storage/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'masthead-live-'));
const settings = defaultSettings();
for (const t of ['lead', 'opus', 'sonnet', 'haiku'] as const) settings.tiers[t].model = 'claude-haiku-5-5';
settings.tiers.opus.max = 2;
settings.tiers.sonnet.max = 1;
settings.defaultCwd = dir;
settings.permissionMode = 'default';

const app = new App({ store: new Store(join(dir, 'conversations')), claude: findClaude(), settings, settingsFile: join(dir, 'settings.json') });
const agents = new Map<string, AgentInfo>();
const items = new Map<string, Item[]>();
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
let convId = '';
/** Every effort level each agent was seen at, since an agent goes back to low when it finishes. */
const effortsSeen = new Map<string, Set<string>>();
const waiters: Array<() => void> = [];
const client: Client = {
  send(sent: ServerMsg) {
    // Copy the message as the network would, so later changes on the server cannot alter what was received.
    const m = structuredClone(sent);
    if (m.t === 'created') convId = m.convId;
    else if (m.t === 'agent') {
      const before = agents.get(m.agent.id);
      agents.set(m.agent.id, m.agent);
      const seen = effortsSeen.get(m.agent.name) ?? new Set<string>();
      seen.add(m.agent.effort);
      effortsSeen.set(m.agent.name, seen);
      if (!before || before.status !== m.agent.status || before.effort !== m.agent.effort) {
        log(`[${m.agent.name}] ${m.agent.tier} ${m.agent.status} effort=${m.agent.effort}${m.agent.error ? ' error=' + m.agent.error : ''}`);
      }
    } else if (m.t === 'item') {
      const list = items.get(m.agentId) ?? [];
      const i = list.findIndex((x) => x.id === m.item.id);
      if (i >= 0) list[i] = m.item;
      else list.push(m.item);
      items.set(m.agentId, list);
      const name = agents.get(m.agentId)?.name ?? '?';
      const it = m.item;
      if (it.kind === 'text') log(`[${name}] says: ${it.text.replace(/\s+/g, ' ').slice(0, 200)}`);
      else if (it.kind === 'tool' && !it.done) log(`[${name}] tool ${it.name.replace('mcp__masthead__', 'mh:')} ${JSON.stringify(it.input).slice(0, 160)}`);
      else if (it.kind === 'tool' && it.done && it.name.startsWith('mcp__masthead__')) log(`[${name}]   -> ${(it.result ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
      else if (it.kind === 'inbound') log(`[${name}] <${it.via} from ${it.from}> ${it.text.replace(/\s+/g, ' ').slice(0, 140)}`);
      else if (it.kind === 'notice') log(`[${name}] notice(${it.level}): ${it.text.slice(0, 200)}`);
    } else if (m.t === 'permission_request') {
      log(`PERMISSION ${m.request.agentName} ${m.request.toolName} -> allow`);
      app.handle(client, { t: 'permission', requestId: m.request.id, decision: 'allow' });
    } else if (m.t === 'error') log('ERROR', m.message);
    for (const w of waiters.splice(0)) w();
  },
};
app.connect(client);

const all = () => [...agents.values()];
const byName = (name: string) => all().find((a) => a.name === name);
const byTitle = (title: string) => all().find((a) => a.title.toLowerCase() === title);
const lead = () => all().find((a) => a.tier === 'lead');

async function until(what: string, cond: () => boolean, ms = 240_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await Promise.race([new Promise<void>((r) => waiters.push(r)), new Promise((r) => setTimeout(r, 1000))]);
  }
}
const isLive = (a: AgentInfo) => a.status === 'queued' || a.status === 'running' || a.status === 'waiting';
const settled = () => lead()?.status === 'idle' && all().every((a) => a.tier === 'lead' || !isLive(a));
const leadText = () =>
  (items.get(lead()!.id) ?? [])
    .filter((i) => i.kind === 'text')
    .map((i) => (i as { text: string }).text)
    .join('\n');
const check = (name: string, ok: boolean) => {
  log(ok ? `PASS ${name}` : `FAIL ${name}`);
  if (!ok) process.exitCode = 1;
};

try {
  log('--- 1. chain: lead -> second tier -> third tier, reports travel back up');
  app.handle(client, {
    t: 'send',
    convId: null,
    cwd: dir,
    text: 'This is a wiring test; follow it literally. Use spawn_agent to start one agent with the title "middle" and exactly this task: "Wiring test. Use spawn_agent to start an agent with the title leaf and the task: Reply with only the word PINEAPPLE. When its report arrives, reply with the word you received followed by -OK." Then end your turn. When that agent\'s report arrives, tell me exactly what it said.',
  });
  await until('conversation', () => convId !== '');
  await until('chain settles', () => agents.size >= 3 && settled());
  log('agents:', all().map((a) => `${a.name}:${a.tier}:${a.status}`).join(' '));
  check('three tiers were used', ['lead', 'opus', 'sonnet'].every((t) => all().some((a) => a.tier === t)));
  check('sub-agents finished as done', all().filter((a) => a.tier !== 'lead').every((a) => a.status === 'done'));
  check('the leaf answer reached the person', /PINEAPPLE-OK/i.test(leadText()));
  check('agents are named in order from the phonetic alphabet', lead()?.name === 'alpha' && byTitle('middle')?.name === 'bravo' && byTitle('leaf')?.name === 'charlie');

  log('--- 2. messaging a finished agent resumes it; an effort request goes to its parent');
  const before = leadText().length;
  app.handle(client, {
    t: 'send',
    convId,
    text: 'Second wiring test; follow it literally. Use send_message to tell "bravo": "Call set_effort with level medium and reason wiring-test, then end your turn. When you hear the outcome, reply with EFFORT-RECEIVED and your new level." If you receive an effort request from "bravo", approve it with set_agent_effort. When the report from "bravo" arrives, tell me what effort level "bravo" ended at.',
  });
  await until('lead starts', () => lead()?.status !== 'idle', 30_000);
  await until('second round settles', settled);
  const mid = byName('bravo');
  check('mid was resumed and finished again', mid?.status === 'done' && (mid?.usage.turns ?? 0) >= 2);
  // With automatic effort, a finished agent goes back to low, so look for the raise while it ran.
  check('mid effort was raised by its parent', effortsSeen.get('bravo')?.has('medium') === true);
  check('the lead reported back', leadText().length > before);

  log('--- 3. limits: with one slot, two agents run one after the other; stopping works');
  settings.tiers.opus.max = 1;
  app.handle(client, { t: 'settings', settings });
  app.handle(client, {
    t: 'send',
    convId,
    text: 'Third wiring test; follow it literally. In one step, use spawn_agent twice: first an agent titled "first" with the task "Run the shell command: sleep 20. Then reply DONE-1." and then an agent titled "second" with the task "Reply DONE-2." Then end your turn and wait for both reports. Finally tell me both results.',
  });
  await until('second exists', () => byTitle('second') !== undefined, 60_000);
  await until('first running', () => byTitle('first')?.status === 'running', 30_000);
  check('the second agent waits in the queue', byTitle('second')?.status === 'queued');
  log('stopping the first from the app');
  app.handle(client, { t: 'stop_agent', convId, agentId: byTitle('first')!.id });
  await until('third round settles', settled);
  check('the first was stopped', byTitle('first')?.status === 'stopped');
  check('the second ran after the slot freed', byTitle('second')?.status === 'done');
  log('--- 4. an agent with a background command still running is not finished');
  app.handle(client, {
    t: 'send',
    convId,
    text: 'Fourth wiring test; follow it literally. Use spawn_agent once: title "backgrounder", task "Wiring test. Run the shell command sleep 12 with the Bash tool using run_in_background true. Then end your turn at once without waiting. When you are notified that the command finished, reply with exactly BG-FINISHED." Then end your turn. When its report arrives, tell me exactly what it said.',
  });
  await until('backgrounder exists', () => byTitle('backgrounder') !== undefined, 60_000);
  await until('backgrounder waits on its command', () => byTitle('backgrounder')?.status === 'waiting' || !isLive(byTitle('backgrounder')!), 60_000);
  check('it is waiting, not finished, while the command runs', byTitle('backgrounder')?.status === 'waiting');
  await until('fourth round settles', settled);
  const bgReports = (items.get(lead()!.id) ?? []).filter((i) => i.kind === 'inbound' && i.via === 'report' && i.from === byTitle('backgrounder')!.name);
  check('it reported once, after the command finished', bgReports.length === 1 && /BG-FINISHED/.test((bgReports[0] as { text: string }).text));

  log('--- 5. a question with wait: true keeps the asker alive until it is answered');
  app.handle(client, {
    t: 'send',
    convId,
    text: 'Fifth wiring test; follow it literally. Use spawn_agent once: title "asker", task "Wiring test. Use send_message to your parent with wait true and the message: Which colour? Then end your turn. When the answer arrives, reply with exactly COLOUR= followed by the answer." Then end your turn. When a message from that agent asks which colour, answer it with send_message saying only: teal. When its report arrives, tell me exactly what it said.',
  });
  await until('asker exists', () => byTitle('asker') !== undefined, 60_000);
  let sawWaiting = false;
  await until('fifth round settles', () => {
    if (byTitle('asker')?.waitingFor === 'alpha') sawWaiting = true;
    return settled();
  });
  const askReports = (items.get(lead()!.id) ?? []).filter((i) => i.kind === 'inbound' && i.via === 'report' && i.from === byTitle('asker')!.name);
  check('the asker was shown as waiting for the lead', sawWaiting);
  check('its question was not taken as a report', askReports.length === 1 && /COLOUR=\s*teal/i.test((askReports[0] as { text: string }).text));
  log('--- 6. settings change, then a resume whose session file is gone: one fresh session, message answered');
  const convFile = join(dir, 'conversations', convId, 'conversation.json');
  let leadSession: string | null = null;
  await until('lead session saved', () => {
    try {
      leadSession = (JSON.parse(readFileSync(convFile, 'utf8')) as { agents: Array<{ info: AgentInfo; sessionId: string | null }> }).agents.find((a) => a.info.tier === 'lead')?.sessionId ?? null;
    } catch {
      leadSession = null;
    }
    return leadSession !== null;
  }, 30_000);
  const sessionFile = join(homedir(), '.claude', 'projects', realpathSync(dir).replace(/[^a-zA-Z0-9]/g, '-'), `${leadSession}.jsonl`);
  check('the lead session file is where Claude Code keeps it', existsSync(sessionFile));
  // Switching automatic effort off makes the lead's process restart (same session) before its next turn.
  settings.autoEffort = false;
  app.handle(client, { t: 'settings', settings });
  unlinkSync(sessionFile);
  const freshNotices = () => (items.get(lead()!.id) ?? []).filter((i) => i.kind === 'notice' && /starts fresh/.test(i.text)).length;
  app.handle(client, { t: 'send', convId, text: 'Sixth wiring test. Reply with exactly FRESH-OK.' });
  await until('lead starts', () => lead()?.status !== 'idle', 30_000);
  await until('sixth round settles', settled);
  check('the lost session was noticed once', freshNotices() === 1);
  check('the message was answered by the fresh session', /FRESH-OK/.test(leadText()));

  log('--- 7. switching automatic effort back restarts the process on the same session');
  settings.autoEffort = true;
  app.handle(client, { t: 'settings', settings });
  app.handle(client, { t: 'send', convId, text: 'Seventh wiring test. Reply with exactly SAME- followed by the word you replied with to my previous message.' });
  await until('lead starts', () => lead()?.status !== 'idle', 30_000);
  await until('seventh round settles', settled);
  check('the restarted process kept the session', /SAME-\s*FRESH-OK/.test(leadText()));
  check('no second fresh start', freshNotices() === 1);

  log('usage\n  ' + all().map((a) => `${a.name}: ctx ${a.usage.context} out ${a.usage.output} $${a.usage.costUsd.toFixed(4)} turns ${a.usage.turns}`).join('\n  '));
  check('usage was recorded', all().filter((a) => a.usage.turns > 0).every((a) => a.usage.context > 0 && a.usage.output > 0));
} catch (e) {
  log('FAILED:', (e as Error).message);
  process.exitCode = 1;
} finally {
  app.shutdown();
  await new Promise((r) => setTimeout(r, 1500));
  log('finished', process.exitCode ? 'WITH FAILURES' : 'all passed', '- work folder:', dir);
  process.exit(process.exitCode ?? 0);
}
