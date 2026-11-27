// Reads a transcript file (`items/<agent>.jsonl`, one item per line, the last line for an id wins) a page
// at a time, newest first, reading backwards in chunks so a long transcript is never read whole.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const CHUNK = 64 * 1024;

export interface Page<T> {
  /** Oldest first within the page. */
  items: T[];
  /** Pass as `before` for the next older page; null when there is none. */
  cursor: number | null;
  more: boolean;
}

/**
 * The newest `limit` distinct items before byte offset `before` (the whole file when absent). An item
 * written more than once keeps its newest line seen in the scan and the position of its oldest. A page
 * fetched later is older: the reader keeps any item it already holds, which is the newer version.
 */
export function readPage<T extends { id: string }>(file: string, opts: { before?: number | null; limit: number }): Page<T> {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { items: [], cursor: null, more: false };
  }
  try {
    const size = fstatSync(fd).size;
    let end = Math.min(opts.before ?? size, size);
    const found = new Map<string, { item: T; pos: number }>();
    let carry = Buffer.alloc(0); // the start of a line whose beginning is in an earlier chunk
    let cursor = end;
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const data = Buffer.concat([buf, carry]);
      let lineEnd = data.length;
      // Walk complete lines from the back; the first (possibly partial) line waits for the next chunk.
      for (let i = data.length - 1; i >= -1; i--) {
        if (i >= 0 && data[i] !== 0x0a) continue;
        if (i < 0 && start > 0) break;
        const line = data.subarray(i + 1, lineEnd).toString('utf8');
        const pos = start + i + 1;
        lineEnd = i;
        if (!line.trim()) continue;
        let item: T;
        try {
          item = JSON.parse(line) as T;
        } catch {
          continue; // a torn line from a crash
        }
        if (!item || typeof item.id !== 'string') continue;
        const had = found.get(item.id);
        if (!had && found.size >= opts.limit) {
          return finish(found, pos + Buffer.byteLength(line) + 1, true);
        }
        found.set(item.id, { item: had?.item ?? item, pos });
        cursor = pos;
      }
      carry = Buffer.from(data.subarray(0, lineEnd < 0 ? 0 : lineEnd));
      end = start;
      if (start === 0) break;
    }
    return finish(found, cursor, false);
  } finally {
    closeSync(fd);
  }
}

function finish<T>(found: Map<string, { item: T; pos: number }>, cursor: number, more: boolean): Page<T> {
  const items = [...found.values()].sort((a, b) => a.pos - b.pos).map((f) => f.item);
  return { items, cursor: more ? cursor : null, more };
}
