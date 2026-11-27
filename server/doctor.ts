// `masthead doctor`: one line per check, with the fix. Every probe of the system is injected through
// DoctorDeps so the checks can be tested without one.
import { accessSync, constants, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { mastheadCommand } from './paths.js';
import { VERSION } from '../shared/protocol.js';
import type { ServiceManager } from './service/types.js';

export interface Check {
  name: string;
  ok: boolean;
  /** ok, but worth a look. */
  warn?: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorFs {
  /** null when the path does not exist. `mode` is only read off Windows. */
  stat(path: string): { isDirectory: boolean; mode: number } | null;
  writable(path: string): boolean;
}

export interface DoctorDeps {
  platform: NodeJS.Platform;
  /** process.versions.node */
  nodeVersion: string;
  findClaude(): Promise<{ path: string | null; version: string | null; error?: string }>;
  paths: { configDir: string; dataDir: string; secretFile: string };
  fs: DoctorFs;
  port: number;
  probe(port: number): Promise<'free' | 'ours' | 'other'>;
  service?: ServiceManager | null;
  /** The folder of the Agent SDK's private Claude Code binary package, or null when it is not installed. See `sdkBinaryPackage`. */
  sdkBinary(): string | null;
  /** The program that keeps the computer awake while agents work (server/service/awake.ts), or null where there is none, and whether it is on PATH. */
  awakeTool?(): { cmd: string | null; found: boolean };
  /** Windows: whether only the current user can reach a file (icacls). See isPrivate in transport/auth.ts. */
  isPrivate?(file: string): boolean;
}

export const MIN_NODE = 22;

/** The real file system for DoctorDeps.fs. */
export const systemDoctorFs: DoctorFs = {
  stat(path) {
    try {
      const s = statSync(path);
      return { isDirectory: s.isDirectory(), mode: s.mode };
    } catch {
      return null;
    }
  },
  writable(path) {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Where the SDK's optional platform package (a private copy of Claude Code, which Masthead never runs)
 * is installed, resolved from the SDK as the SDK itself would find it; null when it is absent.
 */
export function sdkBinaryPackage(platform: string = process.platform, arch: string = process.arch, resolve?: (id: string) => string): string | null {
  let res = resolve;
  if (!res) {
    try {
      const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
      res = createRequire(sdk).resolve;
    } catch {
      return null;
    }
  }
  const base = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  for (const name of [base, `${base}-musl`]) {
    try {
      return dirname(res(`${name}/package.json`));
    } catch {
      // not this one
    }
  }
  return null;
}

function nodeCheck(version: string): Check {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  return major >= MIN_NODE
    ? { name: 'Node.js', ok: true, detail: `v${version.replace(/^v/, '')}` }
    : { name: 'Node.js', ok: false, detail: `v${version.replace(/^v/, '')} is too old`, fix: `Install Node.js ${MIN_NODE} or newer.` };
}

async function claudeCheck(deps: DoctorDeps): Promise<Check> {
  const name = 'Claude Code';
  const fix = 'Install Claude Code (https://code.claude.com/docs/en/setup) and sign in by running `claude` once.';
  try {
    const c = await deps.findClaude();
    if (!c.path) return { name, ok: false, detail: c.error ?? 'not found', fix };
    if (c.error || !c.version) return { name, ok: false, detail: `${c.path}: ${c.error ?? 'its version could not be read'}`, fix: `Check that \`${c.path} --version\` works.` };
    return { name, ok: true, detail: `${c.version} at ${c.path}` };
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message, fix };
  }
}

function folderCheck(deps: DoctorDeps, name: string, dir: string): Check {
  const s = deps.fs.stat(dir);
  // A folder that does not exist yet is made on first start.
  if (!s) return { name, ok: true, warn: true, detail: `${dir} does not exist yet (made on first start)` };
  if (!s.isDirectory) return { name, ok: false, detail: `${dir} is not a folder`, fix: `Move ${dir} out of the way.` };
  if (!deps.fs.writable(dir)) return { name, ok: false, detail: `${dir} is not writable`, fix: `Make ${dir} writable by your user.` };
  return { name, ok: true, detail: dir };
}

function secretCheck(deps: DoctorDeps): Check {
  const name = 'Secret';
  const file = deps.paths.secretFile;
  const s = deps.fs.stat(file);
  if (!s) return { name, ok: true, warn: true, detail: `${file} does not exist yet (made on first start)` };
  if (s.isDirectory) return { name, ok: false, detail: `${file} is a folder`, fix: `Remove ${file}; a new secret is made on the next start.` };
  // Windows has no POSIX modes: the file is private through the ACL of the user's profile folder.
  if (deps.platform === 'win32') {
    // Windows has no POSIX modes: the ACL is read (icacls) through deps.isPrivate.
    if (!deps.isPrivate) return { name, ok: true, warn: true, detail: `${file} (permissions not checked)` };
    return deps.isPrivate(file)
      ? { name, ok: true, detail: `${file} (only you have access)` }
      : { name, ok: false, detail: `${file} can be reached by others, or its permissions could not be read`, fix: `Delete ${file} and restart Masthead; a new private secret is made.` };
  }
  const mode = s.mode & 0o777;
  if (mode & 0o077) {
    return { name, ok: false, detail: `${file} can be read by others (mode ${mode.toString(8).padStart(3, '0')})`, fix: 'Restart Masthead: a secret others could read is replaced with a new one (sign in again with masthead).' };
  }
  return { name, ok: true, detail: `${file} (mode ${mode.toString(8).padStart(3, '0')})` };
}

async function portCheck(deps: DoctorDeps): Promise<Check> {
  const name = `Port ${deps.port}`;
  try {
    const p = await deps.probe(deps.port);
    if (p === 'free') return { name, ok: true, detail: 'free' };
    if (p === 'ours') return { name, ok: true, detail: 'served by this Masthead' };
    return { name, ok: false, detail: 'in use by another program', fix: `Stop that program, or use another port: ${mastheadCommand(deps.platform)} --port <n>.` };
  } catch (e) {
    return { name, ok: false, warn: true, detail: `could not be checked: ${(e as Error).message}` };
  }
}

async function serviceCheck(deps: DoctorDeps): Promise<Check> {
  const name = 'Service';
  if (!deps.service) return { name, ok: true, warn: true, detail: `none on ${deps.platform}; run Masthead with: ${mastheadCommand(deps.platform)}` };
  try {
    const s = await deps.service.status();
    if (!s.installed) return { name, ok: true, warn: true, detail: `not installed (${deps.service.kind})`, fix: `${mastheadCommand(deps.platform)} service install` };
    if (s.running === false) return { name, ok: false, detail: s.detail, fix: `${mastheadCommand(deps.platform)} service install` };
    return { name, ok: true, warn: s.running === null, detail: s.detail };
  } catch (e) {
    return { name, ok: false, warn: true, detail: `could not be checked: ${(e as Error).message}` };
  }
}

/** The GitHub release tarball of a Masthead version (Masthead is not published to the npm registry). */
export function releaseTarball(version: string): string {
  return `https://github.com/Luxorium/masthead/releases/download/v${version}/luxorium-masthead-${version}.tgz`;
}

function sdkBinaryCheck(deps: DoctorDeps): Check {
  const name = 'SDK private binary';
  const dir = deps.sdkBinary();
  if (!dir) return { name, ok: true, detail: 'not installed (Masthead runs your own Claude Code)' };
  return {
    name,
    ok: true,
    warn: true,
    detail: `${dir} holds an unused private copy of Claude Code`,
    // npm ignores --omit=optional for a global install; os/cpu "none" skips every platform package.
    // Masthead is not on the npm registry: it installs from the release tarball of this version.
    fix: `Reinstall without it: npm i -g --os=none --cpu=none ${releaseTarball(VERSION)}`,
  };
}

function awakeCheck(deps: DoctorDeps): Check | null {
  if (!deps.awakeTool) return null;
  const name = 'Keep awake';
  const t = deps.awakeTool();
  if (!t.cmd) return { name, ok: true, warn: true, detail: `not supported on ${deps.platform}; the computer may sleep while agents work` };
  if (!t.found) return { name, ok: true, warn: true, detail: `${t.cmd} was not found; the computer may sleep while agents work`, fix: deps.platform === 'linux' ? 'Install systemd (systemd-inhibit), or keep the computer awake yourself' : undefined };
  return { name, ok: true, detail: `${t.cmd} holds off idle sleep while agents work` };
}

export async function doctor(deps: DoctorDeps): Promise<Check[]> {
  return [
    nodeCheck(deps.nodeVersion),
    await claudeCheck(deps),
    folderCheck(deps, 'Config folder', deps.paths.configDir),
    folderCheck(deps, 'Data folder', deps.paths.dataDir),
    secretCheck(deps),
    await portCheck(deps),
    await serviceCheck(deps),
    sdkBinaryCheck(deps),
    ...[awakeCheck(deps)].filter((c): c is Check => c !== null),
  ];
}

export function formatChecks(checks: readonly Check[]): string {
  return checks
    .map((c) => {
      const mark = !c.ok ? 'FAIL' : c.warn ? 'WARN' : ' OK ';
      const line = `[${mark}] ${c.name}: ${c.detail}`;
      return c.fix && (!c.ok || c.warn) ? `${line}\n       fix: ${c.fix}` : line;
    })
    .join('\n');
}

/** 0 when every check is ok (warnings included), else 1. */
export function doctorExitCode(checks: readonly Check[]): number {
  return checks.every((c) => c.ok) ? 0 : 1;
}
