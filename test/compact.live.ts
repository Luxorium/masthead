// Live: Agent.compact() on the real Claude Code (Haiku): a finished agent is resumed quietly, compacts
// its memory (Claude Code's /compact), is closed again, and still remembers. Not part of `npm test`
// (real, small usage). Run: node --import tsx test/compact.live.ts
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent, type AgentHost, type TurnOutcome } from '../server/runtime/agent.ts';
import { ClaudeBackend } from '../server/backends/claude/session.ts';
import { findClaude } from '../server/backends/claude/env.ts';
import { Scheduler } from '../server/core/scheduler.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import type { Item } from '../shared/protocol.ts';

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
let failed = false;
const check = (name: string, ok: boolean) => {
  log(ok ? `PASS ${name}` : `FAIL ${name}`);
  if (!ok) failed = true;
};
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'masthead-compact-')));
const settings = defaultSettings();
for (const p of settings.profiles) for (const t of p.tiers) t.model = 'claude-haiku-5-5';
const claude = findClaude();
const backend = new ClaudeBackend({ path: claude.path, version: claude.version });
const turns: TurnOutcome[] = [];
const items: Item[] = [];
const statuses: string[] = [];
const sched = new Scheduler(() => 4);
const host: AgentHost = {
  cwd,
  scheduler: sched,
  settings: () => settings,
  claudePath: () => claude.path,
  parentName: () => 'alpha',
  tools: () => [],
  agentChanged: (a) => void (statuses.at(-1) !== a.status && statuses.push(a.status)),
  itemChanged: (_a, i) => void items.push(i),
  draftChanged: () => {},
  rateLimit: () => {},
  askPermission: async () => ({ decision: 'deny', message: 'not in this test' }),
  turnEnded: (_a, o) => void turns.push(o),
  processLost: (_a, m) => log('LOST', m),
  backend: () => backend,
};
const wait = async (what: string, cond: () => boolean, ms = 120_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const info = {
  id: randomUUID(), convId: 'c', name: 'bravo', tier: 'sonnet', parentId: 'p', title: '', task: '', status: 'queued',
  model: 'claude-haiku-5-5', effort: 'low', createdAt: Date.now(), usage: { context: 0, contextMax: 1_000_000, output: 0, costUsd: 0, turns: 0 },
} as never;
try {
  if (!claude.path) throw new Error('Claude Code was not found');
  const a = new Agent(info, host, { owesReport: true, seed: 'Remember the word ZEBRA for later. Reply with only OK.' });
  a.start();
  await wait('first turn', () => turns.length === 1);
  a.end('done');
  await wait('process gone', () => !a.hasProcess);
  const before = a.info.usage.context;
  statuses.length = 0;
  const r = await a.compact();
  log('compact:', JSON.stringify(r), 'context', before, '->', a.info.usage.context);
  check('compaction succeeded', r.ok);
  check('it was no turn', turns.length === 1);
  check('the status stayed done', a.status === 'done' && !statuses.includes('running'));
  check('the summary notice appeared', items.some((i) => i.kind === 'notice' && /summarized/.test((i as { text: string }).text)));
  await wait('closed again', () => !a.hasProcess, 30_000);
  check('its slot was given back', sched.running('sonnet') === 0);
  a.deliver('What word did I ask you to remember? Reply with only that word.');
  await wait('second turn', () => turns.length === 2);
  check('it still remembers after compaction', /ZEBRA/i.test(turns[1]!.text));
  a.end('done');
} catch (e) {
  log('FAILED:', (e as Error).message);
  failed = true;
}
log(failed ? 'finished WITH FAILURES' : 'finished all passed', '- work folder:', cwd);
setTimeout(() => process.exit(failed ? 1 : 0), 1500);
