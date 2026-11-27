// Live, on the real Claude Code (Haiku): (1) a permission mode changed in Settings reaches a running
// session without a relaunch; (2) an agent's scratch folder is its $TMPDIR and is an allowed folder
// (reading and, with acceptEdits, writing there asks nothing). Not part of `npm test` (real, small
// usage). Run: node --import tsx test/settings.live.ts
import { mkdtempSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent, type AgentHost, type TurnOutcome } from '../server/runtime/agent.ts';
import { ClaudeBackend } from '../server/backends/claude/session.ts';
import { findClaude } from '../server/backends/claude/env.ts';
import { Scheduler } from '../server/core/scheduler.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import type { Settings } from '../shared/protocol.ts';
import { finishWorkFolder } from './workdir.ts';

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
let failed = false;
const check = (name: string, ok: boolean) => {
  log(ok ? `PASS ${name}` : `FAIL ${name}`);
  if (!ok) failed = true;
};
const base = realpathSync(mkdtempSync(join(tmpdir(), 'masthead-settings-live-')));
const cwd = join(base, 'work');
const scratch = join(base, 'scratch');
for (const d of [cwd, scratch]) (await import('node:fs')).mkdirSync(d);
let settings: Settings = { ...defaultSettings(), permissionMode: 'default' };
for (const p of settings.profiles) for (const t of p.tiers) t.model = 'claude-haiku-5-5';
const claude = findClaude();
const real = new ClaudeBackend({ path: claude.path, version: claude.version });
let opened = 0;
const backend = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
  open: (spec: never, ev: never) => (opened++, real.open(spec, ev)),
}) as ClaudeBackend;
const turns: TurnOutcome[] = [];
const asked: string[] = [];
const host: AgentHost = {
  cwd,
  scheduler: new Scheduler(() => 4),
  settings: () => settings,
  claudePath: () => claude.path,
  parentName: () => 'alpha',
  tools: () => [],
  agentChanged: () => {},
  itemChanged: () => {},
  draftChanged: () => {},
  rateLimit: () => {},
  askPermission: async (_a, ask) => {
    asked.push(`${ask.toolName} ${JSON.stringify(ask.input).slice(0, 120)}`);
    return { decision: 'allow' };
  },
  turnEnded: (_a, o) => void turns.push(o),
  processLost: (_a, m) => log('LOST', m),
  backend: () => backend,
  scratchDir: () => scratch,
};
const wait = async (what: string, cond: () => boolean, ms = 180_000) => {
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
  writeFileSync(join(scratch, 'note.txt'), 'PELICAN\n');
  const a = new Agent(info, host, { owesReport: true, seed: 'Wiring test, follow literally. Run the Bash command: echo "$TMPDIR". Reply with only its output.' });
  a.start();
  await wait('turn 1', () => turns.length === 1);
  log('turn 1:', turns[0]!.text, '| asked:', asked);
  check('$TMPDIR is the scratch folder', turns[0]!.text.includes(scratch));

  asked.length = 0;
  a.deliver(`Use the Read tool on ${join(scratch, 'note.txt')} and reply with only the word in it.`);
  await wait('turn 2', () => turns.length === 2);
  log('turn 2:', turns[1]!.text, '| asked:', asked);
  check('reading in the scratch folder asks nothing', /PELICAN/.test(turns[1]!.text) && !asked.some((x) => x.startsWith('Read')));

  asked.length = 0;
  a.deliver(`Use the Write tool to create ${join(cwd, 'one.txt')} containing ONE. Reply DONE.`);
  await wait('turn 3', () => turns.length === 3);
  log('turn 3 asked:', asked);
  check('in default mode a write asks', asked.some((x) => x.startsWith('Write')));

  settings = { ...settings, permissionMode: 'acceptEdits' };
  a.applySettings(settings);
  asked.length = 0;
  a.deliver(`Use the Write tool to create ${join(cwd, 'two.txt')} containing TWO, and then ${join(scratch, 'three.txt')} containing THREE. Reply DONE.`);
  await wait('turn 4', () => turns.length === 4);
  log('turn 4 asked:', asked);
  check('after the change to acceptEdits no write asks (cwd and scratch)', !asked.some((x) => x.startsWith('Write')));
  check('the files were written', existsSync(join(cwd, 'two.txt')) && existsSync(join(scratch, 'three.txt')));
  check('the same process (no relaunch)', opened === 1);
  a.end('done');
} catch (e) {
  log('FAILED:', (e as Error).message);
  failed = true;
}
log(failed ? 'finished WITH FAILURES' : 'finished all passed');
setTimeout(() => {
  finishWorkFolder(base, failed, log);
  process.exit(failed ? 1 : 0);
}, 1500);
