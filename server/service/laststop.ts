// Why the systemd service stopped last time, from the marker its ExecStopPost line writes (systemd.ts
// STOP_POST): "<result> <exit code> <exit status> <oom kills>", e.g. "oom-kill killed TERM 1" or
// "signal killed KILL 1". The server reads it once at start (and removes it) to tell the person plainly
// when the restart came from the computer running out of memory.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const LAST_STOP_FILE = 'masthead-last-stop';

export interface LastStop {
  /** systemd's $SERVICE_RESULT: success, exit-code, signal, oom-kill, timeout, ... */
  result: string;
  /** $EXIT_CODE: exited, killed or dumped. */
  code: string;
  /** $EXIT_STATUS: a number or a signal name (TERM, KILL). */
  status: string;
  /** Out-of-memory kills in the service's cgroup during that run; null when it could not be read. */
  oomKills: number | null;
}

export function parseLastStop(text: string): LastStop | null {
  const [result, code = '', status = '', oom] = text.trim().split(/\s+/);
  if (!result) return null;
  const n = oom !== undefined && /^\d+$/.test(oom) ? Number(oom) : null;
  return { result, code, status, oomKills: n };
}

/**
 * Whether that stop came from the computer running out of memory: systemd says so (a unit with the old
 * default OOMPolicy=stop), or the server itself was killed with SIGKILL while the kernel's OOM killer was
 * at work in its cgroup (OOMPolicy=continue keeps the service when it kills anything else).
 */
export function stoppedForMemory(s: LastStop): boolean {
  return s.result === 'oom-kill' || (s.result === 'signal' && s.status === 'KILL' && (s.oomKills ?? 0) > 0);
}

/** The notice for the person, or null when the last stop needs none. */
export function lastStopNotice(s: LastStop | null): string | null {
  return s && stoppedForMemory(s) ? 'Masthead was restarted because the computer ran out of memory.' : null;
}

/**
 * Reads and removes the marker, so it is reported once. Only under systemd (INVOCATION_ID is set for a
 * unit's processes) and when XDG_RUNTIME_DIR is known; null otherwise or when there is no marker.
 */
export function takeLastStop(env: Record<string, string | undefined> = process.env): LastStop | null {
  if (!env.INVOCATION_ID || !env.XDG_RUNTIME_DIR) return null;
  const file = join(env.XDG_RUNTIME_DIR, LAST_STOP_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  rmSync(file, { force: true });
  return parseLastStop(text);
}
