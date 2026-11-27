import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { killTree, spawnTree, type TreeDeps } from '../server/backends/proctree.ts';
import { ClaudeBackend } from '../server/backends/claude/session.ts';
import { Recorder, spec } from './backend-conformance.ts';

function fakeChild(pid = 4242) {
  const c = new EventEmitter() as EventEmitter & Record<string, any>;
  Object.assign(c, { pid, exitCode: null, signalCode: null, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  c.kill = (sig?: string) => ((c.killedWith = sig ?? 'SIGTERM'), true);
  c.exit = (code: number) => ((c.exitCode = code), c.emit('exit', code, null));
  return c as unknown as ChildProcess & { exit(code: number): void; killedWith?: string };
}

function deps(platform: NodeJS.Platform, child = fakeChild()) {
  const log: string[] = [];
  const timers: Array<() => void> = [];
  const spawnedWith: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const d: TreeDeps = {
    platform,
    spawn: (command, args, options) => (spawnedWith.push({ command, args, options: options as never }), child),
    kill: (pid, sig) => void log.push(`kill ${pid} ${sig}`),
    execFile: (file, args, cb) => (log.push(`${file} ${args.join(' ')}`), cb(null)),
    setTimeout: (fn) => void timers.push(fn),
  };
  return { d, log, timers, child, spawnedWith };
}

test('process tree: POSIX gets its own group; a stop is SIGTERM to the group, then SIGKILL after the grace time', () => {
  const { d, log, timers, child, spawnedWith } = deps('linux');
  spawnTree('claude', ['--x'], { stdio: 'pipe' }, d);
  assert.equal(spawnedWith[0]!.options.detached, true);
  killTree(child, d);
  assert.deepEqual(log, ['kill -4242 SIGTERM']);
  timers.shift()!();
  assert.deepEqual(log, ['kill -4242 SIGTERM', 'kill -4242 SIGKILL']);
});

test('process tree: no SIGKILL when it exits within the grace time; nothing at all once it has exited', () => {
  const a = deps('darwin');
  killTree(a.child, a.d);
  a.child.exit(0);
  a.timers.shift()!();
  assert.deepEqual(a.log, ['kill -4242 SIGTERM']);
  const b = deps('linux');
  b.child.exit(0);
  killTree(b.child, b.d);
  assert.deepEqual(b.log, [], 'a clean exit is left alone');
});

test('process tree: Windows ends the whole tree with taskkill /T /F', () => {
  const { d, log, child, spawnedWith } = deps('win32');
  spawnTree('claude.exe', [], {}, d);
  assert.equal(spawnedWith[0]!.options.detached, undefined, 'no detached console window on Windows');
  killTree(child, d);
  assert.deepEqual(log, ['taskkill /T /F /PID 4242']);
});

test('claude adapter: Claude Code is started through the tree spawner; the SDK kill ends the tree; stderr still reaches the missing-session check', async () => {
  const { d, log, child } = deps('linux');
  let options: Options | undefined;
  let fail: (e: Error) => void = () => {};
  const query = ((args: { options: Options }) => {
    options = args.options;
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((_, rej) => (fail = rej));
      },
      close() {},
    };
  }) as never;
  const backend = new ClaudeBackend({ path: '/fake/claude', query, treeDeps: d });
  const r = new Recorder();
  backend.open(spec({ model: 'm', resume: 'gone-session' }), r);
  assert.ok(options?.spawnClaudeCodeProcess, 'the adapter spawns Claude Code itself');
  const abort = new AbortController();
  const p = options!.spawnClaudeCodeProcess!({ command: '/fake/claude', args: ['--print'], cwd: '/tmp', env: {}, signal: abort.signal });
  assert.equal(p.stdout, child.stdout);
  child.stderr!.write('No conversation found with session ID: gone-session\n');
  await new Promise((res) => setTimeout(res, 5));
  p.kill('SIGTERM');
  assert.deepEqual(log, ['kill -4242 SIGTERM']);
  fail(new Error('Claude Code process exited with code 1'));
  await r.until('exited', () => r.exitedWith !== null, 2000);
  assert.equal(r.exitedWith!.sessionMissing, true, 'stderr read from our own spawn feeds the check');
});
