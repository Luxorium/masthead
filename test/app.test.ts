// App.handle: validation of browser messages, settings, approvals and folders. Everything is written
// to a temporary folder; the person's settings and conversations are never touched. No agent starts.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { App, type Client } from '../server/app/app.ts';
import { agentEnv } from '../server/backends/claude/env.ts';
import { defaultSettings, sanitizeSettings } from '../server/settings/settings.ts';
import { loadSecret, readSecret } from '../server/transport/auth.ts';
import { Store } from '../server/storage/store.ts';
import type { AgentInfo, ServerMsg, Settings } from '../shared/protocol.ts';

function setup(opts: { claudePath?: string | null; settings?: Settings; conversations?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'masthead-app-'));
  const store = new Store(join(dir, 'conversations'));
  const ids: string[] = [];
  for (let n = 0; n < (opts.conversations ?? 0); n++) {
    const id = `conv-${n}`;
    const leadId = `lead-${n}`;
    const info: AgentInfo = {
      id: leadId,
      convId: id,
      name: 'alpha',
      tier: 'lead',
      parentId: null,
      title: '',
      task: '',
      status: 'idle',
      effort: 'low',
      model: 'claude-haiku-5-5',
      createdAt: 1,
      usage: { context: 0, contextMax: 1_000_000, output: 0, costUsd: 0, turns: 0 },
    } as AgentInfo;
    store.saveConversation({ meta: { id, title: `Conversation ${n}`, cwd: dir, createdAt: 1, updatedAt: 1 + n, leadId }, agents: [{ info, sessionId: null, owesReport: false }] });
    ids.push(id);
  }
  const settingsFile = join(dir, 'settings.json');
  const settings = opts.settings ?? defaultSettings();
  const app = new App({ store, settingsFile, settings, claude: { path: opts.claudePath ?? null, version: null, error: 'no claude here' } });
  const got: ServerMsg[] = [];
  const client: Client = { send: (m) => void got.push(structuredClone(m)) };
  app.connect(client);
  const send = (msg: unknown) => {
    got.length = 0;
    app.handle(client, msg);
    return [...got];
  };
  const last = (msg: unknown) => send(msg).at(-1);
  return { dir, store, app, client, got, send, last, settingsFile, ids };
}

const errorOf = (m: ServerMsg | undefined) => (m?.t === 'error' ? m : assert.fail(`expected an error, got ${JSON.stringify(m)}`));

test('app: malformed messages are answered with an error, never thrown', () => {
  const { last } = setup();
  for (const raw of [null, undefined, 42, 'text', [], {}, { t: 7 }]) assert.equal(errorOf(last(raw)).message, 'Malformed message.');
  assert.equal(errorOf(last({ t: 'nope' })).message, 'Unknown request.');
  assert.match(errorOf(last({ t: 'open', convId: 'missing' })).message, /no longer exists/);
  assert.match(errorOf(last({ t: 'open', convId: { x: 1 } })).message, /no longer exists/);
  assert.match(errorOf(last({ t: 'rename', convId: 5, title: 'x' })).message, /no longer exists/);
});

test('app: a refused send carries its ref', () => {
  const { last } = setup();
  const e = errorOf(last({ t: 'send', convId: null, text: '   ', ref: 'r-1' }));
  assert.equal(e.message, 'The message is empty.');
  assert.equal(e.ref, 'r-1');
  assert.equal(errorOf(last({ t: 'send', convId: null, text: 'hi', ref: 'r-2' })).ref, 'r-2', 'no Claude Code');
  assert.equal(errorOf(last({ t: 'send', convId: null, text: 'x'.repeat(400_001), ref: 'r-3' })).message, 'The message is too long.');
  assert.equal(errorOf(last({ t: 'send', convId: null, text: '' })).ref, undefined, 'no ref, none echoed');
  assert.equal(errorOf(last({ t: 'send', convId: null, text: '', ref: 'x'.repeat(200) })).ref?.length, 80, 'a long ref is clipped');
});

test('app: images are checked', () => {
  const { last } = setup();
  const img = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
  assert.match(errorOf(last({ t: 'send', convId: null, text: 'x', images: Array(9).fill(img) })).message, /At most 8 images/);
  for (const bad of [{ mediaType: 'image/svg+xml', data: 'AAAA' }, { mediaType: 'image/png', data: 'not base64!' }, { mediaType: 'image/png', data: 5 }, null]) {
    assert.equal(errorOf(last({ t: 'send', convId: null, text: 'x', images: [bad] })).message, 'Unsupported image.');
  }
  // Sizes are the decoded bytes, worked out from the base64 length.
  const ofBytes = (n: number) => ({ mediaType: 'image/png', data: 'A'.repeat(Math.ceil(n / 3) * 4) });
  assert.equal(errorOf(last({ t: 'send', convId: null, text: 'x', images: [ofBytes(5 * 1024 * 1024 + 3)] })).message, 'An image is larger than 5 MB.');
  assert.equal(errorOf(last({ t: 'send', convId: null, text: 'x', images: Array(7).fill(ofBytes(4.5 * 1024 * 1024)) })).message, 'The images together are larger than 30 MB.');
  const exact = { mediaType: 'image/png', data: 'A'.repeat((5 * 1024 * 1024 * 4) / 3 - ((5 * 1024 * 1024 * 4) / 3) % 4) };
  assert.equal(errorOf(last({ t: 'send', convId: null, text: 'x', images: [exact] })).message, 'no claude here', 'just under 5 MB passes');
  // Exactly 5 MB needs one padding character; counting it as data would make it 1 byte too large.
  const atLimit = { mediaType: 'image/png', data: 'A'.repeat(6_990_508 - 4) + 'AAA=' };
  assert.equal(errorOf(last({ t: 'send', convId: null, text: 'x', images: [atLimit] })).message, 'no claude here', 'exactly 5 MB passes');
  const overLimit = { mediaType: 'image/png', data: 'A'.repeat(6_990_512 - 4) + 'AA==' };
  assert.equal(errorOf(last({ t: 'send', convId: null, text: 'x', images: [overLimit] })).message, 'An image is larger than 5 MB.');
  // Two padding characters are two bytes: counted as one, this exactly-5 MB image would be refused.
  const twoPad = { mediaType: 'image/png', data: 'A'.repeat(6_990_510 - 2) + '==' };
  assert.equal(errorOf(last({ t: 'send', convId: null, text: 'x', images: [twoPad] })).message, 'no claude here', "'==' counts as two bytes");
  assert.equal(errorOf(last({ t: 'send', convId: null, text: 'x', images: Array(6).fill(ofBytes(5 * 1024 * 1024 - 2)) })).message, 'no claude here', 'six images just under 5 MB fit in 30 MB');
  // A valid image gets past the check and stops at the next one (no Claude Code here).
  assert.equal(errorOf(last({ t: 'send', convId: null, text: '', images: [img] })).message, 'no claude here');
});

test('app: a new conversation must start in an existing folder', () => {
  const { last, dir } = setup({ claudePath: '/nonexistent/claude' });
  assert.equal(errorOf(last({ t: 'send', convId: null, text: 'x', cwd: join(dir, 'missing') })).message, `${join(dir, 'missing')} is not a folder.`);
  writeFileSync(join(dir, 'file'), '');
  assert.match(errorOf(last({ t: 'send', convId: null, text: 'x', cwd: join(dir, 'file') })).message, /is not a folder/);
});

test('app: listing folders leaves out files and hidden folders', () => {
  const { last, dir } = setup();
  for (const d of ['b', 'a', '.hidden']) mkdirSync(join(dir, 'pick', d), { recursive: true });
  writeFileSync(join(dir, 'pick', 'file.txt'), '');
  const m = last({ t: 'dirs', path: join(dir, 'pick') });
  assert.deepEqual(m, { t: 'dirs', path: join(dir, 'pick'), parent: dir, entries: ['a', 'b'] });
  const missing = last({ t: 'dirs', path: join(dir, 'gone') });
  assert.ok(missing?.t === 'dirs' && missing.entries.length === 0 && missing.error);
  const root = last({ t: 'dirs', path: '/' });
  assert.ok(root?.t === 'dirs' && root.parent === null);
});

test('app: rename tidies the title and ignores an empty one; delete removes the conversation', () => {
  const { send, app, client, ids, store, dir } = setup({ conversations: 2 });
  const [a, b] = ids as [string, string];
  const renamed = send({ t: 'rename', convId: a, title: '  New\n\ttitle  ' + 'x'.repeat(200) });
  const list = renamed.find((m) => m.t === 'conversations');
  assert.ok(list?.t === 'conversations');
  const title = list.conversations.find((c) => c.id === a)?.title ?? '';
  assert.ok(title.startsWith('New title x') && title.length === 120);
  assert.deepEqual(send({ t: 'rename', convId: a, title: '   ' }), [], 'an empty title changes nothing');

  const deleted = send({ t: 'delete', convId: b });
  assert.ok(deleted.some((m) => m.t === 'deleted' && m.convId === b));
  assert.equal(existsSync(join(dir, 'conversations', b)), false);
  assert.deepEqual(store.loadAll().map((c) => c.meta.id), [a]);
  app.handle(client, { t: 'hello' });
  assert.match(errorOf(send({ t: 'open', convId: b }).at(-1)).message, /no longer exists/);
});

test('app: a partial settings update changes only what it names, and is saved', () => {
  const start = defaultSettings();
  start.permissionMode = 'acceptEdits';
  start.tiers.haiku.model = 'my-haiku';
  start.collapseReports = true;
  const { send, settingsFile } = setup({ settings: start });
  const out = send({ t: 'settings', settings: { tiers: { opus: { max: 1 } } } });
  const s = out.find((m) => m.t === 'settings');
  assert.ok(s?.t === 'settings');
  assert.equal(s.settings.tiers.opus.max, 1);
  assert.equal(s.settings.permissionMode, 'acceptEdits');
  assert.equal(s.settings.tiers.haiku.model, 'my-haiku');
  assert.equal(s.settings.tiers.opus.model, start.tiers.opus.model);
  assert.equal(s.settings.collapseReports, true);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), s.settings);

  const bad = send({ t: 'settings', settings: { permissionMode: 'everything', tiers: { sonnet: { max: 99, effort: 'max', model: 'bad model!' } }, collapseReports: 'yes', defaultCwd: 'relative' } });
  const s2 = bad.find((m) => m.t === 'settings');
  assert.ok(s2?.t === 'settings');
  assert.equal(s2.settings.permissionMode, 'acceptEdits', 'an unknown mode is ignored');
  assert.equal(s2.settings.tiers.sonnet.max, 12, 'clamped');
  assert.equal(s2.settings.tiers.sonnet.effort, start.tiers.sonnet.effort, 'no max effort');
  assert.equal(s2.settings.tiers.sonnet.model, start.tiers.sonnet.model);
  assert.equal(s2.settings.collapseReports, true);
  assert.equal(s2.settings.defaultCwd, start.defaultCwd);

  const flip = send({ t: 'settings', settings: { collapseReports: false } }).find((m) => m.t === 'settings');
  assert.ok(flip?.t === 'settings' && flip.settings.collapseReports === false && flip.settings.tiers.opus.max === 1);
});

test('app: settings that cannot be saved are applied and logged, not thrown', () => {
  const { dir } = setup();
  writeFileSync(join(dir, 'blocker'), '');
  // The settings file's folder is a file, so every write fails.
  const broken = new App({ store: new Store(join(dir, 'c2')), settingsFile: join(dir, 'blocker', 'settings.json'), settings: defaultSettings(), claude: { path: null, version: null } });
  const msgs: ServerMsg[] = [];
  broken.connect({ send: (m) => void msgs.push(m) });
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    broken.handle({ send: (m) => void msgs.push(m) }, { t: 'settings', settings: { autoEffort: false } });
    broken.handle({ send: (m) => void msgs.push(m) }, { t: 'settings', settings: { autoEffort: true } });
  } finally {
    console.error = orig;
  }
  assert.equal(msgs.filter((m) => m.t === 'settings').length, 2);
  assert.equal(msgs.filter((m) => m.t === 'error').length, 0);
  assert.equal(errors.length, 1, 'logged once');
});

function askFor(app: App, opts: { convId?: string; toolName?: string; suggestions?: unknown[]; input?: Record<string, unknown> } = {}) {
  const ctrl = new AbortController();
  const conv = { meta: { id: opts.convId ?? 'c1' } };
  const agent = { id: 'agent-1', name: 'bravo' };
  const result = app.askPermission(conv as never, agent as never, opts.toolName ?? 'Bash', opts.input ?? { command: 'ls' }, {
    signal: ctrl.signal,
    suggestions: opts.suggestions,
    toolUseID: 't1',
  } as never);
  return { result, ctrl };
}

test('app: approvals are listed in state, answered once, and "always" passes the suggested rules', async () => {
  const { app, send, got } = setup();
  got.length = 0;
  const rules = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }];
  const one = askFor(app, { convId: 'c1', suggestions: rules });
  const two = askFor(app, { convId: 'c2' });
  const requests = got.filter((m) => m.t === 'permission_request').map((m) => (m.t === 'permission_request' ? m.request : null)!);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.canAlways, true);
  assert.equal(requests[1]!.canAlways, false);

  const state = send({ t: 'hello' }).at(-1);
  assert.ok(state?.t === 'state');
  assert.deepEqual(state.state.pending.map((r) => r.id).sort(), requests.map((r) => r.id).sort(), 'every open request, in any conversation');

  const answered = send({ t: 'permission', requestId: requests[0]!.id, decision: 'always' });
  assert.ok(answered.some((m) => m.t === 'permission_resolved' && m.requestId === requests[0]!.id));
  const r1 = (await one.result) as Extract<PermissionResult, { behavior: 'allow' }>;
  assert.equal(r1.behavior, 'allow');
  assert.deepEqual(r1.updatedPermissions, rules);
  assert.deepEqual(send({ t: 'permission', requestId: requests[0]!.id, decision: 'deny' }), [], 'a second answer is ignored');

  send({ t: 'permission', requestId: requests[1]!.id, decision: 'always' });
  const r2 = (await two.result) as Extract<PermissionResult, { behavior: 'allow' }>;
  assert.equal(r2.behavior, 'allow');
  assert.equal(r2.updatedPermissions, undefined, '"always" without suggestions is a plain allow');

  const after = send({ t: 'hello' }).at(-1);
  assert.ok(after?.t === 'state' && after.state.pending.length === 0);
});

test('app: deny, questions and cancelled requests', async () => {
  const { app, send, got } = setup();
  got.length = 0;
  const denied = askFor(app);
  const id = (got.at(-1) as Extract<ServerMsg, { t: 'permission_request' }>).request.id;
  send({ t: 'permission', requestId: id, decision: 'deny', message: 'not now' });
  assert.deepEqual(await denied.result, { behavior: 'deny', message: 'not now' });

  got.length = 0;
  const q = askFor(app, { toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [] }] } });
  const qr = (got.at(-1) as Extract<ServerMsg, { t: 'permission_request' }>).request;
  assert.equal(qr.kind, 'question');
  send({ t: 'permission', requestId: qr.id, decision: 'allow', answers: { 'Which?': 'A', bad: 5 } });
  const res = (await q.result) as Extract<PermissionResult, { behavior: 'allow' }>;
  assert.deepEqual(res.updatedInput.answers, { 'Which?': 'A' });

  const cancelled = askFor(app);
  cancelled.ctrl.abort();
  assert.equal((await cancelled.result).behavior, 'deny');
  const own = await app.askPermission({ meta: { id: 'c' } } as never, { id: 'a', name: 'x' } as never, 'mcp__masthead__spawn_agent', {}, { signal: new AbortController().signal } as never);
  assert.equal(own.behavior, 'allow', "Masthead's own tools are not put to the person");
});

test('app: the latest usage notice of each kind is kept in state', () => {
  const { app, send, got } = setup();
  got.length = 0;
  app.rateLimit({ status: 'allowed', type: 'five_hour', utilization: 0.2 });
  app.rateLimit({ status: 'allowed_warning', type: 'five_hour', utilization: 0.9 });
  app.rateLimit({ status: 'allowed', type: 'seven_day' });
  app.rateLimit({ status: 'rejected' });
  assert.equal(got.filter((m) => m.t === 'rate_limit').length, 4, 'every notice is still broadcast');
  const state = send({ t: 'hello' }).at(-1);
  assert.ok(state?.t === 'state');
  assert.deepEqual(
    state.state.usage.map((n) => [n.type ?? '', n.status]).sort(),
    [['', 'rejected'], ['five_hour', 'allowed_warning'], ['seven_day', 'allowed']],
  );
});

test('config: agentEnv strips the enclosing session and keeps credentials', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_BRIDGE_TOKEN: 't',
      CLAUDE_EFFORT: 'high',
      ANTHROPIC_API_KEY: 'k',
      MY_SETTING: 'v',
    });
    const env = agentEnv();
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_BRIDGE_TOKEN', 'CLAUDE_EFFORT']) assert.equal(env[k], undefined, k);
    assert.equal(env.ANTHROPIC_API_KEY, 'k');
    assert.equal(env.MY_SETTING, 'v');
    assert.match(env.CLAUDE_AGENT_SDK_CLIENT_APP ?? '', /^masthead\//);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('config: the secret is created once, private, and kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'masthead-secret-'));
  const file = join(dir, 'data', 'secret');
  assert.equal(readSecret(file), null);
  const s = loadSecret(file);
  assert.match(s, /^[0-9a-f]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'data')).mode & 0o077, 0);
  assert.equal(loadSecret(file), s, 'kept across restarts');
  assert.equal(readSecret(file), s);
  writeFileSync(file, 'garbage');
  const replaced = loadSecret(file);
  assert.notEqual(replaced, s);
  assert.match(replaced, /^[0-9a-f]{64}$/);
  // A valid secret that others can read (an old copy, a restore) is made private again, not replaced.
  chmodSync(file, 0o644);
  assert.equal(loadSecret(file), replaced);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('config: maxRunMinutes is a whole number from 0 to a day, else unchanged', () => {
  const base = { ...defaultSettings(), maxRunMinutes: 30 };
  assert.equal(sanitizeSettings({ maxRunMinutes: -5 }, base).maxRunMinutes, 0);
  assert.equal(sanitizeSettings({ maxRunMinutes: 99999 }, base).maxRunMinutes, 1440);
  assert.equal(sanitizeSettings({ maxRunMinutes: 2.9 }, base).maxRunMinutes, 2);
  assert.equal(sanitizeSettings({ maxRunMinutes: '45' }, base).maxRunMinutes, 30, 'a string keeps the base value');
});
