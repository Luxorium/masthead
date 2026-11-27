// Words for statuses, sizes and paths, shared by every component that shows an agent.
import { displayName, type AgentInfo } from '../../../shared/protocol.ts';
import { T } from './text.ts';

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Replaces the home folder with `~`. Windows paths (`C:\\Users\\x`) are compared without case. */
export function shortPath(path: string, home: string | undefined): string {
  if (!home) return path;
  const win = /^[A-Za-z]:\\/.test(home);
  const p = win ? path.toLowerCase() : path;
  const h = win ? home.toLowerCase() : home;
  const under = p === h || p.startsWith(h + '/') || (win && p.startsWith(h + '\\'));
  return under ? '~' + path.slice(home.length) : path;
}

/** A child path inside `parent`, with the parent's own separator (`\\` on Windows). */
export function childPath(parent: string, name: string): string {
  const sep = /^[A-Za-z]:\\/.test(parent) || (parent.includes('\\') && !parent.includes('/')) ? '\\' : '/';
  return parent.endsWith(sep) ? parent + name : `${parent}${sep}${name}`;
}

/**
 * The words for what an agent is doing, wherever the page shows one (the team outline, the chat's status line). A new
 * sub-state of a status belongs here, as one line.
 */
export function statusWords(a: AgentInfo): string {
  if (a.pausedUntil) return T.status.paused(new Date(a.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  if (a.status === 'waiting' && a.waitingFor) return T.status.waitingFor(displayName(a.waitingFor));
  if (a.status === 'running') return a.activity ?? T.status.running;
  if (a.status === 'failed') return a.error ? T.status.failedWith(shortReason(a.error)) : T.status.failed;
  if (a.status === 'stopped' && a.error) return T.status.stoppedWith(shortReason(a.error));
  return STATUS_LABEL[a.status];
}

/**
 * Why an agent ended, in a few words: the server's known reasons are named plainly, anything else is
 * cut to its first sentence and 60 characters.
 */
export function shortReason(error: string): string {
  const named: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^Stopped by the person\.?$/, () => 'by you'],
    [/run-time limit/, () => 'run-time limit'],
    [/^Stopped by "([^"]+)"/, (m) => `by ${displayName(m[1]!)}`],
    [/^"([^"]+)" ended before this agent finished/, (m) => `${displayName(m[1]!)} ended first`],
    [/^Masthead was closed while this agent was working/, () => 'Masthead was closed'],
  ];
  for (const [re, words] of named) {
    const m = re.exec(error);
    if (m) return words(m);
  }
  const first = error.split(/(?<=[.!?])\s/)[0]!.trim().replace(/\.$/, '');
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

export const STATUS_LABEL: Record<AgentInfo['status'], string> = {
  queued: T.status.queued,
  running: T.status.running,
  // Waiting on agents it started, or on a command it left running in the background.
  waiting: T.status.waiting,
  idle: T.status.idle,
  done: T.status.done,
  failed: T.status.failed,
  stopped: T.status.stopped,
};
