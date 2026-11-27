// Pure logic for showing progress without asking: how long a helper has been on what it is doing,
// and whether the lead's last question is still waiting for the person. No Svelte state here, so it
// is tested directly (web/test/progress.test.ts); progress.svelte.ts keeps the live marks.
import type { AgentInfo, Item } from '../../../shared/protocol.ts';
import { T } from './text.ts';

/**
 * When the page saw an agent start what it is doing now. `exact` is false when the page only knows a
 * lower bound: it was already at it when the conversation was opened (or the page reconnected).
 */
export interface Mark {
  key: string;
  since: number;
  exact: boolean;
  /** The last time anything new came from it (an item or streamed text), as seen by the page. */
  output?: number;
}

/** What counts as "the same activity": a change in any of these starts the clock again. */
export function activityKey(a: AgentInfo): string {
  return [a.status, a.activity ?? '', a.waitingFor ?? '', a.pausedUntil ?? ''].join('\u0000');
}

/** The mark after seeing `a` at `now`: kept while its activity is unchanged, else started again. */
export function noteAgent(prev: Mark | undefined, a: AgentInfo, now: number, exact: boolean): Mark {
  const key = activityKey(a);
  if (prev && prev.key === key) return prev;
  return { key, since: now, exact, ...(prev?.output !== undefined ? { output: prev.output } : {}) };
}

/** The mark after new output from the agent at `at` (never later than `now`). */
export function noteOutput(prev: Mark | undefined, at: number, now: number): Mark | undefined {
  if (!prev) return prev;
  const t = Math.min(at, now);
  return prev.output !== undefined && prev.output >= t ? prev : { ...prev, output: t };
}

/** How long the agent has been quiet: since it started its current activity or last put anything out, whichever is later. */
export function quietSpan(mark: Mark | undefined, now: number): { ms: number; exact: boolean } | null {
  if (!mark) return null;
  const output = mark.output ?? -Infinity;
  const from = Math.max(mark.since, output);
  return { ms: Math.max(0, now - from), exact: mark.exact || output >= mark.since };
}

/** A span in words: "under 1 min", "4 min", "1 h 5 min"; "over 4 min" for a lower bound. Empty for a lower bound under a minute. */
export function fmtSpan(ms: number, exact = true): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return exact ? T.progress.underMinute : '';
  const words = min < 60 ? T.progress.minutes(min) : T.progress.hours(Math.floor(min / 60), min % 60);
  return exact ? words : T.progress.over(words);
}

/** The span to show after an agent's words, or '' when there is nothing worth saying. */
export function spanWords(mark: Mark | undefined, now: number): string {
  const q = quietSpan(mark, now);
  return q ? fmtSpan(q.ms, q.exact) : '';
}

/** Agents whose time on their activity is worth showing: live helpers that are not paused at a usage limit. */
export function showsTime(a: AgentInfo): boolean {
  return !!a.parentId && !a.pausedUntil && (a.status === 'running' || a.status === 'waiting' || a.status === 'queued');
}

// ---- the lead's open question ----

const LIST_LINE = /^\s*(?:[-*+•]|\d{1,2}[.)]|[A-Za-z][.)]|\(\w{1,2}\))\s+\S/;
/** Markdown or quotes that may close a sentence after its question mark. */
const CLOSERS = /[\s*_`'")\]]+$/;

/**
 * Whether text asks the reader something: it ends with "?", or it ends with a list of options that
 * comes right after a line ending with "?".
 */
export function endsWithQuestion(text: string): boolean {
  const t = text.replace(CLOSERS, '');
  if (t.endsWith('?')) return true;
  const lines = text.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && lines[i]!.trim() === '') i--;
  let listed = 0;
  // Walk back over the list (and blank lines or indented continuations inside it).
  while (i >= 0) {
    const line = lines[i]!;
    if (LIST_LINE.test(line)) listed++;
    else if (line.trim() !== '' && !/^\s{2,}\S/.test(line)) break;
    i--;
  }
  if (listed === 0 || i < 0) return false;
  return lines[i]!.replace(CLOSERS, '').endsWith('?') || /\?\s*:?$/.test(lines[i]!.trim());
}

/**
 * The lead's question the person has not answered and that later items have pushed up, as the id of
 * its text item; null when there is none. `items` is the lead's transcript, oldest first. The latest
 * question since the person last wrote counts even when the lead said more after it (a helper's report
 * and the lead's note on it are the usual way a question gets buried).
 */
export function openQuestion(items: Item[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'user') return null; // the person has written since
    if (it.kind === 'text' && endsWithQuestion(it.text)) return i < items.length - 1 ? it.id : null; // only once something came after it
  }
  return null;
}
