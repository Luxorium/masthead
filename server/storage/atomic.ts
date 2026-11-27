import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Renames, retrying on Windows while another program (antivirus, the search indexer) briefly holds the
 * target: up to ten tries over about a second. Elsewhere it is a plain rename.
 */
export function renameRetry(from: string, to: string, platform: NodeJS.Platform = process.platform, rename: (a: string, b: string) => void = renameSync): void {
  for (let i = 0; ; i++) {
    try {
      return rename(from, to);
    } catch (e) {
      if (platform !== 'win32' || i >= 9 || !BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}

/** Writes a file by renaming a finished temporary copy over it, so a crash never leaves half a file. */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameRetry(tmp, path);
}
