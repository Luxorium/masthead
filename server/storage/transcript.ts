// Reads a transcript file (`items/<agent>.jsonl`, one item per line, the last line for an id wins) a page
// at a time, newest first, reading backwards in chunks so a long transcript is never read whole.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const CHUNK = 64 * 1024;

/**
 * A finished tool is stored without its input (since 0.2.1: the start line already has it, and inputs
 * can be large). Readers take the input from the item's earlier line.
 */
export function withoutRepeatedInput<T>(item: T): T {
  const i = item as { kind?: string; done?: boolean; input?: unknown };
  if (i.kind !== 'tool' || i.done !== true || !('input' in i)) return item;
  const { input: _input, ...rest } = i;
  return rest as T;
}

/** True for a stored finish line that needs the input of its earlier line. */
export function lacksInput(item: unknown): boolean {
  const i = item as { kind?: string; done?: boolean };
  return i.kind === 'tool' && i.done === true && !('input' in (item as object));
}

/** The newer line, with the input of the older one when the newer one was stored without it. */
export function mergeLines<T>(older: T, newer: T): T {
  if (!lacksInput(newer) || !('input' in (older as object))) return newer;
  return { ...newer, input: (older as { input?: unknown }).input };
}

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
 * A finished tool stored without its input gets it from its earlier line, read past the page's start
 * if need be (the page and its cursor are not changed by that).
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
    /** Items still waiting for the input of an earlier line. */
    const needInput = new Set<string>();
    /** Set once the page is full: where the next page starts. Scanning goes on only for needInput. */
    let cutoff: number | null = null;
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
        if (cutoff === null && !had && found.size >= opts.limit) {
          cutoff = pos + Buffer.byteLength(line) + 1;
          if (needInput.size === 0) return finish(found, cutoff, true);
        }
        if (cutoff !== null) {
          // Past the page: only inputs for items already on it.
          if (had && needInput.delete(item.id)) had.item = mergeLines(item, had.item);
          if (needInput.size === 0) return finish(found, cutoff, true);
          continue;
        }
        const merged = had ? mergeLines(item, had.item) : item;
        if (lacksInput(merged)) needInput.add(item.id);
        else needInput.delete(item.id);
        found.set(item.id, { item: merged, pos });
        cursor = pos;
      }
      carry = Buffer.from(data.subarray(0, lineEnd < 0 ? 0 : lineEnd));
      end = start;
      if (start === 0) break;
    }
    return cutoff !== null ? finish(found, cutoff, true) : finish(found, cursor, false);
  } finally {
    closeSync(fd);
  }
}

function finish<T>(found: Map<string, { item: T; pos: number }>, cursor: number, more: boolean): Page<T> {
  const items = [...found.values()].sort((a, b) => a.pos - b.pos).map((f) => f.item);
  return { items, cursor: more ? cursor : null, more };
}
