// What the running service uses (Linux, systemd): memory and the processes in its cgroup, which hold
// every agent's children (browsers, MCP servers, shells). And what /tmp is: a small or full RAM-backed
// tmpfs is where agents' temp files used to fill up. Used by `masthead doctor`.
import { readFileSync, statfsSync } from 'node:fs';
import type { RunResult } from './types.js';
import { UNIT } from './systemd.js';

export interface ServiceUsage {
  /** systemd's MemoryCurrent for the unit (the whole cgroup), or null when it does not account it. */
  memoryBytes: number | null;
  /** Processes in the unit's cgroup besides the server itself, or null when they cannot be counted. */
  children: number | null;
}

/** From `systemctl --user show -p ActiveState -p MemoryCurrent -p ControlGroup` output; null when not running. */
export function parseUsageShow(show: string): { memoryBytes: number | null; cgroup: string | null } | null {
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(show)?.[1]?.trim() ?? '';
  if (get('ActiveState') !== 'active') return null;
  const mem = get('MemoryCurrent');
  const cg = get('ControlGroup');
  return { memoryBytes: /^\d+$/.test(mem) ? Number(mem) : null, cgroup: cg.startsWith('/') ? cg : null };
}

export function serviceUsage(
  run: (cmd: string, args: readonly string[]) => RunResult,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): ServiceUsage | null {
  const r = run('systemctl', ['--user', 'show', '-p', 'ActiveState', '-p', 'MemoryCurrent', '-p', 'ControlGroup', UNIT]);
  if (r.status !== 0) return null;
  const u = parseUsageShow(r.stdout);
  if (!u) return null;
  let children: number | null = null;
  if (u.cgroup) {
    try {
      // cgroup v2; the unit has no sub-groups of its own, so this lists all of its processes.
      const procs = readFile(`/sys/fs/cgroup${u.cgroup}/cgroup.procs`).split('\n').filter((l) => /^\d+$/.test(l.trim()));
      children = Math.max(0, procs.length - 1);
    } catch {
      children = null;
    }
  }
  return { memoryBytes: u.memoryBytes, children };
}

export interface TmpInfo {
  path: string;
  fstype: string;
  size: number;
  free: number;
}

/** The file system type of the mount holding `path`, from /proc/mounts text (the longest matching mount point wins). */
export function mountType(mounts: string, path: string): string | null {
  let best: { at: string; type: string } | null = null;
  for (const line of mounts.split('\n')) {
    const [, at, type] = line.split(' ');
    if (!at || !type) continue;
    const point = at.replace(/\\040/g, ' ');
    const inside = point === '/' || path === point || path.startsWith(point + '/');
    if (inside && (!best || point.length >= best.at.length)) best = { at: point, type };
  }
  return best?.type ?? null;
}

/** Linux only: what the system temporary folder is (TMPDIR is ignored: it is about /tmp itself). */
export function tmpInfo(path = '/tmp'): TmpInfo | null {
  try {
    const fstype = mountType(readFileSync('/proc/mounts', 'utf8'), path);
    const s = statfsSync(path);
    return { path, fstype: fstype ?? 'unknown', size: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}
