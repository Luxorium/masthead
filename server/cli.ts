// Command-line parsing for `masthead`, kept apart from main.ts so it can be tested without running anything.
import { DEFAULT_PORT } from './config.js';

/** A mistake in how the command was typed. The message is shown as it is and the exit code is 2. */
export class UsageError extends Error {}

function checkPort(raw: string): number {
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new UsageError(`Invalid port: ${raw} (use a number from 1024 to 65535).`);
  return n;
}

/** The port asked for with `--port N`, `--port=N` or MASTHEAD_PORT, in that order, else the default. */
export function parsePort(args: readonly string[], env: Record<string, string | undefined> = {}): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--port') {
      const v = args[i + 1];
      if (v === undefined || v === '' || v.startsWith('-')) throw new UsageError('--port needs a number, e.g. --port 7720.');
      return checkPort(v);
    }
    if (a.startsWith('--port=')) return checkPort(a.slice('--port='.length));
  }
  const fromEnv = env.MASTHEAD_PORT;
  return fromEnv ? checkPort(fromEnv) : DEFAULT_PORT;
}

/** The command is the first word that is neither an option nor the value of --port; `open` when there is none. */
export function parseCommand(args: readonly string[]): string {
  return args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '--port') ?? 'open';
}

/**
 * The port of the installed systemd unit, read from `systemctl --user show -p LoadState -p Environment
 * masthead.service`, or null when there is no such unit. The unit serves DEFAULT_PORT unless its
 * environment sets MASTHEAD_PORT.
 */
export function unitPortFrom(showOutput: string): number | null {
  const load = /^LoadState=(.*)$/m.exec(showOutput)?.[1]?.trim();
  if (load !== 'loaded') return null;
  const env = /^Environment=(.*)$/m.exec(showOutput)?.[1] ?? '';
  const m = /(?:^|[\s"])MASTHEAD_PORT=(\d+)/.exec(env);
  if (!m) return DEFAULT_PORT;
  try {
    return checkPort(m[1]!);
  } catch {
    return DEFAULT_PORT;
  }
}
