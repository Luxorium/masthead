// The Codex app-server is started as a process tree and stopped with the whole tree (proctree.ts).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { makeSpawnAppServer } from '../server/backends/codex/cli.ts';
import type { TreeDeps } from '../server/backends/proctree.ts';

function setup(platform: NodeJS.Platform) {
  const c = new EventEmitter() as EventEmitter & Record<string, any>;
  Object.assign(c, { pid: 777, exitCode: null, signalCode: null, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  c.kill = () => true;
  const log: string[] = [];
  const timers: Array<() => void> = [];
  const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const deps: TreeDeps = {
    platform,
    spawn: (command, args, options) => (spawned.push({ command, args, options: options as never }), c as unknown as ChildProcess),
    kill: (pid, sig) => void log.push(`kill ${pid} ${sig}`),
    execFile: (file, args, cb) => (log.push(`${file} ${args.join(' ')}`), cb(null)),
    setTimeout: (fn) => void timers.push(fn),
  };
  return { c, log, timers, spawned, deps };
}

test('codex app-server: POSIX starts it in its own group and kill() ends the group, then SIGKILL', () => {
  const { log, timers, spawned, deps } = setup('linux');
  const proc = makeSpawnAppServer(deps)('/usr/bin/codex', ['app-server', '-c', 'model_catalog_json="/x"'], { PATH: '/usr/bin' });
  assert.equal(spawned[0]!.command, '/usr/bin/codex');
  assert.deepEqual(spawned[0]!.args, ['app-server', '-c', 'model_catalog_json="/x"']);
  assert.equal(spawned[0]!.options.detached, true);
  proc.kill();
  assert.deepEqual(log, ['kill -777 SIGTERM']);
  timers.shift()?.();
  assert.deepEqual(log, ['kill -777 SIGTERM', 'kill -777 SIGKILL']);
});

test('codex app-server: Windows kill() is taskkill of the whole tree; an exit is reported once', () => {
  const { c, log, deps } = setup('win32');
  const proc = makeSpawnAppServer(deps)('codex.exe', ['app-server'], {});
  const exits: string[] = [];
  proc.onExit((d) => exits.push(d));
  proc.kill();
  assert.ok(log.some((l) => /taskkill .*\/T .*\/F .*777|taskkill \/T \/F \/PID 777/.test(l)), log.join('; '));
  c.exitCode = 1;
  c.emit('exit', 1, null);
  c.emit('error', new Error('late'));
  assert.equal(exits.length, 1);
});
