// The storage wiring in App: paged `items`, images stored for a conversation, unreferenced images
// collected on load. No agent starts.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App, type Client } from '../server/app/app.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Store } from '../server/storage/store.ts';

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'masthead-wiring-'));
  const store = new Store(join(dir, 'conversations'));
  const info = { id: 'l', convId: 'c', name: 'alpha', tier: 'lead', parentId: null, title: '', task: '', status: 'idle', effort: 'low', model: 'm', createdAt: 1, usage: { context: 0, contextMax: 1, output: 0, costUsd: 0, turns: 0 } };
  store.saveConversation({ meta: { id: 'c', title: 'T', cwd: dir, createdAt: 1, updatedAt: 1, leadId: 'l' }, agents: [{ info: info as never, sessionId: null, owesReport: false }] });
  return { dir, store };
}

test('wiring: items with a limit come a page at a time, newest first', () => {
  const { dir, store } = setup();
  for (let i = 0; i < 7; i++) store.appendItem('c', 'l', { id: `i${i}`, ts: i, kind: 'text', text: String(i) } as never);
  const app = new App({ store, settingsFile: join(dir, 's.json'), settings: defaultSettings(), claude: { path: null, version: null } });
  const got: unknown[] = [];
  const client: Client = { send: (m) => void got.push(m), blobToken: 'tok' };
  app.connect(client);
  assert.equal((got[0] as { state: { blobToken?: string } }).state.blobToken, 'tok', 'state carries the socket blob token');
  app.handle(client, { t: 'items', convId: 'c', agentId: 'l', limit: 3 });
  const p1 = got.at(-1) as { items: { id: string }[]; cursor: number; more: boolean };
  assert.deepEqual(p1.items.map((i) => i.id), ['i4', 'i5', 'i6']);
  assert.equal(p1.more, true);
  app.handle(client, { t: 'items', convId: 'c', agentId: 'l', limit: 3, before: p1.cursor });
  assert.deepEqual((got.at(-1) as typeof p1).items.map((i) => i.id), ['i1', 'i2', 'i3']);
  app.handle(client, { t: 'items', convId: 'c', agentId: 'l' });
  assert.equal((got.at(-1) as typeof p1).items.length, 7, 'without a limit: the whole transcript, as before');
});

test('wiring: storeImage keeps images for a conversation; unreferenced ones go at the next load', () => {
  const { dir, store } = setup();
  const app = new App({ store, settingsFile: join(dir, 's.json'), settings: defaultSettings(), claude: { path: null, version: null } });
  const kept = app.storeImage('c', png(2, 2).toString('base64'), 'image/png');
  const loose = app.storeImage('c', png(3, 3).toString('base64'), 'image/png');
  assert.ok('ref' in kept && 'ref' in loose);
  assert.deepEqual(app.storeImage('c', Buffer.from('<svg/>').toString('base64'), 'image/svg+xml'), { error: 'Only PNG, JPEG, GIF and WebP images can be stored.' });
  store.appendItem('c', 'l', { id: 'u', ts: 1, kind: 'user', text: 'x', images: [kept.ref] } as never);
  assert.ok(app.hasConversation('c'));
  new App({ store, settingsFile: join(dir, 's.json'), settings: defaultSettings(), claude: { path: null, version: null } });
  assert.ok(store.blobs.find('c', kept.ref.blob));
  assert.equal(store.blobs.find('c', loose.ref.blob), null);
});
