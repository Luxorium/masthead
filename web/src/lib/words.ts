// Words for statuses, sizes and paths, shared by every component that shows an agent.
import { displayName, type AgentInfo } from '../../../shared/protocol.ts';

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function shortPath(path: string, home: string | undefined): string {
  return home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path;
}

/**
 * The words for what an agent is doing, wherever the page shows one (team panel, team map). A new
 * sub-state of a status belongs here, as one line.
 */
export function statusWords(a: AgentInfo): string {
  if (a.pausedUntil) return `Paused until ${new Date(a.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · usage limit`;
  if (a.status === 'waiting' && a.waitingFor) return `Waiting for an answer from ${displayName(a.waitingFor)}`;
  if (a.status === 'running') return a.activity ?? 'Working';
  if (a.status === 'failed') return a.error ? `Failed: ${shortReason(a.error)}` : 'Failed';
  if (a.status === 'stopped' && a.error) return `Stopped · ${shortReason(a.error)}`;
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
  queued: 'Queued',
  running: 'Working',
  // Waiting on agents it started, or on a command it left running in the background.
  waiting: 'Waiting',
  idle: 'Idle',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};
