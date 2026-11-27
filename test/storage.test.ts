// Storage format 2: migration of 0.1 files, paged transcript reads, the blob store and its HTTP routes.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { request, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// NTFS has no POSIX modes; file privacy there is checked by the Windows-specific code paths.
const POSIX = process.platform !== 'win32';
import { BlobError, BlobStore, MAX_BLOB_BYTES, blobsOf } from '../server/storage/blobs.ts';
import { sniffImage } from '../server/storage/images.ts';
import { FORMAT, migrateConversation } from '../server/storage/migrate.ts';
import { Store } from '../server/storage/store.ts';
import { readPage } from '../server/storage/transcript.ts';
import { BlobTokens, handleBlobGet, handleBlobPost } from '../server/transport/blobs.ts';

const tmp = (p = 'masthead-storage-') => mkdtempSync(join(tmpdir(), p));

// ---- tiny valid images, built by hand ----
function png(w: number, h: number, extra = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return Buffer.concat([b, extra]);
}
function gif(w: number, h: number, extra = ''): Buffer {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return Buffer.concat([b, Buffer.from(extra)]);
}
function jpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function webpX(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

test('images: the type and size come from the bytes', () => {
  assert.deepEqual(sniffImage(png(640, 480)), { mediaType: 'image/png', w: 640, h: 480 });
  assert.deepEqual(sniffImage(gif(3, 2)), { mediaType: 'image/gif', w: 3, h: 2 });
  assert.deepEqual(sniffImage(jpeg(800, 600)), { mediaType: 'image/jpeg', w: 800, h: 600 });
  assert.deepEqual(sniffImage(webpX(100, 50)), { mediaType: 'image/webp', w: 100, h: 50 });
  for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), Buffer.from('<html><script>x</script>'), Buffer.from('GIF8'), Buffer.alloc(0), png(0, 10), Buffer.from([0xff, 0xd8, 0xff])]) {
    assert.equal(sniffImage(bad), null, bad.subarray(0, 12).toString());
  }
});

test('blobs: stored once by hash, 0600, type from the bytes; mislabelled, polyglot and over-size files refused', () => {
  const root = tmp();
  const blobs = new BlobStore(root);
  const ref = blobs.put('conv-1', png(10, 10));
  assert.match(ref.blob, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...ref, blob: 'x' }, { blob: 'x', mediaType: 'image/png', w: 10, h: 10, bytes: 33 });
  const again = blobs.put('conv-1', png(10, 10), 'image/png');
  assert.equal(again.blob, ref.blob);
  const dir = join(root, 'conv-1', 'blobs');
  assert.deepEqual(readdirSync(dir), [`${ref.blob}.png`]);
  if (POSIX) assert.equal(statSync(join(dir, `${ref.blob}.png`)).mode & 0o777, 0o600);
  if (POSIX) assert.equal(statSync(dir).mode & 0o777, 0o700);
  // A JPEG sent as PNG.
  assert.throws(() => blobs.put('conv-1', jpeg(2, 2), 'image/png'), (e: BlobError) => e.code === 'invalid');
  // SVG, with or without a claimed image type.
  assert.throws(() => blobs.put('conv-1', Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml'), (e: BlobError) => e.code === 'invalid');
  // A GIF header with HTML after it is stored as a GIF and served as image/gif with nosniff (never as HTML).
  const poly = blobs.put('conv-1', gif(1, 1, '<html><script>alert(1)</script></html>'));
  assert.equal(poly.mediaType, 'image/gif');
  assert.throws(() => blobs.put('conv-1', png(10, 10, Buffer.alloc(MAX_BLOB_BYTES))), (e: BlobError) => e.code === 'too_large');
  assert.throws(() => blobs.put('conv-1', png(9000, 10)), (e: BlobError) => e.code === 'too_large');
  assert.throws(() => blobs.put('conv-1', png(7000, 7000)), (e: BlobError) => e.code === 'too_large', 'over 40 megapixels');
  assert.throws(() => blobs.put('conv-1', Buffer.alloc(0)), (e: BlobError) => e.code === 'invalid');
  assert.throws(() => blobs.put('../x', png(1, 1)), (e: BlobError) => e.code === 'invalid');
});

test('blobs: lookups refuse path tricks; garbage collection keeps only referenced blobs', () => {
  const root = tmp();
  const blobs = new BlobStore(root);
  const a = blobs.put('c', png(1, 1));
  const b = blobs.put('c', gif(1, 1));
  writeFileSync(join(root, 'secret.txt'), 'secret');
  assert.ok(blobs.find('c', a.blob));
  for (const [conv, hash] of [['c', '../secret'], ['c', `${a.blob}.png`], ['..', a.blob], ['c', a.blob.toUpperCase()], ['c', a.blob.slice(1)], ['c/..', a.blob]]) {
    assert.equal(blobs.find(conv!, hash!), null, `${conv} ${hash}`);
  }
  assert.ok(blobs.total('c') > 0);
  assert.equal(blobs.collect('c', [a.blob]), 1);
  assert.ok(blobs.find('c', a.blob));
  assert.equal(blobs.find('c', b.blob), null);
  assert.deepEqual(blobsOf({ kind: 'user', images: [a, { blob: '../x' }, 3] }), [a.blob]);
  assert.deepEqual(blobsOf({ kind: 'user', images: 2 }), [], 'a 0.1 count, not refs');
});

test('migration: the 0.1 fixtures load as format 2, back up once, and re-save in the new format', () => {
  const data = tmp();
  const root = join(data, 'conversations');
  cpSync(join(import.meta.dirname, 'fixtures', 'v0.1', 'conversations'), root, { recursive: true });
  const original = readFileSync(join(root, 'conv-a', 'conversation.json'), 'utf8');
  const store = new Store(root);
  assert.equal(readFileSync(join(data, 'format'), 'utf8').trim(), String(FORMAT));
  const all = store.loadAll().sort((x, y) => x.meta.id.localeCompare(y.meta.id));
  assert.deepEqual(all.map((c) => [c.meta.id, c.format]), [['conv-a', 2], ['conv-old', 2]]);
  const before = JSON.parse(original);
  assert.deepEqual({ ...all[0], format: undefined }, { ...before, format: undefined }, 'nothing else changes');
  store.saveConversation(all[0]!);
  assert.equal(readFileSync(join(root, 'conv-a', 'conversation.json.v1.bak'), 'utf8'), original, 'the 0.1 file is kept');
  assert.equal(JSON.parse(readFileSync(join(root, 'conv-a', 'conversation.json'), 'utf8')).format, 2);
  store.saveConversation({ ...all[0]!, meta: { ...all[0]!.meta, title: 'Renamed' } });
  assert.equal(readFileSync(join(root, 'conv-a', 'conversation.json.v1.bak'), 'utf8'), original, 'the backup is written once');
  assert.equal(new Store(root).loadAll().find((c) => c.meta.id === 'conv-a')?.meta.title, 'Renamed');
  assert.equal(existsSync(join(root, 'conv-old', 'conversation.json.v1.bak')), false, 'only rewritten files get a backup');
  // The 0.1 transcript reads the same.
  assert.deepEqual(store.loadItems('conv-a', 'lead-a').map((i) => i.id), ['i1', 't1', 'i2']);
});

test('migration: a newer format is left alone; format 1 becomes 2', () => {
  assert.equal(migrateConversation({ format: 3 }), null);
  assert.deepEqual(migrateConversation({ meta: 1 } as never), { value: { meta: 1, format: 2 }, from: 1 });
  assert.deepEqual(migrateConversation({ format: 2 }), { value: { format: 2 }, from: 2 });
  const root = join(tmp(), 'conversations');
  mkdirSync(join(root, 'c3'), { recursive: true });
  writeFileSync(join(root, 'c3', 'conversation.json'), JSON.stringify({ format: 9, meta: { id: 'c3' }, agents: [] }));
  assert.equal(new Store(root).loadAll().length, 0);
});

function transcript(lines: object[]): string {
  const file = join(tmp(), 't.jsonl');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('transcript: pages newest first, in order, with updates resolved and torn lines skipped', () => {
  const file = transcript([
    { id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }, { id: 'b', v: 2 }, { id: 'd', v: 1 }, { id: 'e', v: 1 },
  ]);
  writeFileSync(file, readFileSync(file, 'utf8') + '{"id":"torn');
  const p1 = readPage<{ id: string; v: number }>(file, { limit: 2 });
  assert.deepEqual(p1.items.map((i) => i.id), ['d', 'e']);
  assert.equal(p1.more, true);
  const p2 = readPage<{ id: string; v: number }>(file, { before: p1.cursor, limit: 2 });
  assert.deepEqual(p2.items, [{ id: 'b', v: 2 }, { id: 'c', v: 1 }], 'b keeps its newest version and its first position');
  const p3 = readPage<{ id: string; v: number }>(file, { before: p2.cursor, limit: 2 });
  assert.deepEqual(p3.items.map((i) => i.id), ['a']);
  assert.equal(p3.more, false);
  assert.equal(p3.cursor, null);
  assert.deepEqual(readPage(join(tmp(), 'missing.jsonl'), { limit: 5 }), { items: [], cursor: null, more: false });
});

test('transcript: a long file is paged across chunk boundaries without losing or repeating items', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => ({ id: `i${i}`, text: 'é'.repeat(i % 97) + 'x'.repeat(50) }));
  const file = transcript(lines);
  const seen: string[] = [];
  let before: number | null | undefined;
  let pages = 0;
  do {
    const p = readPage<{ id: string }>(file, { before, limit: 250 });
    seen.unshift(...p.items.map((i) => i.id));
    before = p.cursor;
    pages++;
    if (!p.more) break;
  } while (pages < 100);
  assert.equal(pages, 12);
  assert.deepEqual(seen, lines.map((l) => l.id));
});

test('store: readItems pages a stored transcript; delete removes images too', () => {
  const root = join(tmp(), 'conversations');
  const store = new Store(root);
  store.saveConversation({ meta: { id: 'c', title: 't', cwd: '/', createdAt: 1, updatedAt: 1, leadId: 'l' }, agents: [] });
  for (let i = 0; i < 5; i++) store.appendItem('c', 'l', { id: `i${i}`, ts: i, kind: 'text', text: String(i) } as never);
  const ref = store.blobs.put('c', png(1, 1));
  store.appendItem('c', 'l', { id: 'u', ts: 9, kind: 'user', text: 'see', images: [ref] } as never);
  store.blobs.put('c', gif(1, 1));
  assert.deepEqual(store.readItems('c', 'l', { limit: 2 }).items.map((i) => i.id), ['i4', 'u']);
  assert.deepEqual([...store.referencedBlobs('c')], [ref.blob]);
  assert.equal(store.collectBlobs('c'), 1, 'the unreferenced GIF goes');
  assert.ok(store.blobs.find('c', ref.blob));
  store.deleteConversation('c');
  assert.equal(existsSync(join(root, 'c')), false);
});

// ---- HTTP routes ----
async function withServer(blobs: BlobStore, tokens: BlobTokens, authorised: boolean, fn: (port: number) => Promise<void>) {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (handleBlobGet(req, res, url, { blobs, tokens })) return;
    if (handleBlobPost(req, res, url, { blobs, authorised, convExists: (id) => id === 'c' })) return;
    res.writeHead(418).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    server.close();
  }
}

function call(port: number, path: string, opts: { method?: string; body?: Buffer; type?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.type ? { 'content-type': opts.type } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

test('routes: upload checks the caller, the conversation, the type and the size', async () => {
  const blobs = new BlobStore(tmp());
  const tokens = new BlobTokens();
  await withServer(blobs, tokens, false, async (port) => {
    assert.equal((await call(port, '/blob?conv=c', { method: 'POST', body: png(2, 2) })).status, 403);
  });
  await withServer(blobs, tokens, true, async (port) => {
    const ok = await call(port, '/blob?conv=c', { method: 'POST', body: png(2, 2), type: 'image/png' });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body.toString()).mediaType, 'image/png');
    assert.equal((await call(port, '/blob?conv=other', { method: 'POST', body: png(2, 2) })).status, 404);
    assert.equal((await call(port, '/blob?conv=../c', { method: 'POST', body: png(2, 2) })).status, 404);
    const mislabelled = await call(port, '/blob?conv=c', { method: 'POST', body: jpeg(2, 2), type: 'image/png' });
    assert.equal(mislabelled.status, 400);
    assert.equal(JSON.parse(mislabelled.body.toString()).code, 'invalid');
    assert.equal((await call(port, '/blob?conv=c', { method: 'POST', body: Buffer.from('<svg/>'), type: 'image/svg+xml' })).status, 400);
    const big = await call(port, '/blob?conv=c', { method: 'POST', body: png(2, 2, Buffer.alloc(MAX_BLOB_BYTES)) });
    assert.equal(big.status, 413);
    assert.equal(JSON.parse(big.body.toString()).code, 'too_large');
    assert.equal((await call(port, '/blob?conv=c')).status, 405);
  });
});

test('routes: fetch needs a live token and serves only stored blobs, with safe headers', async () => {
  let clock = 0;
  const blobs = new BlobStore(tmp());
  const tokens = new BlobTokens(() => clock);
  const ref = blobs.put('c', gif(1, 1, '<html><script>alert(1)</script>'));
  const token = tokens.issue();
  await withServer(blobs, tokens, true, async (port) => {
    const ok = await call(port, `/blob/c/${ref.blob}?t=${token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/gif');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.match(String(ok.headers['content-security-policy']), /default-src 'none'.*sandbox/);
    assert.equal(ok.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.equal(ok.body.length, ref.bytes);
    assert.equal((await call(port, `/blob/c/${ref.blob}`)).status, 403, 'no token');
    assert.equal((await call(port, `/blob/c/${ref.blob}?t=wrong`)).status, 403);
    for (const path of [`/blob/c/${'0'.repeat(64)}`, `/blob/c/..%2f..%2fsecret`, `/blob/../c/${ref.blob}`, `/blob/c/${ref.blob}.gif`, `/blob/x/${ref.blob}`]) {
      const r = await call(port, `${path}?t=${token}`);
      assert.ok(r.status === 404 || r.status === 418, `${path}: ${r.status}`); // 418: the URL resolved outside /blob/, so not a blob route
    }
    assert.equal((await call(port, `/blob/c/${ref.blob}?t=${token}`, { method: 'POST' })).status, 405);
    tokens.release(token);
    clock += 59_000;
    assert.equal((await call(port, `/blob/c/${ref.blob}?t=${token}`)).status, 200, 'still valid within a minute of the socket closing');
    clock += 2_000;
    assert.equal((await call(port, `/blob/c/${ref.blob}?t=${token}`)).status, 403, 'expired after that');
  });
});

test('atomic: renames retry on Windows while the target is busy, and nowhere else', async () => {
  const { renameRetry } = await import('../server/storage/atomic.ts');
  const busy = (n: number) => {
    let calls = 0;
    return { fn: () => { if (calls++ < n) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }, calls: () => calls };
  };
  const a = busy(3);
  renameRetry('x', 'y', 'win32', a.fn);
  assert.equal(a.calls(), 4);
  const b = busy(1);
  assert.throws(() => renameRetry('x', 'y', 'linux', b.fn), /busy/);
  assert.equal(b.calls(), 1);
  const c = busy(20);
  assert.throws(() => renameRetry('x', 'y', 'win32', c.fn), /busy/);
  assert.equal(c.calls(), 10);
  const d = { n: 0 };
  assert.throws(() => renameRetry('x', 'y', 'win32', () => { d.n++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }), /gone/);
  assert.equal(d.n, 1, 'other errors are not retried');
});
