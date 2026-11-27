// The out-of-memory restart notice, the per-conversation scratch folders and the doctor's memory and /tmp
// checks. Nothing here runs systemctl; files go to a fresh temporary folder.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { doctor, type DoctorDeps } from '../server/doctor.ts';
import { LAST_STOP_FILE, lastStopNotice, parseLastStop, takeLastStop } from '../server/service/laststop.ts';
import { WALK_MAX_DEPTH, WALK_MAX_ENTRIES, ensureScratch, newestChange, removeScratch, scratchDir, scratchEnv, scratchRoot, sweepScratch } from '../server/service/scratch.ts';
import { mountType, parseUsageShow, serviceUsage } from '../server/service/usage.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'masthead-health-'));

test('last stop: only an out-of-memory stop gives a notice', () => {
  const notice = (t: string) => lastStopNotice(parseLastStop(t));
  // Seen with real systemd units (OOMPolicy=stop, then continue with the main process killed, then a plain stop).
  assert.equal(notice('oom-kill killed TERM 1\n'), 'Masthead was restarted because the computer ran out of memory.');
  assert.match(notice('signal killed KILL 1') ?? '', /ran out of memory/);
  assert.equal(notice('signal killed KILL 0'), null, 'a SIGKILL without an OOM kill is not blamed on memory');
  assert.equal(notice('signal killed KILL'), null);
  assert.equal(notice('success killed TERM 1'), null, 'a clean stop after an agent process was OOM-killed');
  assert.equal(notice('exit-code exited 1 0'), null);
  assert.equal(notice(''), null);
  assert.deepEqual(parseLastStop('signal killed KILL 3'), { result: 'signal', code: 'killed', status: 'KILL', oomKills: 3 });
});

test('last stop: the marker is read once, and only under systemd', () => {
  const dir = temp();
  try {
    writeFileSync(join(dir, LAST_STOP_FILE), 'oom-kill killed TERM 2\n');
    assert.equal(takeLastStop({ XDG_RUNTIME_DIR: dir }), null, 'not a systemd service: left alone');
    assert.ok(existsSync(join(dir, LAST_STOP_FILE)));
    assert.equal(takeLastStop({ XDG_RUNTIME_DIR: dir, INVOCATION_ID: 'x' })?.result, 'oom-kill');
    assert.ok(!existsSync(join(dir, LAST_STOP_FILE)), 'removed after reading');
    assert.equal(takeLastStop({ XDG_RUNTIME_DIR: dir, INVOCATION_ID: 'x' }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scratch: the root per platform, and MASTHEAD_DATA_DIR keeps it with the data', () => {
  assert.equal(scratchRoot('linux', {}, '/h', '/d'), '/h/.cache/masthead/scratch');
  assert.equal(scratchRoot('linux', { XDG_CACHE_HOME: '/c' }, '/h', '/d'), '/c/masthead/scratch');
  assert.equal(scratchRoot('linux', { MASTHEAD_DATA_DIR: '/d' }, '/h', '/d'), '/d/scratch');
  assert.equal(scratchRoot('darwin', {}, '/Users/a', '/d'), '/Users/a/Library/Caches/Masthead/scratch');
  assert.equal(scratchRoot('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\U', 'C:\\d'), 'C:\\L\\Masthead\\Cache\\scratch');
  assert.throws(() => scratchDir('/r', '../x', 'linux'), /not a conversation id/);
  assert.throws(() => scratchDir('/r', '', 'linux'), /not a conversation id/);
  assert.deepEqual(scratchEnv('/r/a', 'linux'), { TMPDIR: '/r/a', CLAUDE_CODE_TMPDIR: '/r/a' });
  assert.deepEqual(scratchEnv('C:\\r\\a', 'win32'), { TMPDIR: 'C:\\r\\a', CLAUDE_CODE_TMPDIR: 'C:\\r\\a', TMP: 'C:\\r\\a', TEMP: 'C:\\r\\a' });
});

test('scratch: made private, removed with the conversation, swept when gone or old', () => {
  const root = join(temp(), 'scratch');
  try {
    const a = ensureScratch(root, 'conv-a');
    if (process.platform !== 'win32') assert.equal(statSync(a).mode & 0o777, 0o700);
    mkdirSync(join(a, 'chromium-profile', 'Default'), { recursive: true });
    writeFileSync(join(a, 'chromium-profile', 'Default', 'x'), 'x');
    removeScratch(root, 'conv-a');
    assert.ok(!existsSync(a));
    removeScratch(root, 'conv-a'); // nothing there: no error

    const now = Date.now();
    for (const id of ['live', 'gone', 'old', 'oldbusy']) ensureScratch(root, id);
    const past = new Date(now - 10 * 86_400_000);
    utimesSync(join(root, 'old'), past, past);
    utimesSync(join(root, 'oldbusy'), past, past);
    mkdirSync(join(root, 'not an id'));
    const removed = sweepScratch(root, { exists: (id) => id !== 'gone', busy: (id) => id === 'oldbusy', now });
    assert.deepEqual(removed.sort(), ['gone', 'old']);
    assert.ok(existsSync(join(root, 'live')) && existsSync(join(root, 'oldbusy')) && existsSync(join(root, 'not an id')));
    assert.deepEqual(sweepScratch(join(root, 'missing'), { exists: () => true }), []);
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('scratch: files written deep inside keep a folder, and so does recent activity in its conversation', () => {
  const root = join(temp(), 'scratch');
  try {
    const now = Date.now();
    const past = new Date(now - 10 * 86_400_000);
    const age = (p: string) => utimesSync(p, past, past);
    // A browser profile in use: only a file three levels down changed recently.
    const deep = ensureScratch(root, 'deep');
    mkdirSync(join(deep, 'profile', 'Default', 'Cache'), { recursive: true });
    writeFileSync(join(deep, 'profile', 'Default', 'Cache', 'f'), 'x');
    for (const p of [join(deep, 'profile', 'Default', 'Cache'), join(deep, 'profile', 'Default'), join(deep, 'profile'), deep]) age(p);
    // Nothing changed inside for 10 days, but the conversation was used yesterday.
    const used = ensureScratch(root, 'used');
    writeFileSync(join(used, 'f'), 'x');
    age(join(used, 'f'));
    age(used);
    // Neither: swept.
    const stale = ensureScratch(root, 'stale');
    writeFileSync(join(stale, 'f'), 'x');
    age(join(stale, 'f'));
    age(stale);
    const removed = sweepScratch(root, { exists: () => true, activeAt: (id) => (id === 'used' ? now - 86_400_000 : now - 30 * 86_400_000), now });
    assert.deepEqual(removed, ['stale']);
    assert.ok(existsSync(deep) && existsSync(used));
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('scratch: the walk is bounded; a folder past its limits counts as changed now', () => {
  const root = join(temp(), 'scratch');
  try {
    const now = Date.now();
    const past = new Date(now - 10 * 86_400_000);
    const wide = ensureScratch(root, 'wide');
    for (let i = 0; i <= WALK_MAX_ENTRIES; i++) writeFileSync(join(wide, `f${i}`), '');
    assert.equal(newestChange(wide, now), now, 'too many entries');
    let d = ensureScratch(root, 'tall');
    for (let i = 0; i <= WALK_MAX_DEPTH; i++) d = join(d, 'd');
    mkdirSync(d, { recursive: true });
    assert.equal(newestChange(join(root, 'tall'), now), now, 'too deep');
    const small = ensureScratch(root, 'small');
    writeFileSync(join(small, 'f'), '');
    utimesSync(join(small, 'f'), past, past);
    utimesSync(small, past, past);
    assert.ok(Math.abs(newestChange(small, now) - past.getTime()) < 1000);
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('scratch: a scratch folder that is a link is kept, and its target is never walked or removed', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const base = temp();
  const root = join(base, 'scratch');
  try {
    const now = Date.now();
    const past = new Date(now - 30 * 86_400_000);
    const target = join(base, 'elsewhere');
    mkdirSync(target);
    writeFileSync(join(target, 'keep-me'), 'x');
    utimesSync(join(target, 'keep-me'), past, past);
    utimesSync(target, past, past);
    mkdirSync(root);
    symlinkSync(target, join(root, 'linked'));
    assert.equal(newestChange(join(root, 'linked'), now), now, 'a link counts as changed now');
    assert.deepEqual(sweepScratch(root, { exists: () => true, activeAt: () => now - 30 * 86_400_000, now }), []);
    assert.ok(lstatSync(join(root, 'linked')).isSymbolicLink());
    // A link whose conversation is gone: the link goes, never what it points to.
    assert.deepEqual(sweepScratch(root, { exists: () => false, now }), ['linked']);
    assert.ok(existsSync(join(target, 'keep-me')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('usage: systemctl show and the cgroup give memory and child processes', () => {
  assert.equal(parseUsageShow('ActiveState=inactive\nMemoryCurrent=[not set]\nControlGroup=\n'), null);
  assert.deepEqual(parseUsageShow('ActiveState=active\nMemoryCurrent=[not set]\nControlGroup=\n'), { memoryBytes: null, cgroup: null });
  const run = () => ({ status: 0, stdout: 'ActiveState=active\nMemoryCurrent=3971000000\nControlGroup=/user.slice/m.service\n', stderr: '' });
  const files: Record<string, string> = { '/sys/fs/cgroup/user.slice/m.service/cgroup.procs': '10\n11\n12\n' };
  assert.deepEqual(serviceUsage(run, (p) => files[p] ?? (() => { throw new Error('ENOENT'); })()), { memoryBytes: 3971000000, children: 2 });
  assert.deepEqual(serviceUsage(run, () => { throw new Error('ENOENT'); }), { memoryBytes: 3971000000, children: null });
  assert.equal(serviceUsage(() => ({ status: 1, stdout: '', stderr: 'no bus' })), null);
});

test('usage: the mount type of /tmp is the longest matching mount point', () => {
  const mounts = 'sysfs /sys sysfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\ntmpfs /tmp tmpfs rw,size=1g 0 0\ntmpfs /tmpx tmpfs rw 0 0\n';
  assert.equal(mountType(mounts, '/tmp'), 'tmpfs');
  assert.equal(mountType('/dev/sda1 / ext4 rw 0 0\n', '/tmp'), 'ext4');
  assert.equal(mountType(mounts, '/tmpy'), 'ext4');
});

const GB = 1024 ** 3;
function deps(extra: Partial<DoctorDeps>): DoctorDeps {
  return {
    platform: 'linux',
    nodeVersion: '24.0.0',
    findClaude: async () => ({ path: '/c', version: '2' }),
    paths: { configDir: '/c', dataDir: '/d', secretFile: '/d/secret' },
    fs: { stat: () => null, writable: () => true },
    port: 7803,
    probe: async () => 'free',
    service: null,
    sdkBinary: () => null,
    ...extra,
  };
}
const find = async (d: DoctorDeps, name: string) => (await doctor(d)).find((c) => c.name === name);

test('doctor: service memory is a warning from half the RAM, with the child processes', async () => {
  const low = await find(deps({ totalMemory: 8 * GB, serviceUsage: () => ({ memoryBytes: 2 * GB, children: 130 }) }), 'Service memory');
  assert.deepEqual([low?.ok, low?.warn, low?.detail], [true, undefined, "2.0 GB of 8.0 GB RAM, 130 child processes (agents' tools and browsers)"]);
  const high = await find(deps({ totalMemory: 7.7 * GB, serviceUsage: () => ({ memoryBytes: 3.9 * GB, children: 130 }) }), 'Service memory');
  assert.equal(high?.warn, true);
  assert.match(high?.detail ?? '', /^3\.9 GB of 7\.7 GB RAM, 130 child processes .*: high/);
  assert.equal(await find(deps({ totalMemory: 8 * GB, serviceUsage: () => null }), 'Service memory'), undefined, 'not running: no line');
  assert.equal(await find(deps({ totalMemory: 8 * GB }), 'Service memory'), undefined);
});

test('doctor: a small or nearly full tmpfs /tmp is a warning; a disk /tmp says nothing', async () => {
  const tmp = (fstype: string, size: number, free: number) => deps({ tmp: () => ({ path: '/tmp', fstype, size, free }) });
  assert.equal((await find(tmp('tmpfs', 16 * GB, 10 * GB), 'Temporary folder'))?.warn, undefined);
  assert.match((await find(tmp('tmpfs', 16 * GB, 1 * GB), 'Temporary folder'))?.detail ?? '', /nearly full/);
  assert.match((await find(tmp('tmpfs', 1 * GB, 0.9 * GB), 'Temporary folder'))?.detail ?? '', /: small$/);
  assert.equal(await find(tmp('ext4', 1 * GB, 0), 'Temporary folder'), undefined);
});
