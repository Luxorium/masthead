// The HTTP layer: Host and Origin checks, the local secret, shutdown and static files.
// Every server here listens on a free port picked by the system; nothing touches 7717.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import type { Client } from '../server/app.ts';
import { serve, type ServedApp } from '../server/http.ts';

const SECRET = 'a'.repeat(64);
const dir = mkdtempSync(join(tmpdir(), 'masthead-http-'));
const web = join(dir, 'web');
mkdirSync(join(web, 'assets'), { recursive: true });
mkdirSync(join(dir, 'web2'));
writeFileSync(join(web, 'index.html'), '<!doctype html><title>page</title>');
writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
writeFileSync(join(dir, 'web2', 'secret.txt'), 'SIBLING-SECRET');
writeFileSync(join(dir, 'outside.txt'), 'OUTSIDE-SECRET');

const connected: Client[] = [];
const handled: unknown[] = [];
const app: ServedApp = {
  connect: (c) => void connected.push(c),
  disconnect: () => {},
  handle: (_c, raw) => void handled.push(raw),
  workingCount: () => 2,
};
let shutdowns = 0;
let port = 0;
let server: Awaited<ReturnType<typeof serve>>;

before(async () => {
  server = await serve(app, { port: 0, webDir: web, secret: SECRET, onShutdown: () => shutdowns++ });
  port = (server.address() as AddressInfo).port;
  assert.notEqual(port, 7717);
});
after(() => {
  server.closeAllConnections();
  server.close();
});

function get(path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Opens a socket and says whether the server accepted it (and which subprotocol it named), or the refusal status. */
function upgrade(opts: { origin?: string; host?: string; protocols?: string[]; path?: string }): Promise<{ ok: boolean; status?: number; protocol?: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (opts.origin) headers.origin = opts.origin;
    if (opts.host) headers.host = opts.host;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? '/ws'}`, opts.protocols ?? [], { headers });
    ws.on('open', () => {
      const protocol = ws.protocol;
      ws.close();
      resolve({ ok: true, protocol });
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ ok: false, status: res.statusCode });
      res.resume();
    });
    ws.on('error', () => resolve({ ok: false }));
  });
}

const goodOrigin = () => `http://127.0.0.1:${port}`;
const key = (s = SECRET) => ['masthead', `key.${s}`];

test('http: a request naming another host is refused (DNS rebinding)', async () => {
  assert.equal((await get('/', { headers: { host: 'evil.example:80' } })).status, 403);
  assert.equal((await get('/api/health', { headers: { host: `attacker.test:${port}` } })).status, 403);
});

test('http: health is open and reports the number of busy conversations', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.name, 'masthead');
  assert.equal(body.busy, 2);
});

test('http: the socket needs the right Origin', async () => {
  assert.deepEqual(await upgrade({ origin: 'http://evil.example', protocols: key() }), { ok: false, status: 403 });
  assert.deepEqual(await upgrade({ protocols: key() }), { ok: false, status: 403 }, 'no Origin at all');
  assert.deepEqual(await upgrade({ origin: goodOrigin(), host: `evil.example:${port}`, protocols: key() }), { ok: false, status: 403 }, 'wrong Host');
  assert.deepEqual(await upgrade({ origin: goodOrigin(), protocols: key(), path: '/other' }), { ok: false, status: 403 }, 'wrong path');
});

test('http: the socket needs the secret', async () => {
  assert.deepEqual(await upgrade({ origin: goodOrigin() }), { ok: false, status: 403 }, 'no subprotocol');
  assert.deepEqual(await upgrade({ origin: goodOrigin(), protocols: ['masthead'] }), { ok: false, status: 403 }, 'no key');
  assert.deepEqual(await upgrade({ origin: goodOrigin(), protocols: key('b'.repeat(64)) }), { ok: false, status: 403 }, 'wrong key');
  assert.deepEqual(await upgrade({ origin: goodOrigin(), protocols: key('a') }), { ok: false, status: 403 }, 'short key');
  const before = connected.length;
  const ok = await upgrade({ origin: goodOrigin(), protocols: key() });
  assert.deepEqual(ok, { ok: true, protocol: 'masthead' }, 'accepted, and the key is never echoed');
  assert.equal(connected.length, before + 1);
  const viaLocalhost = await upgrade({ origin: `http://localhost:${port}`, host: `localhost:${port}`, protocols: key() });
  assert.equal(viaLocalhost.ok, true);
});

test('http: shutdown needs POST, the custom header and the secret', async () => {
  assert.equal((await get('/api/shutdown', { method: 'POST' })).status, 403);
  assert.equal((await get('/api/shutdown', { method: 'POST', headers: { 'x-masthead': '1' } })).status, 403);
  assert.equal((await get('/api/shutdown', { method: 'POST', headers: { 'x-masthead-key': SECRET } })).status, 403);
  assert.equal((await get('/api/shutdown', { method: 'POST', headers: { 'x-masthead': '1', 'x-masthead-key': 'b'.repeat(64) } })).status, 403);
  assert.equal((await get('/api/shutdown', { headers: { 'x-masthead': '1', 'x-masthead-key': SECRET } })).status, 403, 'GET');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(shutdowns, 0);
  assert.equal((await get('/api/shutdown', { method: 'POST', headers: { 'x-masthead': '1', 'x-masthead-key': SECRET } })).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(shutdowns, 1);
});

test('http: the page and its assets are served to anyone, with the security headers', async () => {
  const page = await get('/?key=whatever');
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>page<\/title>/);
  assert.match(String(page.headers['content-security-policy']), /default-src 'self'/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['cache-control'], 'no-cache');
  const route = await get('/some/route');
  assert.match(route.body, /<title>page<\/title>/, 'unknown routes get the page');
  const asset = await get('/assets/app.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.body, 'console.log(1)');
  assert.match(String(asset.headers['cache-control']), /immutable/);
  assert.equal((await get('/assets/missing.js')).status, 404);
  assert.equal((await get('/assets/app.js', { method: 'HEAD' })).body, '');
  assert.equal((await get('/', { method: 'POST' })).status, 405);
});

test('http: paths cannot leave the web folder', async () => {
  const attempts = [
    '/../outside.txt',
    '/%2e%2e/outside.txt',
    '/%2e%2e%2foutside.txt',
    '/assets/%2e%2e/%2e%2e/outside.txt',
    '/..%2f..%2foutside.txt',
    '/../web2/secret.txt',
    '/%2e%2e%2fweb2%2fsecret.txt',
    `/${'..%2f'.repeat(12)}etc%2fpasswd`,
  ];
  for (const path of attempts) {
    const r = await get(path);
    assert.doesNotMatch(r.body, /SECRET|root:/, path);
    // A path that stays inside after normalising may fall back to the page itself, which is fine.
    if (r.status === 200) assert.match(r.body, /<title>page<\/title>/, path);
  }
  assert.equal((await get('/%E0%A4%A')).status, 400, 'malformed escape');
  assert.equal((await get('/a%00.js')).status, 400, 'NUL byte');
});
