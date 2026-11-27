// Remote access wired end to end with the fake Tailscale provider: the switch and its refusals, state
// on restart, the private listener's checks, pairing over HTTP, approval from a local session, the
// device socket with its role, revoke. No real Tailscale command runs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { App, type Client } from '../server/app/app.ts';
import { RemoteAccess, operatorCommand, targetUrl, type RemoteTarget } from '../server/remote/access.ts';
import { FakeTailscale, type Identity } from '../server/remote/tailscale.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Store } from '../server/storage/store.ts';
import { chooseTarget, remoteCsp, startRemote } from '../server/transport/remote.ts';

const POSIX = process.platform !== 'win32';
const HOST = 'host.example.ts.net';
const phone: Identity = { nodeId: 'nPHONE', nodeName: 'phone', os: 'iOS', addresses: ['100.64.0.2'], tagged: false, user: { login: 'me@example.com', name: 'Me' }, tailnetId: 'T1' };
const laptop: Identity = { ...phone, nodeId: 'nLAPTOP', nodeName: 'laptop', addresses: ['100.64.0.3'] };

function setup(opts: { target?: RemoteTarget; tailscale?: FakeTailscale } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mh-rw-'));
  const tailscale = opts.tailscale ?? new FakeTailscale({ running: true, dnsName: HOST, tailnetId: 'T1', selfNodeId: 'nSELF', https: true });
  for (const id of [phone, laptop]) tailscale.identities.set(id.addresses[0]!, id);
  // Windows has no socket target: a loopback port (a fixed one per test process; serve needs a real port).
  const target: RemoteTarget = opts.target ?? (POSIX ? { kind: 'socket', path: join(dir, 'run', 'r.sock') } : { kind: 'loopback', port: freePort() });
  const access = new RemoteAccess({ dir: join(dir, 'remote'), tailscale, target });
  const webDir = join(dir, 'web');
  mkdirSync(webDir);
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>page</title>');
  const app = new App({ store: new Store(join(dir, 'c')), settingsFile: join(dir, 's.json'), settings: defaultSettings(), claude: { path: null, version: null }, remote: access });
  const local: Array<Record<string, unknown>> = [];
  const localClient: Client = { send: (m) => void local.push(JSON.parse(JSON.stringify(m))) };
  app.connect(localClient);
  return { dir, tailscale, access, app, local, localClient, webDir, target };
}

const PORT = 7443;
let nextPort = 20000 + (process.pid % 20000);
/** A loopback port for a test listener (the remote target's port must be a real one, not 0). */
function freePort(): number {
  return nextPort++;
}
/** The Host serve sends: `localhost` to a socket target, the tailnet name to a port target. */
let serveHost = 'localhost';
function headers(from: Identity, extra: Record<string, string> = {}): Record<string, string> {
  return { host: serveHost, 'x-forwarded-host': `${HOST}:${PORT}`, 'x-forwarded-for': from.addresses[0]!, 'x-forwarded-proto': 'https', ...extra };
}

function call(target: RemoteTarget, port: number | undefined, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const where = target.kind === 'socket' ? { socketPath: target.path } : { host: '127.0.0.1', port: port ?? target.port };
    const req = request({ ...where, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

test('remote: the switch adds and removes only our serve entry and is remembered; refusals say why', async () => {
  const { access, tailscale, target } = setup();
  assert.equal(access.enabled, false, 'off by default');
  assert.equal((await access.setEnabled(true)).ok, true);
  assert.deepEqual(tailscale.commands, [['serve', '--bg', `--https=${PORT}`, targetUrl(target)]]);
  assert.equal(access.state().url, `https://${HOST}:${PORT}`);
  assert.equal(access.state().serve, 'ours');
  // Remembered across a restart.
  const again = new RemoteAccess({ dir: (access as unknown as { opts: { dir: string } }).opts.dir, tailscale, target });
  assert.equal(again.enabled, true);
  assert.equal((await access.setEnabled(false)).ok, true);
  assert.deepEqual(tailscale.commands.at(-1), ['serve', `--https=${PORT}`, 'off']);
  for (const c of tailscale.commands) assert.ok(!c.includes('reset') && !c.includes('funnel'));

  // Someone else's service on our port.
  tailscale.serve.Web = { [`${HOST}:${PORT}`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } };
  const busy = await access.setEnabled(true);
  assert.equal(busy.ok, false);
  assert.match(busy.problem ?? '', /already in use|serves something else/);
  assert.equal(access.enabled, false);
  // Funnel on our port.
  tailscale.serve.AllowFunnel = { [`${HOST}:${PORT}`]: true };
  await access.refresh();
  assert.match(access.state().problem ?? '', /Funnel/);
});

test('remote: not the Tailscale operator gives the exact command; no Tailscale or no HTTPS says so', async () => {
  class Denied extends FakeTailscale {
    override async addServe(): Promise<void> {
      throw new Error('sending serve config: Access denied: serve config denied');
    }
  }
  const { access } = setup({ tailscale: new Denied({ running: true, dnsName: HOST, tailnetId: 'T1', selfNodeId: 'nSELF', https: true }) });
  const r = await access.setEnabled(true);
  assert.equal(r.ok, false);
  assert.equal(r.command, operatorCommand());
  assert.match(operatorCommand('linux', 'ann'), /^sudo tailscale set --operator=ann$/);
  assert.equal(access.state().command, operatorCommand());
  const none = setup({ tailscale: new FakeTailscale(null) });
  assert.match((await none.access.setEnabled(true)).problem ?? '', /not installed or not running/);
  const noHttps = setup({ tailscale: new FakeTailscale({ running: true, dnsName: HOST, tailnetId: 'T1', selfNodeId: 'nSELF', https: false }) });
  assert.match((await noHttps.access.setEnabled(true)).problem ?? '', /HTTPS/);
});

test('remote: on restart the setting wins over a stale serve entry, and others are left alone', async () => {
  const { access, tailscale, target } = setup();
  // Our entry left behind while the setting is off: removed.
  await tailscale.addServe(PORT, targetUrl(target));
  tailscale.commands.length = 0;
  await access.reconcile();
  assert.deepEqual(tailscale.commands, [['serve', `--https=${PORT}`, 'off']]);
  // Setting on, entry missing (removed by hand): added again.
  await access.setEnabled(true);
  await tailscale.removeServe(PORT, targetUrl(target));
  tailscale.commands.length = 0;
  await access.reconcile();
  assert.deepEqual(tailscale.commands, [['serve', '--bg', `--https=${PORT}`, targetUrl(target)]]);
  // Someone else's entry on our port while on: left as it is.
  await access.setEnabled(false);
  tailscale.serve.Web = { [`${HOST}:${PORT}`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9' } } } };
  tailscale.commands.length = 0;
  await access.reconcile();
  assert.deepEqual(tailscale.commands, []);
});

test('remote: port and policy settings; a port cannot change while on', async () => {
  const { access } = setup();
  access.configure({ port: 7444, allowTagged: true });
  assert.equal(access.state().port, 7444);
  assert.equal(access.state().allowTagged, true);
  assert.throws(() => access.configure({ port: 8443 }), /Choose a port/);
  assert.throws(() => access.configure({ port: 7717 }), /Choose a port/);
  await access.setEnabled(true);
  assert.throws(() => access.configure({ port: 7445 }), /Switch remote access off/);
});

test('remote: targets per platform', () => {
  assert.deepEqual(chooseTarget({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/d', 'linux'), { kind: 'socket', path: '/run/user/1000/masthead/remote.sock' });
  assert.deepEqual(chooseTarget({}, '/d', 'darwin', 501), { kind: 'socket', path: '/tmp/masthead-501/remote.sock' }, 'no runtime folder: a private folder in /tmp');
  assert.deepEqual(chooseTarget({}, '/d', 'win32'), { kind: 'loopback', port: 7719 });
  assert.deepEqual(chooseTarget({ XDG_RUNTIME_DIR: '/' + 'x'.repeat(120) }, '/d', 'linux', 7), { kind: 'socket', path: '/tmp/masthead-7/remote.sock' }, 'a long runtime path never falls back to a port on Unix');
  assert.equal(remoteCsp(`https://${HOST}:${PORT}`).includes(`connect-src 'self' wss://${HOST}:${PORT}`), true);
});

for (const kind of POSIX ? (['socket', 'loopback'] as const) : (['loopback'] as const))
test(`remote: pairing end to end, the device socket with its role, revoke (${kind})`, async () => {
  const { access, app, local, localClient, webDir, target } = setup(kind === 'loopback' ? { target: { kind: 'loopback', port: freePort() } } : {});
  serveHost = target.kind === 'socket' ? 'localhost' : `${HOST}:${PORT}`;
  await access.setEnabled(true);
  const running = await startRemote(app, access, { webDir });
  try {
    const port = undefined;
    if (target.kind === 'socket' && POSIX) {
      assert.equal(statSync(target.path).mode & 0o777, 0o600);
      assert.equal(statSync(join(target.path, '..')).mode & 0o777, 0o700);
    }
    // The listener refuses anything that did not come through serve for our name.
    assert.equal((await call(target, port, '/', { headers: { host: 'localhost' } })).status, 403, 'no forwarded headers');
    assert.equal((await call(target, port, '/', { headers: { host: `${HOST}:${PORT}` } })).status, 403, 'the right Host alone is not enough');
    assert.equal((await call(target, port, '/', { headers: { ...headers(phone), host: target.kind === 'socket' ? `127.0.0.1` : 'localhost' } })).status, 403, 'a Host serve would not send');
    assert.equal((await call(target, port, '/', { headers: headers(phone, { 'x-forwarded-host': 'evil.example:443' }) })).status, 403);
    assert.equal((await call(target, port, '/', { headers: headers(phone, { host: 'evil.example' }) })).status, 403);
    const page = await call(target, port, '/', { headers: headers(phone) });
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), new RegExp(`wss://${HOST}:${PORT}`));
    assert.equal((await call(target, port, '/api/shutdown', { method: 'POST', headers: headers(phone, { 'x-masthead': '1' }) })).status, 404, 'shutdown stays local');
    assert.deepEqual(JSON.parse((await call(target, port, '/api/health', { headers: headers(phone) })).body), { name: 'masthead' });

    // An unknown device: may ask.
    assert.equal(JSON.parse((await call(target, port, '/api/remote/whoami', { headers: headers(phone) })).body).state, 'unknown');
    const asked = JSON.parse((await call(target, port, '/api/remote/request', { method: 'POST', headers: headers(phone) })).body) as { requestId: string; pollSecret: string; code: string };
    assert.match(asked.code, /^\d{6}$/);
    // The local tab sees the request with the same code.
    const shown = local.filter((m) => m.t === 'remote').at(-1) as { remote: { requests: Array<{ id: string; code: string; nodeName: string }> } };
    assert.deepEqual(shown.remote.requests.map((r) => [r.code, r.nodeName]), [[asked.code, 'phone']]);
    const poll = (from: Identity, secret = asked.pollSecret) => call(target, port, `/api/remote/request/${asked.requestId}`, { method: 'POST', headers: headers(from), body: JSON.stringify({ pollSecret: secret }) }).then((r) => JSON.parse(r.body));
    assert.deepEqual(await poll(phone), { state: 'pending' });
    // Approved from the local session, with the read role.
    app.handle(localClient, { t: 'device_decision', requestId: asked.requestId, decision: 'allow', role: 'read' });
    assert.deepEqual(await poll(laptop), { state: 'gone' }, 'another node cannot collect the token');
    const got = await poll(phone);
    assert.equal(got.state, 'allowed');
    const token = got.token as string;
    assert.equal(JSON.parse((await call(target, port, '/api/remote/whoami', { headers: headers(phone, { 'x-masthead-device': token }) })).body).state, 'approved');

    // The device socket: right origin and token from the right node only.
    const open = (from: Identity, tok: string, origin = `https://${HOST}:${PORT}`) =>
      new Promise<{ ws?: WebSocket; status?: number; got: Array<Record<string, unknown>> }>((resolve) => {
        const got: Array<Record<string, unknown>> = [];
        const url = target.kind === 'socket' ? `ws+unix:${target.path}:/ws` : `ws://127.0.0.1:${target.port}/ws`;
        const ws = new WebSocket(url, ['masthead', `device.${tok}`], { headers: { ...headers(from), origin } });
        ws.on('message', (d) => got.push(JSON.parse(d.toString())));
        ws.on('open', () => setTimeout(() => resolve({ ws, got }), 50));
        ws.on('unexpected-response', (_q, res) => resolve({ status: res.statusCode, got }));
        ws.on('error', () => resolve({ status: -1, got }));
      });
    assert.equal((await open(phone, token, 'https://evil.example')).status, 403, 'wrong origin');
    assert.equal((await open(laptop, token)).status, 403, 'a copied token from another node');
    assert.equal((await open(phone, 'f'.repeat(64))).status, 403, 'a made-up token');
    const dev = await open(phone, token);
    assert.ok(dev.ws, 'connected');
    assert.deepEqual(dev.got, [], 'a device is sent nothing before its version 2 hello');
    dev.ws!.send(JSON.stringify({ t: 'subscribe', convId: 'x' }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(dev.got[0]?.code, 'protocol', 'and may send nothing else first');
    dev.ws!.send(JSON.stringify({ t: 'hello', protocol: 2 }));
    await new Promise((r) => setTimeout(r, 50));
    const state = dev.got.find((m) => m.t === 'state') as { state: Record<string, unknown>; protocol: number };
    assert.equal(state.protocol, 2);
    assert.equal('remote' in state.state, false, 'a device never sees the device list');
    const say = async (m: Record<string, unknown>) => {
      dev.got.length = 0;
      dev.ws!.send(JSON.stringify(m));
      await new Promise((r) => setTimeout(r, 50));
      return dev.got;
    };
    assert.equal((await say({ t: 'send', convId: null, text: 'hi', ref: 'x' }))[0]?.t, 'error', 'read role cannot send');
    assert.equal((await say({ t: 'remote_settings', enabled: false }))[0]?.t, 'error', 'device management is local only');
    assert.equal(access.enabled, true);
    // Role raised to full: the open socket follows; device management is still refused.
    app.handle(localClient, { t: 'device_role', nodeId: 'nPHONE', role: 'full' });
    const r = await say({ t: 'send', convId: null, text: 'hi', ref: 'x' });
    assert.notEqual((r[0] as { message?: string })?.message, 'This device may not do that.');
    // Revoke: the socket closes at once and the token stops working.
    const closed = new Promise<number>((res) => dev.ws!.on('close', (code) => res(code)));
    app.handle(localClient, { t: 'device_revoke', nodeId: 'nPHONE' });
    assert.equal(await closed, 4001);
    assert.equal((await open(phone, token)).status, 403);
    assert.equal(JSON.parse((await call(target, port, '/api/remote/whoami', { headers: headers(phone, { 'x-masthead-device': token }) })).body).state, 'unknown', 'a revoked token: may ask again');
    // The audit log reached the local session.
    local.length = 0;
    app.handle(localClient, { t: 'remote_audit' });
    const events = (local[0] as { entries: Array<{ event: string }> }).entries.map((e) => e.event);
    for (const e of ['switch', 'request', 'allow', 'collect', 'connect', 'refuse', 'role', 'revoke']) assert.ok(events.includes(e), e);
    // Switching off closes the listener.
    await access.setEnabled(false);
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(call(target, port, '/', { headers: headers(phone) }));
  } finally {
    await running.stop();
  }
});

test('remote: a local session without remote access gets a clear error; devices never see remote state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-rw-'));
  const app = new App({ store: new Store(join(dir, 'c')), settingsFile: join(dir, 's.json'), settings: defaultSettings(), claude: { path: null, version: null } });
  const got: Array<Record<string, unknown>> = [];
  const c: Client = { send: (m) => void got.push(m as Record<string, unknown>) };
  app.connect(c);
  got.length = 0;
  app.handle(c, { t: 'remote_audit' });
  assert.match(String(got[0]?.message), /not available/);
});

test('remote: page files are served without a whois; a hijacking second request gets nothing', async () => {
  const { access, app, webDir, target, tailscale } = setup();
  serveHost = target.kind === 'socket' ? 'localhost' : `${HOST}:${PORT}`;
  let lookups = 0;
  const orig = tailscale.whois.bind(tailscale);
  tailscale.whois = async (a: string) => (lookups++, orig(a));
  await access.setEnabled(true);
  const running = await startRemote(app, access, { webDir });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await call(target, undefined, '/', { headers: headers(phone) })).status, 200);
    assert.equal(lookups, 0, 'no whois for page files');
    const first = JSON.parse((await call(target, undefined, '/api/remote/request', { method: 'POST', headers: headers(phone) })).body);
    // A second asker claiming the same device (another local user on a loopback listener).
    const second = await call(target, undefined, '/api/remote/request', { method: 'POST', headers: headers(phone) });
    assert.equal(second.status, 403);
    assert.doesNotMatch(second.body, new RegExp(first.code));
    assert.doesNotMatch(second.body, /pollSecret/);
    const poll = await call(target, undefined, `/api/remote/request/${first.requestId}`, { method: 'POST', headers: headers(phone), body: JSON.stringify({ pollSecret: first.pollSecret }) });
    assert.deepEqual(JSON.parse(poll.body), { state: 'pending' }, "the real device's poll still works");
  } finally {
    await running.stop();
  }
});

test('remote: the socket folder must be a private folder of this user, not a symlink or someone else\'s', async () => {
  if (!POSIX) return;
  const { privateFolder } = await import('../server/transport/remote.ts');
  const { symlinkSync } = await import('node:fs');
  const base = mkdtempSync(join(tmpdir(), 'mh-pf-'));
  privateFolder(join(base, 'ok'));
  assert.equal(statSync(join(base, 'ok')).mode & 0o777, 0o700);
  mkdirSync(join(base, 'real'));
  symlinkSync(join(base, 'real'), join(base, 'link'));
  assert.throws(() => privateFolder(join(base, 'link')), /not a private folder/);
  assert.throws(() => privateFolder(join(base, 'ok'), 12345), /not a private folder/, 'owned by another uid');
});
