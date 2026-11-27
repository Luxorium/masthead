// Keeping the computer awake while agents work: the commands per platform and when they are held.
// A fake spawner stands in for systemd-inhibit, caffeinate and PowerShell; nothing real is started.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { Awake, awakeCommand } from '../server/service/awake.ts';

class FakeChild extends EventEmitter {
  killed = false;
  stdinEnded = false;
  stdin = { end: () => void (this.stdinEnded = true) };
  kill() {
    this.killed = true;
    return true;
  }
}

function setup(platform: NodeJS.Platform, opts: { throws?: boolean } = {}) {
  const started: Array<{ cmd: string; args: string[]; child: FakeChild }> = [];
  const timers: Array<{ fn: () => void; cleared: boolean }> = [];
  const awake = new Awake({
    platform,
    pid: 4242,
    spawner: (cmd, args) => {
      if (opts.throws) throw new Error('ENOENT');
      const child = new FakeChild();
      started.push({ cmd, args, child });
      return child as unknown as ChildProcess;
    },
    setTimer: (fn) => {
      const t = { fn, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => void ((t as { cleared: boolean }).cleared = true),
  });
  const fire = () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
  };
  return { awake, started, fire };
}

test('awake: only idle sleep is held, with a tool that ends with the server', () => {
  const linux = awakeCommand('linux', 1)!;
  assert.equal(linux.cmd, 'systemd-inhibit');
  assert.ok(linux.args.includes('--what=idle'), 'idle only: lid close and an explicit suspend still work');
  assert.ok(!linux.args.some((a) => /sleep|shutdown|handle-lid/.test(a) && a.startsWith('--what')));
  assert.equal(linux.args.at(-1), 'cat', 'held by cat, which ends when the server closes its stdin');
  assert.deepEqual(awakeCommand('darwin', 4242), { cmd: 'caffeinate', args: ['-i', '-w', '4242'] }, '-i is idle sleep only, not the display (-d)');
  const win = awakeCommand('win32', 1)!;
  assert.equal(win.cmd, 'powershell.exe');
  const script = win.args.at(-1)!;
  assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483649\)/, 'ES_CONTINUOUS | ES_SYSTEM_REQUIRED');
  assert.doesNotMatch(script, /2147483651|ES_DISPLAY/, 'never ES_DISPLAY_REQUIRED');
  assert.match(script, /ReadToEnd/, 'waits on stdin, so it ends with the server');
  assert.equal(awakeCommand('freebsd', 1), null);
});

for (const platform of ['linux', 'darwin', 'win32'] as const) {
  test(`awake (${platform}): held while working, released a few seconds after, once`, () => {
    const { awake, started, fire } = setup(platform);
    assert.equal(awake.status().state, 'off');
    awake.set(true);
    awake.set(true);
    assert.equal(started.length, 1, 'one hold however often it is asked');
    assert.equal(awake.status().state, 'holding');
    awake.set(false);
    assert.equal(started[0]!.child.killed, false, 'not released at once');
    awake.set(true); // work again within the delay: the release is called off
    fire();
    assert.equal(started[0]!.child.killed, false);
    awake.set(false);
    fire();
    assert.equal(started[0]!.child.killed, true);
    assert.equal(started[0]!.child.stdinEnded, true);
    assert.equal(awake.status().state, 'off');
    awake.set(true);
    assert.equal(started.length, 2, 'held again when work starts again');
    awake.stop();
    assert.equal(started[1]!.child.killed, true, 'stop releases at once');
  });
}

test('awake: a missing or refusing tool is reported, never thrown, and retried only with new work', () => {
  const missing = setup('linux', { throws: true });
  missing.awake.set(true);
  assert.equal(missing.awake.status().state, 'unavailable');
  assert.match(missing.awake.status().detail, /systemd-inhibit/);

  const { awake, started } = setup('darwin');
  awake.set(true);
  started[0]!.child.emit('error', new Error('spawn caffeinate ENOENT'));
  assert.equal(awake.status().state, 'unavailable');
  awake.set(true);
  assert.equal(started.length, 1, 'not retried during the same busy period');

  const refused = setup('linux');
  refused.awake.set(true);
  refused.started[0]!.child.emit('exit', 1);
  assert.equal(refused.awake.status().state, 'unavailable');
  assert.match(refused.awake.status().detail, /exit 1/);

  const none = setup('freebsd');
  none.awake.set(true);
  assert.equal(none.awake.status().state, 'unavailable');
  assert.equal(none.started.length, 0);
});
