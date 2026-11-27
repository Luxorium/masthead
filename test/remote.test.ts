// Remote access logic: the Tailscale provider (with a fake and a recorded CLI), the device registry,
// the audit log and the authorisation decision. Nothing here runs a tailscale command.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// NTFS has no POSIX modes; file privacy there is checked by the Windows-specific code paths.
const POSIX = process.platform !== 'win32';
import { allowedMessage, authorise } from '../server/remote/authorise.ts';
import { DeviceRegistry, refusalFor } from '../server/remote/registry.ts';
import { CachedWhois, CliTailscale, FakeTailscale, addCommand, identityFrom, removeCommand, serveStateFrom, type Identity } from '../server/remote/tailscale.ts';

const SOCK = 'unix:/run/user/1000/masthead/remote.sock';
const phone: Identity = { nodeId: 'nPHONE', nodeName: 'phone', os: 'iOS', addresses: ['100.64.0.2'], tagged: false, user: { login: 'me@example.com', name: 'Me' }, tailnetId: 'T1' };
const laptop: Identity = { ...phone, nodeId: 'nLAPTOP', nodeName: 'laptop', os: 'linux', addresses: ['100.64.0.3'] };
const tagged: Identity = { ...phone, nodeId: 'nSERVER', nodeName: 'server', tagged: true, user: undefined, addresses: ['100.64.0.4'] };
const foreign: Identity = { ...phone, nodeId: 'nFRIEND', nodeName: 'friend', tailnetId: 'T2', user: { login: 'friend@else.com', name: 'Friend' }, addresses: ['100.64.0.5'] };
const self: Identity = { ...phone, nodeId: 'nSELF', nodeName: 'host', addresses: ['100.64.0.1'] };

function setup(opts: { tokenDays?: number; allowOtherTailnets?: boolean; allowTagged?: boolean } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'masthead-remote-')), 'remote');
  let clock = 1_000_000;
  const registry = new DeviceRegistry({ dir, now: () => clock, ...opts });
  const tailscale = new FakeTailscale();
  for (const id of [phone, laptop, tagged, foreign, self]) tailscale.identities.set(id.addresses[0]!, id);
  const deps = { tailscale, registry, ourTailnet: 'T1', selfNodeId: 'nSELF' };
  const advance = (ms: number) => (clock += ms);
  /** Pairs a device the way the transport will: request, allow, collect. */
  const pair = (id: Identity, role: 'full' | 'approve' | 'read' = 'full') => {
    const r = registry.request(id, id.addresses[0]!);
    if ('refused' in r) throw new Error(r.refused);
    registry.allow(r.request.id, role);
    const c = registry.collect(r.request.id, r.pollSecret, id.nodeId);
    if (c.state !== 'allowed') throw new Error('not allowed');
    return c.token;
  };
  return { dir, registry, tailscale, deps, advance, pair };
}

test('remote: a pending request gets a six-digit code; a second asker for the same node gets neither code nor secret', () => {
  const { registry } = setup();
  const a = registry.request(phone, '100.64.0.2');
  assert.ok(!('refused' in a));
  assert.match(a.request.code, /^\d{6}$/);
  // The hijack bravo found: a forged second request must not rotate the first one's poll secret.
  const b = registry.request(phone, '100.64.0.2');
  assert.deepEqual(b, { refused: 'A request from this device is already waiting for approval.' });
  assert.ok(!JSON.stringify(b).includes(a.request.code), 'the code is not revealed');
  assert.equal(registry.collect(a.request.id, a.pollSecret, phone.nodeId).state, 'pending', "the first asker's secret still works");
  registry.allow(a.request.id);
  assert.equal(registry.collect(a.request.id, a.pollSecret, phone.nodeId).state, 'allowed');
  assert.equal(registry.requests().length, 0);
});

test('remote: pending requests are capped per tailnet user', () => {
  const { registry } = setup();
  for (let i = 0; i < 3; i++) assert.ok(!('refused' in registry.request({ ...phone, nodeId: `n${i}` }, `100.64.1.${i}`)));
  assert.match(JSON.stringify(registry.request({ ...phone, nodeId: 'n9' }, '100.64.1.9')), /Too many devices of this tailnet user/);
  assert.ok(!('refused' in registry.request(foreign, '100.64.0.5')), 'another user is not blocked');
});

test('remote: refusals are logged at most once a minute per node and reason; the log rotates and reads a tail', () => {
  const { registry, dir, advance } = setup();
  for (let i = 0; i < 50; i++) registry.audit({ event: 'refuse', nodeId: 'nX', detail: 'unknown token' });
  assert.equal(registry.readAudit().length, 1);
  advance(61_000);
  registry.audit({ event: 'refuse', nodeId: 'nX', detail: 'unknown token' });
  assert.equal(registry.readAudit().length, 2);
  writeFileSync(join(dir, 'audit.jsonl'), 'x'.repeat(1024 * 1024 + 10) + '\n');
  registry.audit({ event: 'request', nodeId: 'nY' });
  assert.deepEqual(registry.readAudit().map((e) => e.event), ['request'], 'rotated past 1 MB');
  assert.ok(statSync(join(dir, 'audit.jsonl.1')).size > 1024 * 1024);
});

test('remote: an approval that expires tells the transport, as revoke does', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'masthead-remote-')), 'remote');
  let clock = 0;
  const expired: string[] = [];
  const registry = new DeviceRegistry({ dir, now: () => clock, onExpire: (id) => void expired.push(id) });
  const r = registry.request(phone, '100.64.0.2');
  assert.ok(!('refused' in r));
  registry.allow(r.request.id);
  clock += 31 * 24 * 3600_000;
  registry.sweep();
  assert.deepEqual(expired, ['nPHONE']);
});

test('remote: allow issues the token once, only to the node that asked, and only its hash is stored', () => {
  const { registry, dir } = setup();
  const r = registry.request(phone, '100.64.0.2');
  assert.ok(!('refused' in r));
  assert.equal(registry.allow(r.request.id, 'approve')?.role, 'approve');
  assert.equal(registry.collect(r.request.id, r.pollSecret, laptop.nodeId).state, 'gone', 'another node cannot collect it');
  assert.equal(registry.collect(r.request.id, 'f'.repeat(48), phone.nodeId).state, 'gone', 'a wrong poll secret');
  const c = registry.collect(r.request.id, r.pollSecret, phone.nodeId);
  assert.ok(c.state === 'allowed' && /^[0-9a-f]{64}$/.test(c.token) && c.role === 'approve');
  assert.equal(registry.collect(r.request.id, r.pollSecret, phone.nodeId).state, 'gone', 'collected once');
  const file = readFileSync(join(dir, 'devices.json'), 'utf8');
  assert.ok(c.state === 'allowed' && !file.includes(c.token), 'the token is not on disk');
  assert.equal(JSON.parse(file).version, 1);
  if (POSIX) assert.equal(statSync(join(dir, 'devices.json')).mode & 0o777, 0o600);
  if (POSIX) assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(registry.allow(r.request.id), null, 'a request cannot be allowed twice');
});

test('remote: deny refuses the node for a while, then it may ask again', () => {
  const { registry, advance } = setup();
  const r = registry.request(phone, '100.64.0.2');
  assert.ok(!('refused' in r));
  assert.equal(registry.deny(r.request.id), true);
  assert.equal(registry.collect(r.request.id, r.pollSecret, phone.nodeId).state, 'gone');
  assert.ok('refused' in registry.request(phone, '100.64.0.2'));
  advance(11 * 60_000);
  assert.ok(!('refused' in registry.request(phone, '100.64.0.2')));
  assert.equal(registry.deny('nope'), false);
});

test('remote: requests expire after ten minutes', () => {
  const { registry, advance } = setup();
  const r = registry.request(phone, '100.64.0.2');
  assert.ok(!('refused' in r));
  advance(11 * 60_000);
  assert.equal(registry.requests().length, 0);
  assert.equal(registry.allow(r.request.id), null);
});

test('remote: tokens last 30 days, are renewed on use, and survive a restart', () => {
  const { registry, advance, pair, dir } = setup();
  const token = pair(phone);
  advance(29 * 24 * 3600_000);
  assert.ok(registry.check(phone.nodeId, token, '100.64.0.2'), 'still valid on day 29, and renewed');
  advance(29 * 24 * 3600_000);
  assert.ok(registry.check(phone.nodeId, token, '100.64.0.2'), 'renewal moved the expiry on');
  const again = new DeviceRegistry({ dir, now: () => 1_000_000 + 58 * 24 * 3600_000 });
  assert.ok(again.check(phone.nodeId, token, '100.64.0.2'), 'loaded from the file');
  advance(31 * 24 * 3600_000);
  assert.equal(registry.check(phone.nodeId, token, '100.64.0.2'), null, 'expired after 30 unused days');
  assert.equal(registry.list().length, 0);
  assert.ok(registry.readAudit().some((e) => e.event === 'expire'));
});

test('remote: an unreadable or old-format devices file approves nobody', () => {
  const { dir } = setup();
  writeFileSync(join(dir, 'devices.json'), JSON.stringify({ version: 99, devices: [{ nodeId: 'x', tokenHash: 'ab', role: 'full' }] }));
  assert.equal(new DeviceRegistry({ dir }).list().length, 0);
  writeFileSync(join(dir, 'devices.json'), '{not json');
  assert.equal(new DeviceRegistry({ dir }).list().length, 0);
});

test('remote: revoke and role changes take effect at once; re-pairing replaces the old token', () => {
  const { registry, pair } = setup();
  const first = pair(phone);
  assert.equal(registry.setRole(phone.nodeId, 'read'), true);
  assert.equal(registry.check(phone.nodeId, first, '100.64.0.2')?.role, 'read');
  assert.equal(registry.setRole(phone.nodeId, 'admin' as never), false);
  const second = pair(phone);
  assert.equal(registry.check(phone.nodeId, first, '100.64.0.2'), null, 'the earlier token no longer works');
  assert.ok(registry.check(phone.nodeId, second, '100.64.0.2'));
  assert.equal(registry.revoke(phone.nodeId), true);
  assert.equal(registry.check(phone.nodeId, second, '100.64.0.2'), null);
  assert.equal(registry.revoke(phone.nodeId), false);
});

test('remote: the audit log records each step, privately', () => {
  const { registry, pair, dir } = setup();
  pair(phone);
  registry.revoke(phone.nodeId);
  const events = registry.readAudit().map((e) => e.event);
  assert.deepEqual(events, ['request', 'allow', 'collect', 'revoke']);
  if (POSIX) assert.equal(statSync(join(dir, 'audit.jsonl')).mode & 0o777, 0o600);
  assert.ok(registry.readAudit().every((e) => e.nodeId === 'nPHONE' && typeof e.ts === 'number'));
});

test('remote: other tailnets and tagged devices are refused unless allowed', () => {
  assert.equal(refusalFor(phone, 'T1', {}), null);
  assert.match(refusalFor(tagged, 'T1', {}) ?? '', /tagged/);
  assert.match(refusalFor(foreign, 'T1', {}) ?? '', /other tailnets/);
  assert.equal(refusalFor(tagged, 'T1', { allowTagged: true }), null);
  assert.equal(refusalFor(foreign, 'T1', { allowOtherTailnets: true }), null);
});

test('authorise: loopback is local whatever headers it carries; forged identity on loopback changes nothing', async () => {
  const { deps, pair } = setup();
  const token = pair(phone);
  assert.deepEqual(await authorise({ via: 'loopback' }, deps), { kind: 'local' });
  assert.deepEqual(await authorise({ via: 'loopback', forwardedFor: '100.64.0.2', token }, deps), { kind: 'local' }, 'never treated as a remote device');
  assert.deepEqual(await authorise({ via: 'loopback', forwardedFor: '100.64.0.5', token: 'x' }, deps), { kind: 'local' });
});

test('authorise: the remote socket checks address, node, tailnet and token', async () => {
  const { deps, pair, registry } = setup();
  const token = pair(phone, 'approve');
  const ok = await authorise({ via: 'remote', forwardedFor: '100.64.0.2', token }, deps);
  assert.ok(ok.kind === 'remote' && ok.role === 'approve' && ok.device.nodeId === 'nPHONE');
  assert.equal((await authorise({ via: 'remote', forwardedFor: '100.64.0.2, 10.0.0.1', token }, deps)).kind, 'remote', 'first address of a list');
  assert.equal((await authorise({ via: 'remote', forwardedFor: '100.64.0.2' }, deps)).kind, 'unknown', 'no token yet: may ask');
  assert.deepEqual(await authorise({ via: 'remote' }, deps), { kind: 'refused', reason: 'no forwarded address' });
  assert.deepEqual(await authorise({ via: 'remote', forwardedFor: '100.99.9.9', token }, deps), { kind: 'refused', reason: 'unknown tailnet address' });
  assert.equal((await authorise({ via: 'remote', forwardedFor: '100.64.0.1', token }, deps)).kind, 'refused', 'this machine itself');
  assert.match(JSON.stringify(await authorise({ via: 'remote', forwardedFor: '100.64.0.4' }, deps)), /tagged/);
  assert.match(JSON.stringify(await authorise({ via: 'remote', forwardedFor: '100.64.0.5' }, deps)), /other tailnets/);
  // A copied token presented from another node of the same tailnet.
  const copied = await authorise({ via: 'remote', forwardedFor: '100.64.0.3', token }, deps);
  assert.deepEqual(copied, { kind: 'refused', reason: 'token of phone offered from another node' });
  assert.ok(registry.readAudit().some((e) => e.event === 'refuse' && e.nodeId === 'nLAPTOP'));
  assert.equal((await authorise({ via: 'remote', forwardedFor: '100.64.0.2', token: 'a'.repeat(64) }, deps)).kind, 'refused', 'a made-up token');
  registry.revoke('nPHONE');
  assert.equal((await authorise({ via: 'remote', forwardedFor: '100.64.0.2', token }, deps)).kind, 'refused', 'after revoke');
});

test('authorise: roles limit the messages a remote device may send; shutdown and device management stay local', () => {
  for (const t of ['send', 'settings', 'delete', 'permission', 'open']) assert.equal(allowedMessage('full', t), true, t);
  for (const t of ['device_decision', 'device_revoke', 'device_role', 'remote_settings', 'shutdown']) {
    assert.equal(allowedMessage('full', t), false, t);
    assert.equal(allowedMessage('local', t), true, t);
  }
  assert.equal(allowedMessage('approve', 'permission'), true);
  assert.equal(allowedMessage('approve', 'stop_all'), true);
  assert.equal(allowedMessage('approve', 'send'), false);
  assert.equal(allowedMessage('approve', 'settings'), false);
  assert.equal(allowedMessage('read', 'open'), true);
  assert.equal(allowedMessage('read', 'permission'), false);
});

test('tailscale: serve add and remove only ever name our own port and target', async () => {
  const ts = new FakeTailscale();
  ts.serve = { Web: { 'host.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }, TCP: { '443': {} } };
  assert.deepEqual(await ts.serveState(7443, SOCK), { kind: 'off' });
  await ts.addServe(7443, SOCK);
  assert.deepEqual(await ts.serveState(7443, SOCK), { kind: 'ours' });
  await ts.addServe(7443, SOCK); // already ours: nothing run
  await ts.removeServe(7443, SOCK);
  await ts.removeServe(7443, SOCK); // already off: nothing run
  assert.deepEqual(ts.commands, [['serve', '--bg', '--https=7443', SOCK], ['serve', '--https=7443', 'off']]);
  assert.ok(ts.serve.Web?.['host.example.ts.net:443'], "the other service's entry is untouched");
  for (const cmd of ts.commands) assert.ok(!cmd.includes('reset') && !cmd.includes('funnel'));
  // A port someone else uses is neither taken over nor removed.
  ts.serve.Web!['host.example.ts.net:7444'] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } };
  await assert.rejects(ts.addServe(7444, SOCK), /already in use/);
  await assert.rejects(ts.removeServe(7444, SOCK), /something else/);
  assert.equal(ts.commands.length, 2);
});

test('tailscale: commands refuse foreign targets, Funnel ports and bad ports', () => {
  assert.deepEqual(addCommand(7443, 'http://127.0.0.1:7719'), ['serve', '--bg', '--https=7443', 'http://127.0.0.1:7719']);
  assert.deepEqual(removeCommand(7443), ['serve', '--https=7443', 'off']);
  for (const t of ['http://192.168.1.2:80', 'https://example.com', '/etc', 'unix:relative', 'http://127.0.0.1:7719/x', '3000']) assert.throws(() => addCommand(7443, t), /only its own/, t);
  for (const p of [443, 8443, 10000, 80, 70000, 1.5]) assert.throws(() => addCommand(p, SOCK), undefined, String(p));
  assert.throws(() => removeCommand(8443));
});

test('tailscale: serve state reads ours, elsewhere, funnel and off', () => {
  const host = 'h.example.ts.net';
  assert.deepEqual(serveStateFrom({}, host, 7443, SOCK), { kind: 'off' });
  assert.deepEqual(serveStateFrom({ Web: { [`${host}:7443`]: { Handlers: { '/': { Proxy: SOCK } } } } }, host, 7443, SOCK), { kind: 'ours' });
  assert.deepEqual(serveStateFrom({ Web: { [`${host}:7443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } } } }, host, 7443, SOCK), { kind: 'elsewhere', target: 'http://127.0.0.1:1' });
  assert.equal(serveStateFrom({ Web: { [`${host}:7443`]: { Handlers: { '/': { Proxy: SOCK }, '/x': { Path: '/srv' } } } } }, host, 7443, SOCK).kind, 'elsewhere', 'extra handlers on our port');
  assert.equal(serveStateFrom({ TCP: { '7443': {} } }, host, 7443, SOCK).kind, 'elsewhere', 'a raw TCP forward');
  assert.deepEqual(serveStateFrom({ Web: { [`${host}:7443`]: { Handlers: { '/': { Proxy: SOCK } } } }, AllowFunnel: { [`${host}:7443`]: true } }, host, 7443, SOCK), { kind: 'funnel' });
});

test('tailscale: the CLI provider parses status and whois, and refuses to change a port in other use', async () => {
  const calls: string[][] = [];
  const replies: Record<string, string> = {
    'status --json': JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'h.example.ts.net.', ID: 'nSELF', CapMap: { https: null } }, CurrentTailnet: { StableID: 'T1' } }),
    'serve status --json': JSON.stringify({ Web: { 'h.example.ts.net:7443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5000' } } } } }),
    'whois --json 100.64.0.2': JSON.stringify({
      Node: { StableID: 'nPHONE', ComputedName: 'phone', Hostinfo: { OS: 'iOS' }, Addresses: ['100.64.0.2/32'], StableTailnetID: 'T1' },
      UserProfile: { LoginName: 'me@example.com', DisplayName: 'Me' },
    }),
    'whois --json 100.64.0.4': JSON.stringify({ Node: { StableID: 'nSERVER', ComputedName: 'server', Tags: ['tag:server'], StableTailnetID: 'T1' }, UserProfile: { LoginName: 'tagged-devices' } }),
  };
  const cli = new CliTailscale(async (args) => {
    calls.push(args);
    const r = replies[args.join(' ')];
    if (r === undefined) throw new Error(`unexpected command: ${args.join(' ')}`);
    return r;
  });
  assert.deepEqual(await cli.status(), { running: true, dnsName: 'h.example.ts.net', tailnetId: 'T1', selfNodeId: 'nSELF', https: true });
  assert.deepEqual(await cli.whois('100.64.0.2'), { nodeId: 'nPHONE', nodeName: 'phone', os: 'iOS', addresses: ['100.64.0.2'], tagged: false, user: { login: 'me@example.com', name: 'Me' }, tailnetId: 'T1' });
  const t = await cli.whois('100.64.0.4');
  assert.ok(t?.tagged && t.user === undefined);
  assert.equal(await cli.whois('100.64.0.9'), null, 'a failing whois is no identity');
  assert.equal(await cli.whois('100.64.0.2; rm -rf'), null, 'not an address: not even run');
  await assert.rejects(cli.addServe(7443, SOCK), /already in use/);
  await assert.rejects(cli.removeServe(7443, SOCK), /other than Masthead/);
  assert.ok(!calls.some((c) => c[0] === 'serve' && c[1] !== 'status'), 'no command that changes serve config was run');
  assert.equal(identityFrom({}), null);
});

test('tailscale: the CLI provider adds and removes its entry with exactly its own commands', async () => {
  let serve: object = {};
  const changes: string[][] = [];
  const cli = new CliTailscale(async (args) => {
    const a = args.join(' ');
    if (a === 'status --json') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'h.example.ts.net.', ID: 'nSELF' }, CurrentTailnet: { StableID: 'T1' } });
    if (a === 'serve status --json') return JSON.stringify(serve);
    changes.push(args);
    if (args[2] === 'off' || args[1] === '--https=7443') serve = {};
    else serve = { Web: { 'h.example.ts.net:7443': { Handlers: { '/': { Proxy: SOCK } } } } };
    return '';
  });
  await cli.addServe(7443, SOCK);
  await cli.addServe(7443, SOCK);
  await cli.removeServe(7443, SOCK);
  assert.deepEqual(changes, [['serve', '--bg', '--https=7443', SOCK], ['serve', '--https=7443', 'off']]);
});

test('tailscale: whois is cached a minute per address and at most four run at once', async () => {
  let calls = 0;
  let running = 0;
  let peak = 0;
  let clock = 0;
  const inner = new FakeTailscale();
  inner.identities.set('100.64.0.2', phone);
  const slow = Object.assign(Object.create(inner), {
    whois: async (a: string) => {
      calls++;
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return a === '100.64.0.2' ? phone : null;
    },
  });
  const cached = new CachedWhois(slow, { now: () => clock });
  await Promise.all(Array.from({ length: 20 }, () => cached.whois('100.64.0.2')));
  assert.equal(calls, 1, 'twenty requests at once: one lookup');
  await Promise.all(Array.from({ length: 12 }, (_, i) => cached.whois(`100.64.9.${i}`)));
  assert.ok(peak <= 4, `peak ${peak}`);
  clock += 61_000;
  await cached.whois('100.64.0.2');
  assert.equal(calls, 14, 'looked up again after a minute');
});

test('tailscale: anything Masthead does not fully understand counts as in use, never as off', () => {
  const host = 'h.example.ts.net';
  // The real shape on the development machine (2026-11-27), names replaced.
  const real = { TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:1234' } } } } };
  assert.deepEqual(serveStateFrom(real, host, 7443, SOCK), { kind: 'off' });
  assert.equal(serveStateFrom(real, host, 443, SOCK).kind, 'elsewhere');
  assert.equal(serveStateFrom({ ...real, Foreground: { abc: { TCP: {} } } } as never, host, 7443, SOCK).kind, 'elsewhere', 'a foreground session');
  assert.equal(serveStateFrom({ Services: { 'svc:x': {} } } as never, host, 7443, SOCK).kind, 'elsewhere', 'a newer layout');
  assert.equal(serveStateFrom({ Web: { [`${host}:7443`]: { Handlers: 'odd' } } } as never, host, 7443, SOCK).kind, 'elsewhere');
  assert.equal(serveStateFrom({ TCP: { '7443': { TCPForward: '127.0.0.1:22' } } } as never, host, 7443, SOCK).kind, 'elsewhere');
  assert.equal(serveStateFrom(null as never, host, 7443, SOCK).kind, 'elsewhere');
  assert.equal(serveStateFrom({ Foreground: {} } as never, host, 7443, SOCK).kind, 'off', 'an empty key is nothing');
});

test('remote (loopback): a forged first request cannot block the real device; deny locks out that request only', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'masthead-remote-')), 'remote');
  const registry = new DeviceRegistry({ dir, loopback: true });
  const forged = registry.request(phone, '100.64.0.2');
  const real = registry.request(phone, '100.64.0.2');
  assert.ok(!('refused' in forged) && !('refused' in real), 'both may wait');
  assert.notEqual(forged.request.id, real.request.id);
  assert.notEqual(forged.pollSecret, real.pollSecret);
  // The owner sees two cards for "phone"; the code on the phone matches only the real one.
  assert.equal(registry.deny(forged.request.id), true);
  assert.equal(registry.collect(real.request.id, real.pollSecret, phone.nodeId).state, 'pending', 'the real request survives');
  assert.ok(!('refused' in registry.request(phone, '100.64.0.2')), 'no lockout of the device id');
  registry.allow(real.request.id);
  assert.equal(registry.collect(real.request.id, real.pollSecret, phone.nodeId).state, 'allowed');
  // Capped per device even there.
  const many = new DeviceRegistry({ dir: join(dir, 'b'), loopback: true });
  for (let i = 0; i < 3; i++) assert.ok(!('refused' in many.request(laptop, '100.64.0.3')));
  assert.ok('refused' in many.request(laptop, '100.64.0.3'));
});

test('tailscale: a failed whois is not cached', async () => {
  let calls = 0;
  let up = false;
  const inner = new FakeTailscale();
  const flaky = Object.assign(Object.create(inner), { whois: async () => (calls++, up ? phone : null) });
  const cached = new CachedWhois(flaky);
  assert.equal(await cached.whois('100.64.0.2'), null);
  up = true;
  assert.deepEqual(await cached.whois('100.64.0.2'), phone, 'asked again at once after a failure');
  await cached.whois('100.64.0.2');
  assert.equal(calls, 2, 'the answer is cached');
});
