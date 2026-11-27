// `masthead doctor` with every probe faked.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { doctor, doctorExitCode, formatChecks, sdkBinaryPackage, systemDoctorFs, type Check, type DoctorDeps } from '../server/doctor.ts';
import type { ServiceManager, ServiceStatus } from '../server/service/types.ts';
import { VERSION } from '../shared/protocol.ts';

const paths = { configDir: '/c/masthead', dataDir: '/d/masthead', secretFile: '/d/masthead/secret' };

function svc(status: ServiceStatus | Error): ServiceManager {
  return {
    kind: 'systemd',
    install: async () => [],
    uninstall: async () => [],
    status: async () => {
      if (status instanceof Error) throw status;
      return status;
    },
    serves: () => false,
  };
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    platform: 'linux',
    nodeVersion: '22.12.0',
    findClaude: async () => ({ path: '/u/bin/claude', version: '2.1.0 (Claude Code)' }),
    paths,
    fs: {
      stat: (p) => (p === paths.secretFile ? { isDirectory: false, mode: 0o100600 } : { isDirectory: true, mode: 0o40700 }),
      writable: () => true,
    },
    port: 7720,
    probe: async () => 'free',
    service: svc({ installed: true, running: true, port: 7720, detail: 'masthead.service active, port 7720' }),
    sdkBinary: () => null,
    ...over,
  };
}

const byName = (checks: Check[], prefix: string) => checks.find((c) => c.name.startsWith(prefix))!;

test('doctor: a healthy system passes every check', async () => {
  const checks = await doctor(deps());
  assert.deepEqual(
    checks.map((c) => c.name),
    ['Node.js', 'Claude Code', 'Config folder', 'Data folder', 'Secret', 'Port 7720', 'Service', 'SDK private binary'],
  );
  assert.ok(checks.every((c) => c.ok && !c.warn), formatChecks(checks));
  assert.equal(doctorExitCode(checks), 0);
  assert.match(byName(checks, 'Claude Code').detail, /2\.1\.0 \(Claude Code\) at \/u\/bin\/claude/);
  assert.match(byName(checks, 'Secret').detail, /mode 600/);
});

test('doctor: Node older than 22 fails', async () => {
  const checks = await doctor(deps({ nodeVersion: 'v20.18.0' }));
  const c = byName(checks, 'Node.js');
  assert.equal(c.ok, false);
  assert.match(c.fix!, /22/);
  assert.equal(doctorExitCode(checks), 1);
});

test('doctor: Claude Code missing, broken or throwing fails with a fix', async () => {
  for (const findClaude of [
    async () => ({ path: null, version: null }),
    async () => ({ path: '/x/claude', version: null, error: 'exit code 1' }),
    async () => {
      throw new Error('boom');
    },
  ]) {
    const c = byName(await doctor(deps({ findClaude })), 'Claude Code');
    assert.equal(c.ok, false);
    assert.ok(c.fix);
  }
});

test('doctor: folders that are missing warn, not writable or not a folder fail', async () => {
  const missing = await doctor(deps({ fs: { stat: () => null, writable: () => false } }));
  for (const n of ['Config folder', 'Data folder', 'Secret']) {
    const c = byName(missing, n);
    assert.ok(c.ok && c.warn, n);
  }
  const ro = byName(await doctor(deps({ fs: { stat: () => ({ isDirectory: true, mode: 0o40700 }), writable: (p) => p !== paths.dataDir } })), 'Data folder');
  assert.equal(ro.ok, false);
  assert.match(ro.detail, /not writable/);
  const file = byName(await doctor(deps({ fs: { stat: () => ({ isDirectory: false, mode: 0o100600 }), writable: () => true } })), 'Config folder');
  assert.equal(file.ok, false);
});

test('doctor: a secret others can read fails; on Windows the ACL decides, not the mode', async () => {
  const open = { stat: (p: string) => (p === paths.secretFile ? { isDirectory: false, mode: 0o100644 } : { isDirectory: true, mode: 0o40755 }), writable: () => true };
  const c = byName(await doctor(deps({ fs: open })), 'Secret');
  assert.equal(c.ok, false);
  assert.match(c.detail, /mode 644/);
  assert.match(c.fix!, /replaced with a new one/);
  const winOk = byName(await doctor(deps({ fs: open, platform: 'win32', isPrivate: () => true })), 'Secret');
  assert.ok(winOk.ok && !winOk.warn);
  assert.match(winOk.detail, /only you/);
  const winOpen = byName(await doctor(deps({ fs: open, platform: 'win32', isPrivate: () => false })), 'Secret');
  assert.equal(winOpen.ok, false);
  assert.match(winOpen.fix!, /Delete/);
  const unchecked = byName(await doctor(deps({ fs: open, platform: 'win32' })), 'Secret');
  assert.ok(unchecked.warn, 'without an ACL probe it says so, never "private"');
});

test('doctor: the port is free or ours, else it fails', async () => {
  assert.match(byName(await doctor(deps({ probe: async () => 'ours' })), 'Port').detail, /this Masthead/);
  const other = byName(await doctor(deps({ probe: async () => 'other' })), 'Port');
  assert.equal(other.ok, false);
  assert.match(other.fix!, /--port/);
  let asked = 0;
  await doctor(deps({ probe: async (p) => ((asked = p), 'free') }));
  assert.equal(asked, 7720);
});

test('doctor: the service is reported; stopped fails, missing warns', async () => {
  const stopped = byName(await doctor(deps({ service: svc({ installed: true, running: false, port: 7717, detail: 'failed' }) })), 'Service');
  assert.equal(stopped.ok, false);
  const none = byName(await doctor(deps({ service: svc({ installed: false, running: false, port: null, detail: 'Not installed.' }) })), 'Service');
  assert.ok(none.ok && none.warn);
  assert.equal(none.fix, 'masthead service install');
  // Stock Windows PowerShell refuses masthead.ps1; masthead.cmd works there and in Command Prompt.
  const win = byName(await doctor(deps({ platform: 'win32', service: svc({ installed: false, running: false, port: null, detail: 'Not installed.' }) })), 'Service');
  assert.equal(win.fix, 'masthead.cmd service install');
  const unknown = byName(await doctor(deps({ service: svc({ installed: true, running: null, port: 7717, detail: 'x' }) })), 'Service');
  assert.ok(unknown.ok && unknown.warn);
  const err = byName(await doctor(deps({ service: svc(new Error('no bus')) })), 'Service');
  assert.match(err.detail, /no bus/);
  const platform = byName(await doctor(deps({ service: null, platform: 'freebsd' })), 'Service');
  assert.ok(platform.ok && platform.warn);
});

test('doctor: the SDK private binary package warns with the reinstall fix', async () => {
  const c = byName(await doctor(deps({ sdkBinary: () => '/g/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64' })), 'SDK');
  assert.ok(c.ok && c.warn);
  // npm ignores --omit=optional for a global install; --os=none --cpu=none skips the platform package.
  // Masthead is not on the npm registry: the fix names this version's release tarball.
  assert.ok(c.fix!.endsWith(`npm i -g --os=none --cpu=none https://github.com/Luxorium/masthead/releases/download/v${VERSION}/luxorium-masthead-${VERSION}.tgz`), c.fix);
  assert.ok(!c.fix!.includes('@luxorium'));
  // The resolver tries <platform>-<arch>, then the musl build.
  const asked: string[] = [];
  const found = sdkBinaryPackage('linux', 'arm64', (id) => {
    asked.push(id);
    if (id.includes('musl')) return '/m/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/package.json';
    throw new Error('not found');
  });
  assert.equal(found, '/m/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl');
  assert.deepEqual(asked, ['@anthropic-ai/claude-agent-sdk-linux-arm64/package.json', '@anthropic-ai/claude-agent-sdk-linux-arm64-musl/package.json']);
  assert.equal(sdkBinaryPackage('darwin', 'x64', () => { throw new Error('x'); }), null);
});

test('doctor: format shows one line per check and the fix for problems', () => {
  const text = formatChecks([
    { name: 'A', ok: true, detail: 'fine', fix: 'never shown' },
    { name: 'B', ok: true, warn: true, detail: 'hm', fix: 'do b' },
    { name: 'C', ok: false, detail: 'bad', fix: 'do c' },
  ]);
  assert.equal(text, '[ OK ] A: fine\n[WARN] B: hm\n       fix: do b\n[FAIL] C: bad\n       fix: do c');
  assert.equal(doctorExitCode([{ name: 'B', ok: true, warn: true, detail: '' }]), 0, 'warnings do not fail');
});

test('doctor: the real file system helper reads modes and writability', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'masthead-doctor-'));
  const f = join(dir, 'secret');
  writeFileSync(f, 'x');
  chmodSync(f, 0o600);
  assert.equal(systemDoctorFs.stat(f)!.mode & 0o777, 0o600);
  assert.equal(systemDoctorFs.stat(dir)!.isDirectory, true);
  assert.equal(systemDoctorFs.writable(dir), true);
  assert.equal(systemDoctorFs.stat(join(dir, 'missing')), null);
});

test('doctor: says whether the computer can be kept awake, as a warning at most', async () => {
  const ok = byName(await doctor(deps({ awakeTool: () => ({ cmd: 'systemd-inhibit', found: true }) })), 'Keep awake');
  assert.ok(ok.ok && !ok.warn);
  const missing = byName(await doctor(deps({ awakeTool: () => ({ cmd: 'systemd-inhibit', found: false }) })), 'Keep awake');
  assert.ok(missing.ok && missing.warn, 'a missing tool never fails doctor');
  assert.match(missing.detail, /may sleep/);
  const none = byName(await doctor(deps({ platform: 'freebsd', awakeTool: () => ({ cmd: null, found: false }) })), 'Keep awake');
  assert.ok(none.warn);
  assert.equal(doctorExitCode(await doctor(deps({ awakeTool: () => ({ cmd: 'caffeinate', found: false }) }))), 0);
  assert.equal(byName(await doctor(deps()), 'Keep awake'), undefined, 'not checked when no probe is given');
});
