// The server side of "Compact team": `/compact` starts it, the v2 messages reach the conversation,
// archived transcripts are served, the state is broadcast, and the roles hold.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App, type Client } from '../server/app/app.ts';
import { BackendRegistry } from '../server/backends/registry.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Store } from '../server/storage/store.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mh-compact-'));
  const store = new Store(join(dir, 'c'));
  const info = (id: string, extra = {}) => ({ id, convId: 'x', name: id, tier: id === 'l' ? 'lead' : 'opus', parentId: id === 'l' ? null : 'l', title: '', task: '', status: 'done', effort: 'low', model: 'm', createdAt: 1, usage: { context: 0, contextMax: 1, output: 0, costUsd: 0, turns: 0 }, ...extra });
  store.saveConversation({ meta: { id: 'x', title: 't', cwd: dir, createdAt: 1, updatedAt: 1, leadId: 'l' }, agents: [
    { info: { ...info('l'), status: 'idle' } as never, sessionId: null, owesReport: false },
    { info: info('b', { archived: 123 }) as never, sessionId: null, owesReport: false },
    { info: info('c') as never, sessionId: null, owesReport: false },
  ] });
  store.appendItem('x', 'b', { id: 'i1', ts: 1, kind: 'text', text: 'old work' } as never);
  store.appendItem('x', 'c', { id: 'i2', ts: 1, kind: 'text', text: 'live work' } as never);
  const registry = new BackendRegistry({ env: { MASTHEAD_BACKEND: 'fake', MASTHEAD_ALLOW_FAKE: '1', MASTHEAD_FAKE_STEP_MS: '1' } });
  const app = new App({ store, settingsFile: join(dir, 's.json'), settings: defaultSettings(), registry });
  const conv = (app as unknown as { conversations: Map<string, Record<string, (...a: unknown[]) => unknown>> }).conversations.get('x')!;
  const calls: unknown[][] = [];
  for (const m of ['startCompact', 'answerCompact', 'cancelCompact', 'restoreAgent', 'userSend', 'setAutoCompact']) conv[m] = (...a: unknown[]) => void calls.push([m, ...a]);
  const got: Array<Record<string, unknown>> = [];
  const local: Client = { send: (m) => void got.push(JSON.parse(JSON.stringify(m))) };
  app.connect(local);
  return { app, conv, calls, got, local, store };
}

test('compact: "/compact" to the main assistant starts it; anything else is chat', () => {
  const { app, calls, local } = setup();
  app.handle(local, { t: 'send', convId: 'x', text: '/compact', ref: 'a' });
  app.handle(local, { t: 'send', convId: 'x', text: '  /compact keep the API work ', ref: 'b' });
  app.handle(local, { t: 'send', convId: 'x', text: '/compacted', ref: 'c' });
  app.handle(local, { t: 'send', convId: 'x', text: '/compact', agentId: 'c', ref: 'd' });
  assert.deepEqual(calls.map((c) => [c[0], c[1]]), [
    ['startCompact', ''],
    ['startCompact', 'keep the API work'],
    ['userSend', '/compacted'],
    ['userSend', '/compact'],
  ], 'only to the main assistant, only the exact word');
  app.shutdown();
});

test('compact: answer, cancel and restore reach the conversation; archived transcripts only for archived agents', () => {
  const { app, calls, got, local } = setup();
  app.handle(local, { t: 'compact_answer', convId: 'x', id: 'k1', keep: ['bravo', 7], accept: true });
  app.handle(local, { t: 'compact_cancel', convId: 'x' });
  app.handle(local, { t: 'restore_agent', convId: 'x', agentId: 'b' });
  assert.deepEqual(calls, [['answerCompact', 'k1', ['bravo'], true], ['cancelCompact'], ['restoreAgent', 'b']]);
  got.length = 0;
  app.handle(local, { t: 'archive_items', convId: 'x', agentId: 'b' });
  assert.deepEqual((got[0] as { items: Array<{ id: string }> }).items.map((i) => i.id), ['i1']);
  app.handle(local, { t: 'archive_items', convId: 'x', agentId: 'c' });
  assert.match(String(got[1]!.message), /not archived/);
  app.handle(local, { t: 'archive_items', convId: 'x', agentId: 'b', limit: 1 });
  assert.equal((got[2] as { more: boolean }).more, false);
  app.shutdown();
});

test('compact: the state and the archived agents are broadcast on every change', () => {
  const { app, conv, got } = setup();
  (conv as unknown as { meta: { compact: unknown } }).meta.compact = { id: 'k1', phase: 'proposed', keep: [], archive: ['charlie'], note: '', pending: [], failed: [], startedAt: 1 };
  got.length = 0;
  app.compactChanged(conv as never);
  assert.deepEqual(got.map((m) => m.t), ['compact', 'archived']);
  assert.equal((got[0]!.compact as { phase: string }).phase, 'proposed');
  assert.deepEqual((got[1]!.agents as Array<{ id: string }>).map((a) => a.id), ['b']);
  assert.equal(app.readItems('x', 'c')[0]!.id, 'i2', 'readItems for the read_archive tool');
  app.shutdown();
});

test('compact: roles: approve may answer and cancel the card, read may only view archived transcripts', () => {
  const { app, calls } = setup();
  const device = (role: 'approve' | 'read') => {
    const out: Array<Record<string, unknown>> = [];
    const c: Client = { send: (m) => void out.push(m as Record<string, unknown>), role };
    app.connect(c);
    app.handle(c, { t: 'hello', protocol: 2 });
    app.handle(c, { t: 'subscribe', convId: 'x' });
    out.length = 0;
    return { c, out };
  };
  const approver = device('approve');
  app.handle(approver.c, { t: 'compact_answer', convId: 'x', id: 'k1', keep: [], accept: false });
  app.handle(approver.c, { t: 'compact_cancel', convId: 'x' });
  app.handle(approver.c, { t: 'restore_agent', convId: 'x', agentId: 'b' });
  assert.deepEqual(calls.map((c) => c[0]), ['answerCompact', 'cancelCompact']);
  assert.equal(approver.out.at(-1)!.code, 'refused', 'restoring needs the full role');
  const reader = device('read');
  app.handle(reader.c, { t: 'archive_items', convId: 'x', agentId: 'b' });
  assert.equal(reader.out[0]!.t, 'archive_items');
  app.handle(reader.c, { t: 'compact_cancel', convId: 'x' });
  assert.equal(reader.out[1]!.code, 'refused');
  app.shutdown();
});

test('compact: the per-conversation automatic switch, for local and full only; the setting passes through', () => {
  const { app, calls, local, got } = setup();
  app.handle(local, { t: 'auto_compact', convId: 'x', on: false });
  app.handle(local, { t: 'auto_compact', convId: 'x', on: 'no' });
  assert.deepEqual(calls, [['setAutoCompact', false]]);
  assert.equal(got.at(-1)!.t, 'error');
  const out: Array<Record<string, unknown>> = [];
  const approver: Client = { send: (m) => void out.push(m as Record<string, unknown>), role: 'approve' };
  app.connect(approver);
  app.handle(approver, { t: 'hello', protocol: 2 });
  app.handle(approver, { t: 'subscribe', convId: 'x' });
  out.length = 0;
  app.handle(approver, { t: 'auto_compact', convId: 'x', on: true });
  assert.equal(out[0]!.code, 'refused');
  got.length = 0;
  app.handle(local, { t: 'settings', settings: { autoCompact: false } });
  const s = got.find((m) => m.t === 'settings') as { settings: { autoCompact?: boolean } } | undefined;
  if (s && 'autoCompact' in s.settings) assert.equal(s.settings.autoCompact, false, 'the setting is merged like any other');
  app.shutdown();
});
