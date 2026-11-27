// Pictures in an existing conversation: refs from POST /blob are checked against that conversation,
// go on the person's item, and reach the backend as image content (with the fake backend).
import assert from 'node:assert/strict';
import { mkdtempSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App, type Client } from '../server/app/app.ts';
import { BackendRegistry } from '../server/backends/registry.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Store } from '../server/storage/store.ts';

function png(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const errorFor = (got: Array<Record<string, unknown>>, ref: string) => String(got.find((m) => m.t === 'error' && m.ref === ref)?.message);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mh-img-'));
  const registry = new BackendRegistry({ env: { MASTHEAD_BACKEND: 'fake', MASTHEAD_ALLOW_FAKE: '1', MASTHEAD_FAKE_STEP_MS: '1' } });
  const store = new Store(join(dir, 'c'));
  const app = new App({ store, settingsFile: join(dir, 's.json'), settings: defaultSettings(), registry });
  const got: Array<Record<string, unknown>> = [];
  const client: Client = { send: (m) => void got.push(JSON.parse(JSON.stringify(m))) };
  app.connect(client);
  const newConv = async () => {
    app.handle(client, { t: 'send', convId: null, cwd: dir, text: 'start', ref: 'r0' });
    await tick(100);
    return (got.filter((m) => m.t === 'created').at(-1) as { convId: string }).convId;
  };
  /**
   * A stored picture whose file is `size` bytes: a small PNG, then the file lengthened in place. The
   * new length is a hole (sparse file) where the file system allows, so the 30 MB cap is tested
   * without writing 30 MB (the cap reads the file's size).
   */
  const bigBlob = (convId: string, w: number, size: number) => {
    const ref = store.blobs.put(convId, png(w, 10));
    truncateSync(store.blobs.find(convId, ref.blob)!.file, Math.floor(size));
    return ref;
  };
  return { dir, app, store, client, got, registry, newConv, bigBlob };
}

test('send: an uploaded picture in an existing chat reaches the item and the backend', async () => {
  const { app, store, client, got, registry, newConv, bigBlob } = await setup();
  const convId = await newConv();
  const other = await newConv().catch(() => '');
  const ref = store.blobs.put(convId, png(4, 3));
  got.length = 0;
  app.handle(client, { t: 'send', convId, text: 'look', blobs: [ref], ref: 'r1' });
  await tick(100);
  assert.equal(got.find((m) => m.t === 'error'), undefined, JSON.stringify(got.find((m) => m.t === 'error')));
  const lead = app['conversations'].get(convId)!.lead;
  const items = store.loadItems(convId, lead.id);
  const user = items.filter((i) => i.kind === 'user').at(-1) as unknown as { images: Array<{ blob: string }> };
  assert.deepEqual(user.images.map((i) => i.blob), [ref.blob], 'the item holds the ref');
  const sessions = registry.fake!.sessions;
  const sent = JSON.stringify(sessions.flatMap((s) => s.received));
  assert.ok(sent.includes(png(4, 3).toString('base64')), 'the backend received the picture');
  // A ref from another conversation, a made-up ref, too many, too large.
  assert.notEqual(other, convId);
  if (other) {
    const foreign = store.blobs.put(other, png(5, 5));
    got.length = 0;
    app.handle(client, { t: 'send', convId, text: 'x', blobs: [foreign], ref: 'r2' });
    assert.match(errorFor(got, 'r2'), /not part of this conversation/);
  }
  got.length = 0;
  app.handle(client, { t: 'send', convId, text: 'x', blobs: [{ blob: 'f'.repeat(64) }], ref: 'r3' });
  assert.match(errorFor(got, 'r3'), /not part of this conversation/);
  app.handle(client, { t: 'send', convId, text: 'x', blobs: Array(9).fill(ref), ref: 'r4' });
  assert.match(errorFor(got, 'r4'), /At most 8 images/);
  const bigs = Array.from({ length: 7 }, (_, i) => bigBlob(convId, 10 + i, 4.9 * 1024 * 1024));
  app.handle(client, { t: 'send', convId, text: 'x', blobs: bigs, ref: 'r5' });
  assert.match(errorFor(got, 'r5'), /larger than 30 MB/);
  // A first message's inline pictures are kept on its item too (no longer collected at the next start).
  app.shutdown();
});

test('send: a first message keeps its inline pictures as refs on the item', async () => {
  const { app, store, client, got, dir } = await setup();
  app.handle(client, { t: 'send', convId: null, cwd: dir, text: 'see', images: [{ mediaType: 'image/png', data: png(2, 2).toString('base64') }], ref: 'r0' });
  await tick(100);
  const convId = (got.find((m) => m.t === 'created') as { convId: string }).convId;
  const lead = app['conversations'].get(convId)!.lead;
  const user = store.loadItems(convId, lead.id).find((i) => i.kind === 'user') as unknown as { images: Array<{ blob: string }> };
  assert.equal(user.images.length, 1);
  assert.deepEqual([...store.referencedBlobs(convId)], [user.images[0]!.blob], 'referenced, so it survives the next start');
  app.shutdown();
});

test('send: uploaded and inline pictures share one 30 MB cap', async () => {
  const { app, client, got, newConv, bigBlob } = await setup();
  const convId = await newConv();
  const big = bigBlob(convId, 20, 4.9 * 1024 * 1024);
  const big2 = bigBlob(convId, 21, 4.9 * 1024 * 1024);
  const inline = Array.from({ length: 5 }, (_, i) => ({ mediaType: 'image/png', data: png(30 + i, 30, 4.5 * 1024 * 1024).toString('base64') }));
  got.length = 0;
  app.handle(client, { t: 'send', convId, text: 'x', blobs: [big, big2], images: inline, ref: 'r9' });
  assert.match(errorFor(got, 'r9'), /larger than 30 MB/);
  app.shutdown();
});
