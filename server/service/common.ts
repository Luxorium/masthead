import { DEFAULT_PORT } from '../paths.js';
import type { InstallOptions, RunResult } from './types.js';
import { ServiceError } from './types.js';

/** The warning the installed command and unit both silence (see scripts/install.sh). */
export const NODE_FLAGS = ['--disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'];

/**
 * A colon-separated PATH without empty or relative entries and without repeats, in order
 * (scripts/path.sh `clean_path`). A relative entry would be looked up from wherever the service runs.
 */
export function cleanPath(parts: readonly (string | null | undefined)[]): string {
  const out: string[] = [];
  for (const p of parts.flatMap((s) => (s ?? '').split(':'))) {
    if (p.startsWith('/') && !out.includes(p)) out.push(p);
  }
  return out.join(':');
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/**
 * The variables a POSIX service gets: PATH with node's and claude's folders first, MASTHEAD_CLAUDE,
 * XDG_CONFIG_HOME/XDG_DATA_HOME when set (settings, conversations and the secret must be where the
 * `masthead` command looks), MASTHEAD_PORT when not the default.
 */
export function serviceEnv(o: InstallOptions, tail: readonly string[]): [string, string][] {
  const path = cleanPath([dirOf(o.node), o.claudePath ? dirOf(o.claudePath) : null, o.env.PATH, ...tail]);
  const vars: [string, string][] = [['PATH', path]];
  if (o.claudePath) vars.push(['MASTHEAD_CLAUDE', o.claudePath]);
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']) if (o.env[k]) vars.push([k, o.env[k]!]);
  if (o.port !== undefined && o.port !== DEFAULT_PORT) vars.push(['MASTHEAD_PORT', String(o.port)]);
  return vars;
}

/** A port from text, or null when it is not one the server would accept. */
export function portOf(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1024 && n <= 65535 ? n : null;
}

/** Runs a command that must succeed. */
export function must(run: (cmd: string, args: readonly string[]) => RunResult, cmd: string, args: readonly string[]): RunResult {
  const r = run(cmd, args);
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout).trim() || (r.status === null ? 'it could not be started' : `exit code ${r.status}`);
    throw new ServiceError(`${cmd} ${args.join(' ')} failed: ${why}`);
  }
  return r;
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
