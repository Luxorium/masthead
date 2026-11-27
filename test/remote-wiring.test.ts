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
import { RemoteAccess, looksLikePermission, operatorCommand, serveOffCommand, sudoServeCommand, targetUrl, type RemoteTarget } from '../server/remote/access.ts';
import { CliTailscale, FakeTailscale, OffTailscale, serveStateFrom, tailscaleFor, type Identity } from '../server/remote/tailscale.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Store } from '../server/storage/store.ts';
import { chooseTarget, remoteCsp, startRemote } from '../server/transport/remote.ts';

const POSIX = process.platform !== 'win32';
const HOST = 'host.example.ts.net';
const phone: Identity = { nodeId: 'nPHONE', nodeName: 'phone', os: 'iOS', addresses: ['100.64.0.2'], tagged: false, user: { login: 'me@example.com', name: 'Me' }, tailnetId: 'T1' };
const laptop: Identity = { ...phone, nodeId: 'nLAPTOP', nodeName: 'laptop', addresses: ['100.64.0.3'] };

function setup(opts: { target?: RemoteTarget; tailscale?: FakeTailscale; platform?: NodeJS.Platform } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mh-rw-'));
  const tailscale = opts.tailscale ?? new FakeTailscale({ running: true, dnsName: HOST, tailnetId: 'T1', selfNodeId: 'nSELF', https: true });
  for (const id of [phone, laptop]) tailscale.identities.set(id.addresses[0]!, id);
  // Windows has no socket target: a loopback port (a fixed one per test process; serve needs a real port).
  const target: RemoteTarget = opts.target ?? (POSIX ? { kind: 'socket', path: join(dir, 'run', 'r.sock') } : { kind: 'loopback', port: freePort() });
  const access = new RemoteAccess({ dir: join(dir, 'remote'), tailscale, target, platform: opts.platform });
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

const SOCKET_401 = "sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket";

/** Tailscale as a user who may read but not change serve config; `root()` stands for the person's sudo. */
class Refusing extends FakeTailscale {
  constructor(public refusal: string) {
    super({ running: true, dnsName: HOST, tailnetId: 'T1', selfNodeId: 'nSELF', https: true });
  }
  override async addServe(port: number, target: string): Promise<void> {
    if ((await this.serveState(port, target)).kind === 'ours') return;
    throw new Error(this.refusal);
  }
  override async removeServe(port: number, target: string): Promise<void> {
    if ((await this.serveState(port, target)).kind === 'off') return;
    throw new Error(this.refusal);
  }
  async root(port: number, target: string): Promise<void> {
    await super.addServe(port, target);
  }
}

test('remote: a socket target refused for want of root offers the sudo serve command; after it, switching on works', { skip: !POSIX }, async () => {
  const tailscale = new Refusing(SOCKET_401);
  const { access, target } = setup({ tailscale, platform: 'linux' });
  const r = await access.setEnabled(true);
  assert.equal(r.ok, false);
  assert.equal(access.enabled, false);
  // The very command Masthead runs, under sudo, built from addCommand: not the operator step, which is not enough.
  assert.equal(r.command, `sudo tailscale serve --bg --https=${PORT} ${targetUrl(target)}`);
  assert.equal(r.command, sudoServeCommand(PORT, targetUrl(target)));
  assert.match(r.problem ?? '', /needs your password once/);
  assert.equal(access.state().command, r.command);
  // The person runs it; Masthead's entry is there as root added it, and the switch now finds it.
  await tailscale.root(PORT, targetUrl(target));
  tailscale.commands.length = 0;
  const again = await access.setEnabled(true);
  assert.equal(again.ok, true);
  assert.equal(access.enabled, true);
  assert.equal(access.state().serve, 'ours');
  assert.equal(access.state().problem, undefined);
  assert.equal(access.state().command, undefined);
  // Masthead itself ran nothing: the entry root added is its own.
  assert.deepEqual(tailscale.commands, []);
});

test('remote: switching off always works; a refused removal leaves a quiet note with the removal command', { skip: !POSIX }, async () => {
  const tailscale = new Refusing(SOCKET_401);
  const { access, target } = setup({ tailscale, platform: 'linux' });
  await tailscale.root(PORT, targetUrl(target));
  assert.equal((await access.setEnabled(true)).ok, true);
  const r = await access.setEnabled(false);
  assert.equal(r.ok, true);
  assert.equal(access.enabled, false);
  assert.equal(r.command, `sudo tailscale serve --https=${PORT} off`);
  assert.equal(r.command, serveOffCommand(PORT, 'linux'));
  assert.match(r.problem ?? '', /nothing can reach Masthead.*Tailscale said: sending serve config: 401 Unauthorized/);
  assert.ok(access.audit().some((e) => e.event === 'switch' && /switched off \(Tailscale kept its entry/.test(e.detail ?? '')));
  // At the next start: the setting is off and the entry still ours; the refused removal does not throw.
  await access.reconcile();
  assert.equal(access.enabled, false);
  assert.equal(access.state().serve, 'ours');
  assert.equal(access.state().command, serveOffCommand(PORT, 'linux'));
  // Once the person removes it, the note goes.
  delete tailscale.serve.Web?.[`${HOST}:${PORT}`];
  delete tailscale.serve.TCP?.[String(PORT)];
  await access.refresh();
  assert.equal(access.state().problem, undefined);
});

test('remote: other permission refusals keep the operator advice and say what Tailscale said; the match is narrow', async () => {
  const tailscale = new Refusing('sending serve config: Access denied: serve config denied');
  const { access } = setup({ tailscale, target: { kind: 'loopback', port: 7801 }, platform: 'linux' });
  const r = await access.setEnabled(true);
  assert.equal(r.ok, false);
  assert.equal(r.command, operatorCommand('linux'));
  assert.match(r.problem ?? '', /operator once.*Tailscale said: sending serve config: Access denied: serve config denied$/);
  assert.match(operatorCommand('linux', 'ann'), /^sudo tailscale set --operator=ann$/);
  assert.match(operatorCommand('win32'), /administrator/);
  // Windows: the loopback target, so the operator (administrator) advice, never sudo.
  const win = setup({ tailscale: new Refusing('Access denied'), target: { kind: 'loopback', port: 7802 }, platform: 'win32' });
  assert.match((await win.access.setEnabled(true)).command ?? '', /administrator/);
  assert.equal(serveOffCommand(PORT, 'win32'), `tailscale serve --https=${PORT} off`);
  // A long multi-line answer comes back on one line, trimmed.
  const long = setup({ tailscale: new Refusing(`permission denied\n${'x'.repeat(400)}`), target: { kind: 'loopback', port: 7803 }, platform: 'linux' });
  const p = (await long.access.setEnabled(true)).problem ?? '';
  assert.ok(!p.includes('\n') && p.endsWith('…') && p.length < 500);
  for (const m of [SOCKET_401, 'Access denied: serve config denied', 'open /var/run/tailscale: permission denied', 'must be root', 'operation not permitted'])
    assert.equal(looksLikePermission(m), true, m);
  for (const m of ['Port 7443 on Tailscale is already in use.', 'serve config has a permission field that was ignored', 'tailscale: not running']) assert.equal(looksLikePermission(m), false, m);
  // Not refused but missing: plain words, no command.
  const none = setup({ tailscale: new FakeTailscale(null) });
  assert.match((await none.access.setEnabled(true)).problem ?? '', /not installed or not running/);
  const noHttps = setup({ tailscale: new FakeTailscale({ running: true, dnsName: HOST, tailnetId: 'T1', selfNodeId: 'nSELF', https: false }) });
  assert.match((await noHttps.access.setEnabled(true)).problem ?? '', /HTTPS/);
});

test('remote: on restart the setting wins over a stale serve entry, and others are left alone', async () => {
  const { access, tailscale, target } = setup();
  // An entry that only looks like ours, while this instance never had remote access on: left alone.
  await tailscale.addServe(PORT, targetUrl(target));
  tailscale.commands.length = 0;
  await access.reconcile();
  assert.deepEqual(tailscale.commands, []);
  assert.equal(access.state().command, undefined, 'and no note about it either');
  // Our own entry left behind (switched off while Tailscale was down): removed at the next start.
  assert.equal((await access.setEnabled(true)).ok, true);
  const tailnet = tailscale.tailnet;
  tailscale.tailnet = null;
  assert.equal((await access.setEnabled(false)).ok, true);
  tailscale.tailnet = tailnet;
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

test('remote: test and fake servers never run the real tailscale', async () => {
  assert.ok(tailscaleFor({ MASTHEAD_BACKEND: 'fake' }) instanceof OffTailscale);
  assert.ok(tailscaleFor({ MASTHEAD_TAILSCALE: 'off' }) instanceof OffTailscale);
  assert.ok(tailscaleFor({}) instanceof CliTailscale);
  const off = new OffTailscale();
  assert.equal(await off.status(), null);
  assert.equal(await off.whois('100.64.0.2'), null);
  await assert.rejects(off.removeServe());
  // Remote access with it: "not installed", switching on refused, nothing else happens.
  const access = new RemoteAccess({ dir: join(mkdtempSync(join(tmpdir(), 'mh-off-')), 'remote'), tailscale: off, target: { kind: 'socket', path: '/tmp/x.sock' } });
  await access.reconcile();
  assert.match((await access.setEnabled(true)).problem ?? '', /not installed or not running/);
  assert.equal(access.state().available, false);
});

test('remote: targets per platform', () => {
  const linuxData = '/home/ann/.local/share/masthead';
  const macData = '/Users/ann/Library/Application Support/Masthead';
  assert.deepEqual(chooseTarget({ XDG_RUNTIME_DIR: '/run/user/1000' }, linuxData, 'linux', 1000, '/home/ann'), { kind: 'socket', path: '/run/user/1000/masthead/remote.sock' });
  assert.deepEqual(chooseTarget({}, macData, 'darwin', 501, '/Users/ann'), { kind: 'socket', path: '/tmp/masthead-501/remote.sock' }, 'no runtime folder: a private folder in /tmp');
  assert.deepEqual(chooseTarget({}, '/d', 'win32'), { kind: 'loopback', port: 7719 });
  assert.deepEqual(chooseTarget({ XDG_RUNTIME_DIR: '/' + 'x'.repeat(120) }, linuxData, 'linux', 7, '/home/ann'), { kind: 'socket', path: '/tmp/masthead-7/remote.sock' }, 'a long runtime path never falls back to a port on Unix');
  // Any other data folder (a test server, a second instance) gets its own socket, so their serve
  // entries never look alike: the other's entry reads as "elsewhere" and is left alone.
  const test1 = chooseTarget({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/tmp/tmp.abc/data', 'linux', 1000, '/home/ann');
  const test2 = chooseTarget({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/tmp/tmp.def/data', 'linux', 1000, '/home/ann');
  assert.match(test1.kind === 'socket' ? test1.path : '', /^\/run\/user\/1000\/masthead\/remote-[0-9a-f]{10}\.sock$/);
  assert.notDeepEqual(test1, test2);
  assert.deepEqual(test1, chooseTarget({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/tmp/tmp.abc/data', 'linux', 1000, '/home/ann'), 'the same folder, the same socket');
  const longest = chooseTarget({ XDG_RUNTIME_DIR: '/run/user/4294967294' }, '/x', 'linux', 1, '/home/ann');
  assert.ok(longest.kind === 'socket' && Buffer.byteLength(longest.path) < 100);
  const ours = targetUrl(chooseTarget({ XDG_RUNTIME_DIR: '/run/user/1000' }, linuxData, 'linux', 1000, '/home/ann'));
  assert.equal(serveStateFrom({ Web: { [`${HOST}:${PORT}`]: { Handlers: { '/': { Proxy: ours } } } }, TCP: { [PORT]: { HTTPS: true } } }, HOST, PORT, targetUrl(test1)).kind, 'elsewhere');
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
    // Approved from the local session without naming a role: the most limited one, read (0.2.1).
    app.handle(localClient, { t: 'device_decision', requestId: asked.requestId, decision: 'allow' });
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

for (const kind of POSIX ? (['socket', 'loopback'] as const) : (['loopback'] as const))
test(`remote: page files are served without a whois; a hijacking second request gets nothing of the first (${kind})`, async () => {
  const { access, app, webDir, target, tailscale } = setup(kind === 'loopback' ? { target: { kind: 'loopback', port: freePort() } } : {});
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
    if (target.kind === 'socket') {
      // Only tailscaled reaches a socket: one waiting request per device, the second gets nothing.
      assert.equal(second.status, 403);
      assert.doesNotMatch(second.body, /pollSecret/);
    } else {
      // On a loopback port anyone local can claim the device, so each asker gets its own request
      // (own code, own poll secret); the first one's is never revealed or replaced.
      assert.equal(second.status, 200);
      const b = JSON.parse(second.body);
      assert.notEqual(b.requestId, first.requestId);
      assert.notEqual(b.pollSecret, first.pollSecret);
    }
    assert.doesNotMatch(second.body, new RegExp(`"${first.code}"`));
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

for (const kind of POSIX ? (['socket', 'loopback'] as const) : (['loopback'] as const))
test(`remote: identity is decided per request, not per connection (${kind})`, async () => {
  const { Agent } = await import('node:http');
  const { access, app, webDir, target } = setup(kind === 'loopback' ? { target: { kind: 'loopback', port: freePort() } } : {});
  serveHost = target.kind === 'socket' ? 'localhost' : `${HOST}:${PORT}`;
  await access.setEnabled(true);
  const running = await startRemote(app, access, { webDir });
  try {
    // One kept-alive connection, as tailscale serve may use for many devices.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const ask = (from: Identity | null) =>
      new Promise<{ status: number; body: string; socket: unknown }>((resolve, reject) => {
        const where = target.kind === 'socket' ? { socketPath: target.path } : { host: '127.0.0.1', port: target.port };
        const h = from ? headers(from) : { host: serveHost, 'x-forwarded-host': `${HOST}:${PORT}` };
        const req = request({ ...where, agent, path: '/api/remote/whoami', headers: h }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, socket: req.socket }));
        });
        req.on('error', reject);
        req.end();
      });
    const a = await ask(phone);
    const b = await ask(laptop);
    const c = await ask(null);
    assert.equal(a.socket, b.socket, 'the same connection was reused');
    assert.equal(JSON.parse(a.body).device.name, 'phone');
    assert.equal(JSON.parse(b.body).device.name, 'laptop', 'the second request is its own device');
    assert.equal(c.status, 403, 'a third request on that connection without forwarded identity gets nothing');
    agent.destroy();
  } finally {
    await running.stop();
  }
});

test('remote: forget_me drops only the asking device, closes its sockets and is logged; the local page cannot send it', async () => {
  const { access, app, localClient, local } = setup();
  const pair = (id: Identity) => {
    const r = access.registry.request(id, id.addresses[0]!);
    if ('refused' in r) throw new Error(r.refused);
    access.registry.allow(r.request.id);
  };
  pair(phone);
  pair(laptop);
  const closed: string[] = [];
  access.onDevice((nodeId, change) => 'revoked' in change && closed.push(nodeId));
  const got: Array<Record<string, unknown>> = [];
  const dev: Client = { send: (m) => void got.push(m as Record<string, unknown>), role: 'read', deviceId: 'nPHONE' };
  app.connect(dev);
  app.handle(dev, { t: 'hello', protocol: 2 });
  app.handle(dev, { t: 'forget_me' });
  assert.deepEqual(access.registry.list().map((d) => d.nodeId), ['nLAPTOP']);
  assert.deepEqual(closed, ['nPHONE']);
  assert.ok(access.audit().some((e) => e.event === 'forget' && e.nodeId === 'nPHONE'));
  local.length = 0;
  app.handle(localClient, { t: 'forget_me' });
  assert.equal(local[0]!.t, 'error');
});

test('remote: switching off works while Tailscale is down; the entry goes at the next start', async () => {
  const { access, tailscale, target } = setup();
  await access.setEnabled(true);
  const status = tailscale.tailnet;
  tailscale.tailnet = null;
  const r = await access.setEnabled(false);
  assert.equal(r.ok, true);
  assert.equal(access.enabled, false);
  tailscale.tailnet = status;
  tailscale.commands.length = 0;
  await access.reconcile();
  assert.deepEqual(tailscale.commands, [['serve', `--https=${PORT}`, 'off']]);
  void target;
});

test('remote: with a devices file from a newer Masthead, remote access stays off and says why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-rw-'));
  mkdirSync(join(dir, 'remote'), { recursive: true });
  writeFileSync(join(dir, 'remote', 'devices.json'), JSON.stringify({ version: 9, devices: [] }));
  writeFileSync(join(dir, 'remote', 'config.json'), JSON.stringify({ version: 1, enabled: true, port: 7443, allowOtherTailnets: false, allowTagged: false }));
  const tailscale = new FakeTailscale({ running: true, dnsName: HOST, tailnetId: 'T1', selfNodeId: 'nSELF', https: true });
  const access = new RemoteAccess({ dir: join(dir, 'remote'), tailscale, target: { kind: 'loopback', port: freePort() } });
  assert.equal(access.enabled, false);
  const r = await access.setEnabled(true);
  assert.equal(r.ok, false);
  assert.match(r.problem ?? '', /newer version of Masthead/);
  assert.deepEqual(tailscale.commands, []);
});
