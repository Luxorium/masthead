/**
 * Starting a CLI so that stopping it also stops the commands it started. Ending only the CLI leaves its
 * children behind on Windows (TerminateProcess never touches children; there are no process groups), and
 * on POSIX a child that ignores its parent's end keeps running. So:
 * - POSIX: the CLI gets its own process group (detached); a stop sends SIGTERM to the whole group, then
 *   SIGKILL if it has not exited after a grace time.
 * - Windows: a stop runs `taskkill /T /F /PID <pid>`, which ends the whole tree.
 * A process that has already exited on its own is left alone, so a clean exit behaves as before.
 * Verified on Linux only; Windows needs a real check (delta's release checklist).
 */
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface TreeDeps {
  platform: NodeJS.Platform;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** process.kill: a negative pid signals the process group. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  execFile: (file: string, args: string[], cb: (error: Error | null) => void) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
}

export const realTreeDeps: TreeDeps = {
  platform: process.platform,
  spawn: (c, a, o) => spawn(c, a, o),
  kill: (pid, signal) => process.kill(pid, signal),
  execFile: (file, args, cb) => void execFile(file, args, { windowsHide: true }, (e) => cb(e)),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
};

export const KILL_GRACE_MS = 3_000;

/** Spawns `command` so that killTree() can end it with everything it started. */
export function spawnTree(command: string, args: string[], options: SpawnOptions, deps: TreeDeps = realTreeDeps): ChildProcess {
  const posix = deps.platform !== 'win32';
  return deps.spawn(command, args, { ...options, windowsHide: true, ...(posix ? { detached: true } : {}) });
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Ends the process tree of a child started with spawnTree(). Does nothing once the child has exited. */
export function killTree(child: ChildProcess, deps: TreeDeps = realTreeDeps, graceMs = KILL_GRACE_MS): void {
  const pid = child.pid;
  if (pid === undefined || exited(child)) return;
  if (deps.platform === 'win32') {
    deps.execFile('taskkill', ['/T', '/F', '/PID', String(pid)], (error) => {
      // taskkill failed (already gone, or not allowed): fall back to ending the process itself.
      if (error && !exited(child)) child.kill();
    });
    return;
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      deps.kill(-pid, sig);
    } catch {
      // The group is gone already; make sure the process itself is too.
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    }
  };
  signal('SIGTERM');
  deps.setTimeout(() => {
    if (!exited(child)) signal('SIGKILL');
  }, graceMs);
}
