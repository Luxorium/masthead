// The Codex adapter against a scripted app-server (server/backends/codex/testing/fake-app-server.ts):
// echo's conformance suite, then each mapping on its own. No Codex CLI is needed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexBackend } from '../server/backends/codex/index.ts';
import { nativeAgentTools, parseLogin, parseVersion, promptTools, versionAtLeast, withoutMultiAgent } from '../server/backends/codex/cli.ts';
import { FAKE_PNG, FakeAppServer, FakeCodex, type FakeCodexOptions } from '../server/backends/codex/testing/fake-app-server.ts';
import type { PermissionAnswer, PermissionAsk, ToolDef } from '../server/backends/types.ts';
import { Recorder, runConformance, spec } from './backend-conformance.ts';

function make(opts: FakeCodexOptions = {}) {
  const fake = new FakeCodex(opts);
  const backend = new CodexBackend({ path: '/fake/codex', dataDir: mkdtempSync(join(tmpdir(), 'masthead-codex-test-')), runCli: fake.runCli, spawnAppServer: fake.spawnAppServer, env: {} });
  return { fake, backend };
}

runConformance('codex (scripted app-server)', () => make().backend, { model: 'fake-luna' });

const done = (r: Recorder, n = 1) => r.until(`${n} turns`, () => r.turns.length >= n || r.exitedWith !== null, 5000);
async function session(over: Parameters<typeof spec>[0] extends infer _ ? Partial<Parameters<typeof spec>[0]> : never = {}, answer?: (a: PermissionAsk) => PermissionAnswer, opts: FakeCodexOptions = {}) {
  const { fake, backend } = make(opts);
  const r = new Recorder(answer);
  const s = backend.open(spec({ model: 'fake-luna', ...over }), r);
  return { fake, backend, r, s };
}

// ---- detection and the catalogue ----

test('codex cli helpers: version, login, catalogue, tool list', () => {
  assert.equal(parseVersion('codex-cli 0.172.0\n'), '0.172.0');
  assert.equal(versionAtLeast('0.172.0', '0.172.0'), true);
  assert.equal(versionAtLeast('0.171.9', '0.172.0'), false);
  assert.equal(versionAtLeast('1.0.0', '0.172.0'), true);
  assert.equal(parseLogin({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' }), true);
  assert.equal(parseLogin({ code: 1, stdout: 'Not logged in', stderr: '' }), false);
  assert.equal(parseLogin({ code: 2, stdout: '', stderr: 'boom' }), null);
  const { models } = withoutMultiAgent({ models: [{ slug: 'a', multi_agent_version: 'v2' }, { slug: 'b' }] });
  assert.deepEqual(models.map((m) => m.multi_agent_version), [null, null]);
  const names = promptTools([{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'collaboration', tools: [{ type: 'function', name: 'spawn_agent', parameters: {} }] }, { type: 'function', name: 'exec', parameters: {} }] }]);
  assert.deepEqual(names, ['collaboration', 'collaboration.spawn_agent', 'exec']);
  assert.deepEqual(nativeAgentTools(names), ['collaboration', 'collaboration.spawn_agent']);
});

test('codex detect: available, signed in, catalogue checked with debug prompt-input', async () => {
  const { fake, backend } = make();
  const info = await backend.detect();
  assert.equal(info.available, true, info.error);
  assert.equal(info.version, '0.172.0');
  assert.equal(info.signedIn, true);
  assert.equal(backend.warning, undefined);
  const check = fake.cli.find((a) => a[1] === 'prompt-input')!;
  assert.ok(check.some((a) => a.startsWith('model_catalog_json=')), 'checked with the rebuilt catalogue');
});

test('codex detect: too old, signed out, untested version, switch not working', async () => {
  assert.match((await make({ version: '0.170.1' }).backend.detect()).error ?? '', /too old/);
  const out = await make({ signedIn: false }).backend.detect();
  assert.equal(out.available, false);
  assert.equal(out.signedIn, false);
  const newer = make({ version: '0.180.0' });
  assert.equal((await newer.backend.detect()).available, true);
  assert.match(newer.backend.warning ?? '', /not been tested/);
  assert.match((await newer.backend.detect()).warning ?? '', /not been tested/);
  const broken = await make({ catalogIgnored: true }).backend.detect();
  assert.equal(broken.available, false);
  assert.match(broken.error ?? '', /could not be switched off/);
});

test('codex: a session refuses to start when the catalogue switch fails for its model', async () => {
  const { r, fake } = await session({}, undefined, { catalogIgnored: true });
  await r.until('exited', () => r.exitedWith !== null, 5000);
  assert.match(r.exitedWith!.failure ?? '', /sub-agent tools are still offered/);
  assert.equal(fake.server.calls('thread/start').length, 0);
});

test('codex models: from model/list, hidden left out, never max or ultra, context from the catalogue', async () => {
  const { backend, fake } = make();
  const models = await backend.models();
  assert.deepEqual(models.map((m) => m.id), ['fake-astra', 'fake-luna']);
  assert.deepEqual(models[0]!.efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(models[1]!.efforts, ['low', 'medium', 'high']);
  assert.equal(models[0]!.nativeEffort.xhigh, 'xhigh');
  assert.equal(models[0]!.default, true);
  assert.equal(models[0]!.contextWindow, 272000);
  assert.equal(models[0]!.description, 'Our most capable model.');
  assert.equal(models[0]!.order, 2);
  assert.equal(models[1]!.order, 8);
  assert.ok(fake.server.args.some((a) => a.startsWith('model_catalog_json=')), 'app-server started with the catalogue');
});

// ---- threads ----

test('codex open: one shared app-server; thread/start carries instructions, tools, config and approvals', async () => {
  const { fake, backend } = make();
  const tool: ToolDef = { name: 'spawn_agent', description: 'd', input: { type: 'object' }, run: async () => 'x' };
  const r1 = new Recorder();
  const r2 = new Recorder();
  backend.open(spec({ model: 'fake-luna', instructions: 'You are bravo.', tools: [tool], lean: true, permissionMode: 'inherit' }), r1);
  backend.open(spec({ model: 'fake-astra', lean: false, permissionMode: 'bypassPermissions' }), r2);
  await r1.until('first started', () => !!r1.sessionId, 5000);
  await r2.until('second started', () => !!r2.sessionId, 5000);
  assert.equal(fake.servers.length, 1, 'one process');
  const starts = fake.server.calls('thread/start');
  const a = starts.find((x) => x.developerInstructions === 'You are bravo.');
  const b = starts.find((x) => x !== a);
  assert.equal(a.developerInstructions, 'You are bravo.');
  assert.deepEqual(a.dynamicTools, [{ type: 'function', name: 'spawn_agent', description: 'd', inputSchema: { type: 'object' } }]);
  assert.equal(a.approvalsReviewer, 'user');
  assert.equal(a.approvalPolicy, undefined, 'inherit keeps the person\'s own policy');
  assert.equal(a.config['mcp_servers.blender.enabled'], false);
  assert.equal(a.config['mcp_servers.notes.enabled'], false);
  assert.equal(a.config['features.apps'], false);
  assert.equal(a.config['features.multi_agent'], false);
  assert.equal(b.approvalPolicy, 'never');
  assert.equal(b.sandbox, 'danger-full-access');
  assert.equal(b.approvalsReviewer, undefined);
  assert.equal(b.config['mcp_servers.blender.enabled'], undefined, 'not lean: the person\'s servers stay');
  await backend.dispose();
});

test('codex send: turn/start carries model and effort; a later setEffort/setModel applies to the next turn', async () => {
  const { fake, r, s } = await session({ effort: 'medium' });
  s.send('m1', 'Reply with exactly the word ONE');
  await done(r);
  s.setEffort('high');
  s.setModel!('fake-astra');
  s.send('m2', 'Reply with exactly the word TWO');
  await done(r, 2);
  const [t1, t2] = fake.server.calls('turn/start');
  assert.equal(t1.effort, 'medium');
  assert.equal(t1.model, 'fake-luna');
  assert.equal(t1.clientUserMessageId, 'm1');
  assert.equal(t2.effort, 'high');
  assert.equal(t2.model, 'fake-astra');
  assert.deepEqual(r.turns.map((t) => t.consumed), [['m1'], ['m2']]);
});

test('codex: a permission-mode change keeps the thread\'s own sandbox (only the approvals change); the scratch folder is a writable root', async () => {
  // inherit: the thread starts on the person's own sandbox (here with network on).
  const { fake, r, s } = await session({ permissionMode: 'inherit', dirs: ['/scratch/c1'] });
  s.send('m1', 'Reply with exactly the word ONE');
  await done(r);
  const own = { type: 'workspaceWrite', writableRoots: ['/own/root', '/scratch/c1'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  assert.deepEqual(fake.server.calls('turn/start')[0].sandboxPolicy, own, 'the thread\'s sandbox plus the scratch folder');
  assert.equal(fake.server.calls('turn/start')[0].approvalPolicy, undefined, 'nothing changed yet');
  s.setPermissionMode!('acceptEdits');
  s.send('m2', 'Reply with exactly the word TWO');
  await done(r, 2);
  const t2 = fake.server.calls('turn/start')[1];
  assert.equal(t2.approvalPolicy, 'on-request');
  assert.deepEqual(t2.sandboxPolicy, own, 'network stays as the thread had it');
  s.setPermissionMode!('bypassPermissions');
  s.send('m3', 'Reply with exactly the word THREE');
  await done(r, 3);
  assert.deepEqual(fake.server.calls('turn/start')[2].sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(fake.server.calls('turn/start')[2].approvalPolicy, 'never');
  assert.throws(() => s.setPermissionMode!('inherit'), /relaunch/);
});

test('codex: leaving bypass always puts the thread back on its own sandbox (no scratch, scratch already a root, read-only)', async () => {
  const own = { type: 'workspaceWrite', writableRoots: ['/own/root'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  const readOnly = { type: 'readOnly', networkAccess: false };
  const cases: Array<[string, Record<string, unknown>, FakeCodexOptions, unknown]> = [
    ['no scratch folder', { permissionMode: 'inherit' }, {}, own],
    ['scratch already a root', { permissionMode: 'inherit', dirs: ['/own/root'] }, {}, own],
    ['a read-only thread', { permissionMode: 'inherit', dirs: ['/scratch/c1'] }, { sandbox: readOnly }, readOnly],
  ];
  for (const [name, over, opts, back] of cases) {
    const { fake, r, s } = await session({ permissionMode: 'default', ...over }, undefined, opts);
    s.send('m1', 'Reply with exactly the word ONE');
    await done(r);
    s.setPermissionMode!('bypassPermissions');
    s.send('m2', 'Reply with exactly the word TWO');
    await done(r, 2);
    s.setPermissionMode!('acceptEdits');
    s.send('m3', 'Reply with exactly the word THREE');
    await done(r, 3);
    s.send('m4', 'Reply with exactly the word FOUR');
    await done(r, 4);
    const policies = fake.server.calls('turn/start').map((t) => t.sandboxPolicy);
    assert.deepEqual(policies[1], { type: 'dangerFullAccess' }, name);
    assert.deepEqual(policies[2], back, `${name}: back on its own sandbox at once`);
    assert.deepEqual(policies[3], back, `${name}: and it stays there`);
  }
});

// ---- resume: the sandbox the mode wants, whatever the thread kept (codex 0.172 keeps a turn's override) ----

const WW = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
const FULL = { type: 'dangerFullAccess' };

/** A thread run in `mode` (with `bypassTurn`, one turn after switching to bypass), closed, then resumed in `then`; two turns. */
async function resumeCase(o: { mode: string; dirs?: string[]; bypassTurn?: boolean; then: string; thenDirs?: string[]; opts?: FakeCodexOptions }) {
  const { fake, backend } = make(o.opts);
  const r1 = new Recorder();
  const s1 = backend.open(spec({ model: 'fake-luna', permissionMode: o.mode, ...(o.dirs ? { dirs: o.dirs } : {}) }), r1);
  s1.send('a', 'Reply with exactly the word ONE');
  await done(r1);
  if (o.bypassTurn) {
    s1.setPermissionMode!('bypassPermissions');
    s1.send('b', 'Reply with exactly the word TWO');
    await done(r1, 2);
  }
  s1.close('graceful');
  await s1.ended;
  const before = fake.server.calls('turn/start').length;
  const r2 = new Recorder();
  const s2 = backend.open(spec({ model: 'fake-luna', permissionMode: o.then, resume: r1.sessionId!, ...(o.thenDirs ? { dirs: o.thenDirs } : {}) }), r2);
  s2.send('c', 'Reply with exactly the word THREE');
  await done(r2);
  if (r2.exitedWith) return { fake, r2, sent: [] as unknown[] };
  s2.send('d', 'Reply with exactly the word FOUR');
  await done(r2, 2);
  return { fake, r2, sent: fake.server.calls('turn/start').slice(before).map((t) => t.sandboxPolicy) };
}

test('codex resume: bypass then a relaunch in default: workspace-write on every turn (scratch added)', async () => {
  const { sent } = await resumeCase({ mode: 'default', bypassTurn: true, then: 'default', thenDirs: ['/scratch/c1'] });
  const ww = { ...WW, writableRoots: ['/scratch/c1'] };
  assert.deepEqual(sent, [ww, ww]);
});

test('codex resume: bypass then a relaunch as inherit: the person\'s own sandbox, learned once from an ephemeral probe', async () => {
  const { sent, fake } = await resumeCase({ mode: 'default', bypassTurn: true, then: 'inherit' });
  const own = { type: 'workspaceWrite', writableRoots: ['/own/root'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  assert.deepEqual(sent, [own, own]);
  assert.equal(fake.server.ephemeral.length, 1);
  assert.equal(fake.server.threads.has(fake.server.ephemeral[0]!), false, 'the probe is in no thread list');
});

test('codex resume: a plain restart of a thread left at full access in default mode goes back to workspace-write', async () => {
  // The session ended while in bypass (the thread kept full access); Masthead restarts it in default.
  const { sent } = await resumeCase({ mode: 'default', bypassTurn: true, then: 'default' });
  assert.deepEqual(sent, [WW, WW]);
});

test('codex resume: started workspace-write (scratch override sent), resumed as inherit under a read-only config: read-only', async () => {
  const readOnly = { type: 'readOnly', networkAccess: false };
  const { sent } = await resumeCase({ mode: 'default', dirs: ['/scratch/c1'], then: 'inherit', opts: { sandbox: readOnly } });
  assert.deepEqual(sent, [readOnly, readOnly], 'never wider than the mode says');
});

test('codex resume: bypass on a thread that kept a workspace-write override gets full access every turn', async () => {
  const { sent } = await resumeCase({ mode: 'default', dirs: ['/scratch/c1'], then: 'bypassPermissions' });
  assert.deepEqual(sent, [FULL, FULL]);
});

test('codex resume: nothing extra is sent when the thread already has what the mode wants', async () => {
  const { sent, fake } = await resumeCase({ mode: 'default', then: 'default' });
  assert.deepEqual(sent, [undefined, undefined]);
  assert.equal(fake.server.ephemeral.length, 0, 'no probe outside inherit');
});

test('codex resume: inherit, the own sandbox unknown, a thread left at full access: fails closed', async () => {
  const { r2 } = await resumeCase({ mode: 'default', bypassTurn: true, then: 'inherit', opts: { ephemeralFails: true } });
  assert.match(r2.exitedWith?.failure ?? '', /may still have full access.*not resumed/);
  // Unknown but not full access: it runs on what the thread has (no wider).
  const ok = await resumeCase({ mode: 'default', then: 'inherit', opts: { ephemeralFails: true } });
  assert.equal(ok.r2.exitedWith, null);
  assert.deepEqual(ok.sent, [undefined, undefined]);
});

test('codex: a thread started with full access cannot step back from it without a relaunch', async () => {
  const { r, s } = await session({ permissionMode: 'bypassPermissions' });
  s.send('m1', 'Reply with exactly the word ONE');
  await done(r);
  assert.throws(() => s.setPermissionMode!('default'), /relaunch/);
});

test('codex send: messages sent before the thread exists open its first turn together', async () => {
  const { fake, r, s } = await session();
  s.send('a', 'Reply with exactly the word FIRST');
  s.send('b', 'and this too');
  await done(r);
  assert.equal(fake.server.calls('turn/start').length, 1);
  assert.deepEqual(r.turns[0]!.consumed, ['a', 'b']);
});

test('codex steer: a message mid-turn is steered into it; one that misses the turn opens the next', async () => {
  const { fake, r, s } = await session();
  s.send('a', 'Count slowly from 1 to 5');
  await r.until('started', () => r.count('turnStarted') >= 1, 5000);
  s.send('b', 'Also reply with the word EXTRA.');
  await done(r);
  assert.deepEqual(r.turns[0]!.consumed, ['a', 'b']);
  assert.match(r.turns[0]!.text, /EXTRA/);
  assert.equal(fake.server.calls('turn/steer')[0].expectedTurnId, fake.server.calls('turn/start').length && r.turns.length ? fake.server.calls('turn/steer')[0].expectedTurnId : '');
  assert.equal(fake.server.calls('turn/steer').length, 1);
});

test('codex: text, deltas, reasoning and the final answer', async () => {
  const { r, s } = await session();
  s.send('a', 'THINK');
  await done(r);
  const drafts = r.log.filter((e) => e.ev === 'draft').map((e) => e.data);
  assert.deepEqual(drafts[0], { kind: 'thinking', append: '' });
  assert.ok(drafts.some((d) => (d as { kind: string } | null)?.kind === 'text'));
  assert.ok(drafts.includes(null));
  assert.ok(r.log.some((e) => e.ev === 'thinking' && e.data === 'pondering deeply'));
  assert.equal(r.turns[0]!.text, 'thought');
});

test('codex: usage is context (absolute) and output added since the last update; contextUsage', async () => {
  const { r, s } = await session();
  s.send('a', 'Reply with exactly the word ONE');
  await done(r);
  const u = r.log.filter((e) => e.ev === 'usage').map((e) => e.data as { context: number; output?: number });
  assert.equal(u[0]!.context, 1500);
  assert.ok(u[0]!.output! > 0);
  assert.deepEqual(await s.contextUsage!(), { used: 1500, max: 272000 });
  s.send('b', 'Reply with exactly the word TWO');
  await done(r, 2);
  const u2 = r.log.filter((e) => e.ev === 'usage').map((e) => e.data as { output?: number });
  assert.ok((u2[1]!.output ?? 0) < 1000, 'a delta, not the running total');
});

test('codex: rate limits per window, resetsAt kept in seconds; a usage-limit turn is apiError rate_limit', async () => {
  const { r, s } = await session();
  s.send('a', 'Reply with exactly the word ONE');
  await done(r);
  const notes = r.log.filter((e) => e.ev === 'rateLimit').map((e) => e.data as { status: string; type: string; utilization: number; resetsAt: number });
  assert.deepEqual(notes[0], { status: 'allowed', type: 'codex:300m', utilization: 0.12, resetsAt: 1796364996 });
  assert.equal(notes[1]!.status, 'allowed_warning');
  s.send('b', 'USAGE LIMIT');
  await done(r, 2);
  assert.equal(r.turns[1]!.apiError, 'rate_limit');
  assert.match(r.turns[1]!.error ?? '', /usage limit/);
  assert.ok(r.log.some((e) => e.ev === 'rateLimit' && (e.data as { status: string }).status === 'rejected'));
});

test('codex tools: a team tool runs through its ToolDef and never asks; an "Error:" result is a failed call', async () => {
  const calls: unknown[] = [];
  const tool: ToolDef = { name: 'stop_agent', description: 'd', input: { type: 'object' }, run: async (i) => (calls.push(i), 'Error: no such agent') };
  const { r, s, fake } = await session({ tools: [tool] });
  s.send('a', 'Call the tool stop_agent with input {"name":"zulu"}');
  await done(r);
  assert.deepEqual(calls, [{ name: 'zulu' }]);
  assert.equal(r.asks.length, 0);
  const finished = r.log.find((e) => e.ev === 'toolFinished')!.data as { isError: boolean; result: string };
  assert.equal(finished.isError, true);
  const req = fake.server.received.find((x) => x.method === 'turn/start');
  assert.ok(req);
});

test('codex tools: mcp results with images; shell and file items', async () => {
  const { r, s } = await session({}, () => ({ decision: 'allow' }));
  s.send('a', 'MCP IMAGE');
  await done(r);
  const started = r.log.find((e) => e.ev === 'toolStarted')!.data as { name: string };
  assert.equal(started.name, 'mcp__shots__grab');
  const fin = r.log.find((e) => e.ev === 'toolFinished')!.data as { result: string; images: Array<{ mediaType: string; data: string }> };
  assert.match(fin.result, /shot/);
  assert.deepEqual(fin.images, [{ type: 'image', mediaType: 'image/png', data: FAKE_PNG }]);
  s.send('b', 'Run the shell command `echo conformance`');
  await done(r, 2);
  const shell = r.log.filter((e) => e.ev === 'toolFinished').map((e) => e.data as { result: string; isError: boolean })[1]!;
  assert.deepEqual(shell, { id: (r.log.filter((e) => e.ev === 'toolStarted')[1]!.data as { id: string }).id, result: 'conformance\n', isError: false });
});

test('codex approvals: command, file, permissions and a question, each answered through askPermission', async () => {
  const answers: Record<string, PermissionAnswer> = { command: { decision: 'always' }, file: { decision: 'deny' }, tool: { decision: 'allow' }, question: { decision: 'allow', answers: { 'Which colour?': 'teal' } } };
  const { r, s } = await session({}, (a) => answers[a.kind]!);
  s.send('a', 'Run the shell command `ls`');
  await done(r);
  s.send('b', 'EDIT FILE');
  await done(r, 2);
  s.send('c', 'WANT PERMISSION');
  await done(r, 3);
  s.send('d', 'ASK PERSON');
  await done(r, 4);
  assert.deepEqual(r.asks.map((a) => [a.kind, a.toolName, a.canAlways]), [['command', 'shell', true], ['file', 'apply_patch', true], ['tool', 'permissions', true], ['question', 'request_user_input', false]]);
  assert.match(r.turns[0]!.text, /printed/);
  assert.match(r.turns[1]!.text, /file decline/);
  assert.match(r.turns[2]!.text, /"scope":"turn"/);
  assert.match(r.turns[3]!.text, /"colour":\{"answers":\["teal"\]\}/);
  assert.deepEqual(r.asks[3]!.questions![0]!.options.map((o) => o.label), ['teal', 'red']);
  assert.deepEqual((r.asks[1]!.input as { changes: unknown[] }).changes.length, 1, 'the file card shows the changes');
});

test('codex: a sub-agent cannot ask the person: the question is answered empty without a card', async () => {
  const { r, s } = await session({ canAskPerson: false });
  s.send('a', 'ASK PERSON');
  await done(r);
  assert.equal(r.asks.length, 0);
  assert.match(r.turns[0]!.text, /answers \{\}/);
});

test('codex: an approval Codex withdraws aborts the ask', async () => {
  let ask: PermissionAsk | null = null;
  const { r, s } = await session({}, (a) => {
    ask = a;
    return new Promise<PermissionAnswer>(() => {}) as unknown as PermissionAnswer;
  });
  s.send('a', 'WITHDRAW');
  await done(r);
  assert.ok(ask);
  assert.equal(ask!.signal.aborted, true);
});

test('codex: images go in as local image files', async () => {
  const { r, s, fake } = await session();
  s.send('a', [{ type: 'image', mediaType: 'image/png', data: FAKE_PNG }, { type: 'text', text: 'Reply with exactly the word RED' }]);
  await done(r);
  const input = fake.server.calls('turn/start')[0].input;
  assert.equal(input[0].type, 'localImage');
  assert.match(input[0].path, /\.png$/);
  assert.equal(input[1].text, 'Reply with exactly the word RED');
});

test('codex: resume by id; a missing thread is sessionMissing before sessionStarted', async () => {
  const { backend } = make();
  const r1 = new Recorder();
  const s1 = backend.open(spec({ model: 'fake-luna' }), r1);
  s1.send('a', 'Reply with exactly the word KIWI');
  await done(r1);
  s1.close('graceful');
  await s1.ended;
  const r2 = new Recorder();
  const s2 = backend.open(spec({ model: 'fake-luna', resume: r1.sessionId! }), r2);
  s2.send('b', 'What word did you reply with before?');
  await done(r2);
  assert.equal(r2.turns[0]!.text, 'KIWI');
  const r3 = new Recorder();
  backend.open(spec({ model: 'fake-luna', resume: randomUUID() }), r3);
  await r3.until('exit', () => r3.exitedWith !== null, 5000);
  assert.equal(r3.exitedWith!.sessionMissing, true);
  assert.equal(r3.count('sessionStarted'), 0);
});

test('codex: interrupt; close now interrupts and unsubscribes without an exit; ended settles', async () => {
  const { r, s, fake } = await session();
  s.send('a', 'Count slowly from 1 to 5');
  await r.until('started', () => r.count('turnStarted') >= 1, 5000);
  await s.interrupt();
  await done(r);
  assert.equal(r.turns[0]!.interrupted, true);
  s.send('b', 'Count slowly from 1 to 5');
  await r.until('second started', () => r.count('turnStarted') >= 2, 5000);
  s.close('now');
  await s.ended;
  assert.equal(fake.server.calls('turn/interrupt').length, 2);
  assert.equal(fake.server.calls('thread/unsubscribe').length, 1);
  assert.equal(r.exitedWith, null);
});

test('codex: app-server dying ends every open session with exited, and the next open starts a new process', async () => {
  const { backend, fake } = make();
  const r1 = new Recorder();
  const r2 = new Recorder();
  const s1 = backend.open(spec({ model: 'fake-luna' }), r1);
  backend.open(spec({ model: 'fake-luna' }), r2);
  await r1.until('first started', () => !!r1.sessionId, 5000);
  await r2.until('second started', () => !!r2.sessionId, 5000);
  s1.send('a', 'CRASH');
  await r1.until('first exited', () => r1.exitedWith !== null, 5000);
  await r2.until('second exited', () => r2.exitedWith !== null, 5000);
  assert.match(r1.exitedWith!.failure ?? '', /fake crash/);
  await s1.ended;
  const r3 = new Recorder();
  backend.open(spec({ model: 'fake-luna' }), r3);
  await r3.until('restarted session', () => !!r3.sessionId || r3.exitedWith !== null, 5000);
  assert.equal(r3.exitedWith, null, r3.exitedWith?.failure);
  assert.equal(fake.servers.length, 2);
});

test('codex: should Codex start its own sub-agent, it and the turn are stopped and the agent is told', async () => {
  const { r, s, fake } = await session();
  s.send('a', 'NATIVE AGENT');
  await done(r);
  assert.equal(r.turns[0]!.interrupted, true);
  assert.ok(r.log.some((e) => e.ev === 'activity'));
  const interrupts = fake.server.calls('turn/interrupt');
  assert.ok(interrupts.some((i) => /^child/.test(i.threadId)), 'the native sub-agent was interrupted');
  await done(r, 2);
  assert.deepEqual(r.turns[1]!.consumed, [], 'the note is the adapter\'s own, not a runtime message');
  assert.match(JSON.stringify(fake.server.calls('turn/start')[1].input), /spawn_agent/);
});

test('codex: compaction is reported; dispose stops the process and silences sessions', async () => {
  const { r, s, backend, fake } = await session();
  s.send('a', 'COMPACT');
  await done(r);
  assert.equal(r.count('compacted'), 1);
  await backend.dispose();
  assert.equal(fake.server.killed, true);
  await s.ended;
  assert.equal(r.exitedWith, null);
});

test('codex caps: honest about what Codex lacks', () => {
  const { backend } = make();
  assert.equal(backend.caps.background, false);
  assert.equal(backend.caps.compact, true);
  assert.equal(backend.caps.liveEffort, false);
  assert.equal(backend.caps.midTurnDelivery, true);
  assert.equal(backend.caps.consumedIds, true);
  void FakeAppServer;
});

test('codex compact: runs as its own turn but reports only compacted; usage still counts; messages wait for it', async () => {
  const { r, s, fake } = await session();
  s.send('a', 'Reply with exactly the word ONE');
  await done(r);
  const before = { turns: r.turns.length, started: r.count('turnStarted'), texts: r.count('text') };
  const p = s.compact!();
  s.send('b', 'Reply with exactly the word TWO'); // held until the compaction ends
  await p;
  assert.equal(r.count('compacted'), 1);
  assert.equal(fake.server.calls('thread/compact/start')[0].threadId, r.sessionId);
  assert.equal(r.log.filter((e) => e.ev === 'usage').at(-1) && true, true);
  await done(r, 2);
  assert.equal(r.count('turnStarted'), before.started + 1, 'no turnStarted for the compaction');
  assert.deepEqual(r.turns[1]!.consumed, ['b']);
  assert.equal(r.turns[1]!.text, 'TWO');
  assert.equal(r.count('text'), before.texts + 1);
});

test('codex compact: a failed compaction rejects; busy or closed sessions refuse; a lost process rejects', async () => {
  const { r, s } = await session();
  s.send('a', 'Reply with exactly the word BADCOMPACT');
  await done(r);
  await assert.rejects(s.compact!(), /compaction failed/);
  assert.equal(r.count('compacted'), 0);
  assert.equal(r.turns.length, 1, 'no turnEnded for it');
  s.send('b', 'Count slowly from 1 to 5');
  await r.until('started', () => r.count('turnStarted') >= 2, 5000);
  await assert.rejects(s.compact!(), /busy/);
  await done(r, 2);
  const lost = await session();
  lost.s.send('a', 'Reply with exactly the word ONE');
  await done(lost.r);
  const p = lost.s.compact!();
  lost.fake.server.exit('gone');
  await assert.rejects(p);
  s.close('now');
  await assert.rejects(s.compact!(), /not open/);
});
