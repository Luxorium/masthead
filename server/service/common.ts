import { DEFAULT_PORT, appDirs } from '../paths.js';
import type { InstallOptions, RunResult, ServiceStatus } from './types.js';
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
 * Refuses a value with a line break or NUL: in a unit, plist or task XML it would start a new line
 * (a new directive) or be cut short. Throws a ServiceError naming the variable.
 */
export function checkValue(name: string, value: string): string {
  if (/[\n\r\0]/.test(value)) {
    throw new ServiceError(`${name} contains a line break or NUL character, which a service file cannot hold safely: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The folder variables passed on to a POSIX service, in the order paths.ts reads them. */
export const DIR_VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'MASTHEAD_CONFIG_DIR', 'MASTHEAD_DATA_DIR'] as const;

/**
 * The variables a POSIX service gets: PATH with node's and claude's folders first, MASTHEAD_CLAUDE,
 * XDG_CONFIG_HOME/XDG_DATA_HOME and MASTHEAD_CONFIG_DIR/MASTHEAD_DATA_DIR when set (settings,
 * conversations and the secret must be where the `masthead` command looks), MASTHEAD_PORT when not
 * the default. Every value is checked with `checkValue`.
 */
export function serviceEnv(o: InstallOptions, tail: readonly string[]): [string, string][] {
  const path = cleanPath([dirOf(o.node), o.claudePath ? dirOf(o.claudePath) : null, o.env.PATH, ...tail]);
  const vars: [string, string][] = [['PATH', path]];
  if (o.claudePath) vars.push(['MASTHEAD_CLAUDE', o.claudePath]);
  for (const k of DIR_VARS) if (o.env[k]) vars.push([k, o.env[k]!]);
  if (o.port !== undefined && o.port !== DEFAULT_PORT) vars.push(['MASTHEAD_PORT', String(o.port)]);
  for (const [k, v] of vars) checkValue(k, v);
  return vars;
}

/**
 * The data folder an installed service uses, from the environment it was given, and a note when it
 * differs from the one this shell would use (so a mismatch is visible in `status`).
 */
export function dataDirNote(platform: NodeJS.Platform, serviceVars: Record<string, string>, shellEnv: Record<string, string | undefined>, home: string): { dataDir: string; note: string } {
  const pick = (e: Record<string, string | undefined>) => Object.fromEntries(DIR_VARS.filter((k) => e[k]).map((k) => [k, e[k]]));
  const dataDir = appDirs(platform, pick(serviceVars), home).data;
  const mine = appDirs(platform, pick(shellEnv), home).data;
  return { dataDir, note: dataDir === mine ? `data ${dataDir}` : `data ${dataDir} (this shell uses ${mine})` };
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

/**
 * `masthead service status` (and the end of `service install`) in plain words: whether Masthead
 * answers on its port, and whether the service started it or the person did. A copy started by hand
 * before the service was installed keeps the port, and the service's own copy then cannot start.
 */
export function statusSummary(kind: string, st: ServiceStatus, answers: boolean, port: number): string {
  const where = `port ${port}`;
  if (!st.installed) return `Not installed (${kind}). ${answers ? `Masthead is running on ${where}, started by hand.` : `Masthead is not running on ${where}.`}`;
  let what: string;
  if (answers && st.running === true) what = `Masthead is running on ${where}, started by the service.`;
  else if (answers && st.running === false) what = `Masthead is running on ${where}, started by hand; the service starts it at login.`;
  else if (answers) what = `Masthead is running on ${where}; whether the service started it cannot be told.`;
  else if (st.running === true) what = `Masthead does not answer on ${where} although the service is running; it may still be starting, or failing (see its log).`;
  else what = `Masthead is not running on ${where}; the service starts it at login.`;
  return `Installed (${kind}). ${what} (${st.detail})`;
}
