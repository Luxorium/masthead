// A private scratch folder per conversation, on disk, handed to agents as their temporary folder
// (TMPDIR, TMP/TEMP, and CLAUDE_CODE_TMPDIR, which Claude Code documents for its own temp files; it adds
// claude-<uid> under it). Agents' temp files and browser profiles then land here instead of /tmp, which
// is often a small RAM-backed tmpfs, and Masthead removes them: with the conversation, and at start for
// folders untouched for SCRATCH_MAX_AGE_DAYS. Claude Code's safety check refuses many `rm -rf` an agent
// tries on its own temp folders, so the cleaning has to be Masthead's.
import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export const SCRATCH_MAX_AGE_DAYS = 7;

/**
 * The folder holding every conversation's scratch: the cache folder (not backed up, not roaming),
 * or <data>/scratch when MASTHEAD_DATA_DIR is set (tests and custom set-ups keep everything together).
 */
export function scratchRoot(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string, dataDir: string): string {
  const p = platform === 'win32' ? win32 : posix;
  if (env.MASTHEAD_DATA_DIR) return p.join(dataDir, 'scratch');
  if (platform === 'darwin') return p.join(home, 'Library', 'Caches', 'Masthead', 'scratch');
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'Masthead', 'Cache', 'scratch');
  return p.join(env.XDG_CACHE_HOME || p.join(home, '.cache'), 'masthead', 'scratch');
}

/** A conversation id as a folder name: refuses anything that could leave the root. */
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`not a conversation id: ${JSON.stringify(id)}`);
  return id;
}

export function scratchDir(root: string, conversationId: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? win32 : posix).join(root, safeId(conversationId));
}

/** Makes the conversation's scratch folder (owner only) and returns its path. */
export function ensureScratch(root: string, conversationId: string, platform: NodeJS.Platform = process.platform): string {
  const dir = scratchDir(root, conversationId, platform);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The variables an agent's process gets so its temporary files go to `dir`. */
export function scratchEnv(dir: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = { TMPDIR: dir, CLAUDE_CODE_TMPDIR: dir };
  if (platform === 'win32') Object.assign(env, { TMP: dir, TEMP: dir });
  return env;
}

/** Removes a conversation's scratch folder; nothing happens when there is none. */
export function removeScratch(root: string, conversationId: string, platform: NodeJS.Platform = process.platform): void {
  rmSync(scratchDir(root, conversationId, platform), { recursive: true, force: true, maxRetries: 3 });
}

/** How far `newestChange` looks: at most this many entries, this many levels down. */
export const WALK_MAX_ENTRIES = 2000;
export const WALK_MAX_DEPTH = 4;

/**
 * The newest modification time in a folder: the folder itself and what lies in it, walked breadth-first up
 * to WALK_MAX_ENTRIES entries and WALK_MAX_DEPTH levels (symbolic links are not followed), so a huge
 * browser profile cannot stall start-up. A folder whose limit was reached, or that is itself a link, counts
 * as changed `now`: it is kept rather than judged on part of its contents or on what it points to.
 */
export function newestChange(dir: string, now: number, platform: NodeJS.Platform = process.platform): number {
  const p = platform === 'win32' ? win32 : posix;
  // A scratch folder that is itself a link (not one Masthead made) is never judged by what it points to: kept.
  const top = lstatSync(dir);
  if (top.isSymbolicLink()) return now;
  let newest = top.mtimeMs;
  let seen = 0;
  let level: string[] = [dir];
  for (let depth = 0; depth < WALK_MAX_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const d of level) {
      let names: string[];
      try {
        names = readdirSync(d);
      } catch {
        continue;
      }
      for (const n of names) {
        if (++seen > WALK_MAX_ENTRIES) return now;
        try {
          const st = lstatSync(p.join(d, n));
          if (st.mtimeMs > newest) newest = st.mtimeMs;
          if (st.isDirectory()) next.push(p.join(d, n));
        } catch {
          // gone meanwhile
        }
      }
    }
    level = next;
  }
  if (level.length) return now; // deeper than the walk looks: keep it
  return newest;
}

/**
 * At start: removes scratch folders whose conversation is gone (`exists` says no), and those of a
 * conversation neither active (`activeAt`, its last activity) nor changed inside (`newestChange`) for
 * `maxAgeDays`. `busy` ones are always kept. Returns the ids removed. Errors on one folder do not stop the others.
 */
export function sweepScratch(
  root: string,
  opts: { exists(id: string): boolean; busy?(id: string): boolean; activeAt?(id: string): number | undefined; maxAgeDays?: number; now?: number },
  platform: NodeJS.Platform = process.platform,
): string[] {
  const maxAge = (opts.maxAgeDays ?? SCRATCH_MAX_AGE_DAYS) * 86_400_000;
  const now = opts.now ?? Date.now();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const id of names) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
    try {
      if (opts.busy?.(id)) continue;
      const exists = opts.exists(id);
      if (exists) {
        const active = opts.activeAt?.(id);
        if (active !== undefined && now - active <= maxAge) continue;
        if (now - newestChange(scratchDir(root, id, platform), now, platform) <= maxAge) continue;
      }
      removeScratch(root, id, platform);
      removed.push(id);
    } catch {
      // leave it for the next start
    }
  }
  return removed;
}
