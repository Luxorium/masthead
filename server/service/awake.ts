// Keeps the computer from falling asleep on its own while agents are working.
//
// Only IDLE sleep is held off: closing the lid, pressing the power button or choosing Suspend still
// work, and the screen may still turn off. The hold is a child process that lives exactly as long as
// it is needed; each one ends by itself when Masthead's server exits, even if it crashes:
// - Linux:   systemd-inhibit --what=idle … cat   (cat ends when our end of its stdin closes)
// - macOS:   caffeinate -i -w <server pid>        (ends when the server process is gone)
// - Windows: PowerShell calling SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED), then
//            waiting on stdin (ends when our end closes). ES_SYSTEM_REQUIRED keeps the system from
//            idling to sleep; it does not keep the display on and does not block an explicit sleep.
// If the tool is missing or refuses, Masthead carries on without it; `masthead doctor` reports it.

import { spawn, type ChildProcess } from 'node:child_process';

/** How long after the last agent stops working the hold is released, so short gaps do not flap it. */
export const RELEASE_AFTER_MS = 5_000;

export interface AwakeCommand {
  cmd: string;
  args: string[];
}

/** The command that holds off idle sleep on `platform`, or null where Masthead has none. */
export function awakeCommand(platform: NodeJS.Platform, pid: number): AwakeCommand | null {
  if (platform === 'linux') {
    return {
      cmd: 'systemd-inhibit',
      args: ['--what=idle', '--who=Masthead', '--why=Agents are working', '--mode=block', 'cat'],
    };
  }
  if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'win32') {
    const script = [
      "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
      "$k = Add-Type -MemberDefinition $sig -Name Power -Namespace Masthead -PassThru",
      // ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
      'if ($k::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 3 }',
      '[Console]::In.ReadToEnd() | Out-Null',
    ].join('; ');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script] };
  }
  return null;
}

/** Starts a child; tests pass their own. */
export type Spawner = (cmd: string, args: string[]) => ChildProcess;
const realSpawner: Spawner = (cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });

export type AwakeState = 'off' | 'holding' | 'unavailable';

export interface AwakeStatus {
  state: AwakeState;
  /** What happened last time it could not hold, in plain words. */
  detail: string;
}

export interface AwakeOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  spawner?: Spawner;
  releaseAfterMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * Hold or release the idle-sleep hold with `set(working)`; `stop()` on shutdown. A hold that fails is
 * not retried until work starts again, so a missing tool costs one attempt per busy period.
 */
export class Awake {
  private child: ChildProcess | null = null;
  private releaseTimer: unknown = null;
  private wanted = false;
  private lastError = '';
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly spawner: Spawner;
  private readonly releaseAfterMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(o: AwakeOptions = {}) {
    this.platform = o.platform ?? process.platform;
    this.pid = o.pid ?? process.pid;
    this.spawner = o.spawner ?? realSpawner;
    this.releaseAfterMs = o.releaseAfterMs ?? RELEASE_AFTER_MS;
    this.setTimer =
      o.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** Agents are working (true) or everything is idle (false). Calling it repeatedly is fine. */
  set(working: boolean): void {
    if (working) {
      if (this.releaseTimer !== null) {
        this.clearTimer(this.releaseTimer);
        this.releaseTimer = null;
      }
      if (!this.wanted) {
        this.wanted = true;
        this.hold();
      }
      return;
    }
    if (!this.wanted || this.releaseTimer !== null) return;
    this.releaseTimer = this.setTimer(() => {
      this.releaseTimer = null;
      this.wanted = false;
      this.release();
    }, this.releaseAfterMs);
  }

  /** Releases at once (server shutdown, or the setting switched off). */
  stop(): void {
    if (this.releaseTimer !== null) this.clearTimer(this.releaseTimer);
    this.releaseTimer = null;
    this.wanted = false;
    this.release();
  }

  status(): AwakeStatus {
    if (this.child) return { state: 'holding', detail: 'Holding off idle sleep while agents work.' };
    if (this.lastError) return { state: 'unavailable', detail: this.lastError };
    return { state: 'off', detail: 'Nothing is working, so nothing is held.' };
  }

  private hold(): void {
    if (this.child) return;
    const c = awakeCommand(this.platform, this.pid);
    if (!c) {
      this.lastError = `Keeping the computer awake is not supported on ${this.platform}.`;
      return;
    }
    let child: ChildProcess;
    try {
      child = this.spawner(c.cmd, c.args);
    } catch (e) {
      this.lastError = `Could not start ${c.cmd}: ${(e as Error).message}`;
      return;
    }
    this.child = child;
    this.lastError = '';
    child.on('error', (e) => {
      this.lastError = `Could not start ${c.cmd}: ${e.message}`;
      if (this.child === child) this.child = null;
    });
    child.on('exit', (code) => {
      if (this.child !== child) return; // released on purpose
      this.child = null;
      // It ended while still wanted: the tool refused (no logind, policy) or was killed.
      this.lastError = `${c.cmd} ended (exit ${code ?? 'signal'}); the computer may sleep while agents work.`;
    });
  }

  private release(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin?.end(); // Linux and Windows end when their stdin closes
    } catch {
      // already closed
    }
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}
