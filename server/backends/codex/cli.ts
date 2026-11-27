/**
 * Everything the Codex adapter runs as a plain command: finding the CLI, its version, whether it is
 * signed in (from `codex login status`; auth files are never read), and the model catalogue that turns
 * Codex's own sub-agents off.
 *
 * Codex gives every current model a `multi_agent_version`, and that, not a feature flag, puts its
 * `collaboration.*` tools (spawn_agent, send_message, …) in front of the model (docs/plans/0.2.0/codex.md,
 * "Sub-agents: settled"). Masthead copies the person's own catalogue (`codex debug models`), sets the field
 * to null on every model and starts app-server with `-c model_catalog_json=<file>`. The real tool list is
 * then checked with `codex debug prompt-input`, which renders what the model would see without calling it.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

export const MIN_VERSION = '0.172.0';
/** The versions the vendored protocol types (./protocol/VERSION) were generated from and tested with. */
export const TESTED = /^0\.172\./;

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type RunCli = (path: string, args: string[], env: Record<string, string | undefined>) => Promise<CliResult>;

export interface AppServerProcess {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
  /** Called once when the process has ended; `detail` is the end of its error output. */
  onExit(cb: (detail: string) => void): void;
}
export type SpawnAppServer = (path: string, args: string[], env: Record<string, string | undefined>) => AppServerProcess;

export const runCli: RunCli = (path, args, env) =>
  new Promise((resolve) => {
    const child = execFile(path, args, { env: env as NodeJS.ProcessEnv, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end(); // Codex waits for stdin when it is left open
  });

export const spawnAppServer: SpawnAppServer = (path, args, env) => {
  const child = spawn(path, args, { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let tail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => (tail = (tail + d).slice(-4000)));
  let exited: ((detail: string) => void) | null = null;
  let done = false;
  const finish = (why: string) => {
    if (done) return;
    done = true;
    exited?.(why);
  };
  child.on('exit', (code, signal) => finish(`${tail.trim()}${tail.trim() ? '\n' : ''}codex app-server exited (${signal ?? code})`));
  child.on('error', (e) => finish(e.message));
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: () => void child.kill(),
    onExit: (cb) => (exited = cb),
  };
};

/** The person's own Codex: MASTHEAD_CODEX, then PATH, then the usual install places. */
export function findCodex(env: Record<string, string | undefined>): string | null {
  const candidates: string[] = [];
  if (env.MASTHEAD_CODEX) candidates.push(env.MASTHEAD_CODEX);
  const exe = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  for (const dir of (env.PATH || '').split(delimiter)) if (dir) for (const e of exe) candidates.push(join(dir, e));
  candidates.push(join(homedir(), '.local', 'bin', 'codex'), '/usr/local/bin/codex', '/usr/bin/codex', '/opt/homebrew/bin/codex');
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** true / false from `codex login status`; null when its answer cannot be read. */
export function parseLogin(r: CliResult): boolean | null {
  const text = `${r.stdout}\n${r.stderr}`;
  if (/not logged in|logged out|no credentials/i.test(text)) return false;
  if (r.code === 0 && /logged in/i.test(text)) return true;
  return null;
}

/** One model of the person's catalogue, as `codex debug models` prints it (only the fields used). */
export interface CatalogModel {
  slug: string;
  display_name?: string;
  context_window?: number;
  visibility?: string;
  multi_agent_version?: string | null;
  [k: string]: unknown;
}

function catalogModels(catalog: unknown): CatalogModel[] {
  const list = Array.isArray(catalog) ? catalog : (catalog as { models?: unknown })?.models;
  return Array.isArray(list) ? (list as CatalogModel[]).filter((m) => m && typeof m.slug === 'string') : [];
}

/** A copy of the catalogue with Codex's own multi-agent runtime off for every model. */
export function withoutMultiAgent(catalog: unknown): { catalog: unknown; models: CatalogModel[] } {
  const copy = JSON.parse(JSON.stringify(catalog)) as unknown;
  const models = catalogModels(copy);
  for (const m of models) m.multi_agent_version = null;
  return { catalog: copy, models };
}

/** Names of the tools in a `codex debug prompt-input` rendering, namespaced like "collaboration.spawn_agent". */
export function promptTools(rendered: unknown): string[] {
  const out: string[] = [];
  const walk = (o: unknown, ns: string): void => {
    if (Array.isArray(o)) return o.forEach((v) => walk(v, ns));
    if (!o || typeof o !== 'object') return;
    const r = o as Record<string, unknown>;
    let inner = ns;
    if (typeof r.name === 'string' && ('parameters' in r || 'input_schema' in r || r.type === 'function' || r.type === 'namespace' || r.type === 'custom')) {
      out.push(ns ? `${ns}.${r.name}` : r.name);
      if (r.type === 'namespace') inner = r.name;
    }
    for (const v of Object.values(r)) walk(v, inner);
  };
  const items = Array.isArray(rendered) ? rendered : [];
  for (const item of items) if ((item as { type?: string })?.type === 'additional_tools') walk((item as { tools?: unknown }).tools, '');
  return out;
}

/** Tool names that would let a Codex agent start agents outside Masthead's team. */
export function nativeAgentTools(names: string[]): string[] {
  return names.filter((n) => /^collaboration(\.|$)/.test(n) || /(^|\.)(spawn_agent|wait_agent|followup_task|interrupt_agent)$/.test(n));
}

export interface PreparedCatalog {
  file: string;
  models: CatalogModel[];
}

/** Writes the catalogue without multi-agent to `dir` (regenerated on every app-server start). */
export async function prepareCatalog(run: RunCli, path: string, env: Record<string, string | undefined>, dir: string): Promise<PreparedCatalog> {
  const r = await run(path, ['debug', 'models'], env);
  if (r.code !== 0) throw new Error(`codex debug models failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error('codex debug models did not print JSON.');
  }
  const { catalog, models } = withoutMultiAgent(parsed);
  if (models.length === 0) throw new Error('codex debug models listed no models.');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'model-catalog.json');
  writeFileSync(file, JSON.stringify(catalog), { mode: 0o600 });
  return { file, models };
}

export function catalogArgs(file: string): string[] {
  return ['-c', `model_catalog_json=${JSON.stringify(file)}`];
}

/**
 * Renders what `model` would be given with the catalogue and returns any native agent tool found.
 * An empty list means the switch works for that model. Throws when the check itself cannot run.
 */
export async function nativeToolsFor(run: RunCli, path: string, env: Record<string, string | undefined>, file: string, model: string): Promise<string[]> {
  const r = await run(path, ['debug', 'prompt-input', ...catalogArgs(file), '-c', `model=${JSON.stringify(model)}`, 'hi'], env);
  if (r.code !== 0) throw new Error(`codex debug prompt-input failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  let rendered: unknown;
  try {
    rendered = JSON.parse(r.stdout);
  } catch {
    throw new Error('codex debug prompt-input did not print JSON.');
  }
  const tools = promptTools(rendered);
  if (tools.length === 0) throw new Error('codex debug prompt-input showed no tools; the check cannot be trusted.');
  return nativeAgentTools(tools);
}
