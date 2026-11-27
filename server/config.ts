import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  EFFORTS,
  MAX_PER_TIER,
  PERMISSION_CHOICES,
  TIERS,
  VERSION,
  type Effort,
  type Settings,
} from '../shared/protocol.js';

export const DEFAULT_PORT = 7717;
export const HOME = homedir();

export const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'masthead');
export const DATA_DIR = join(process.env.XDG_DATA_HOME || join(HOME, '.local', 'share'), 'masthead');
export const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
export const CONVERSATIONS_DIR = join(DATA_DIR, 'conversations');
/** The local server's secret. Only a browser signed in with it, or a program that can read this file, may drive Masthead. */
export const SECRET_FILE = join(DATA_DIR, 'secret');

export function defaultSettings(): Settings {
  return {
    tiers: {
      lead: { model: 'claude-fable-5-2', effort: 'xhigh', max: 1 },
      opus: { model: 'claude-opus-5-5', effort: 'xhigh', max: 3 },
      sonnet: { model: 'claude-sonnet-5-5', effort: 'high', max: 4 },
      haiku: { model: 'claude-haiku-5-5', effort: 'medium', max: 4 },
    },
    permissionMode: 'inherit',
    autoEffort: true,
    leanSubagents: true,
    leanOpus: true,
    collapseReports: false,
    maxRunMinutes: 0,
    defaultCwd: HOME,
  };
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.trunc(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/**
 * Returns valid settings whatever was passed in. Fields that are missing, unknown or malformed keep
 * their value from `base` (the defaults unless given), so a partial update changes only what it names.
 */
export function sanitizeSettings(raw: unknown, base: Settings = defaultSettings()): Settings {
  const d = structuredClone(base);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const tiersIn = (r.tiers && typeof r.tiers === 'object' ? r.tiers : {}) as Record<string, unknown>;
  for (const tier of TIERS) {
    const t = tiersIn[tier];
    if (!t || typeof t !== 'object') continue;
    const tt = t as Record<string, unknown>;
    if (typeof tt.model === 'string' && /^[A-Za-z0-9._\-\[\]:]{1,80}$/.test(tt.model)) d.tiers[tier].model = tt.model;
    if (EFFORTS.includes(tt.effort as Effort)) d.tiers[tier].effort = tt.effort as Effort;
    if (tier !== 'lead') d.tiers[tier].max = clampInt(tt.max, 0, MAX_PER_TIER, d.tiers[tier].max);
  }
  if (PERMISSION_CHOICES.includes(r.permissionMode as Settings['permissionMode'])) {
    d.permissionMode = r.permissionMode as Settings['permissionMode'];
  }
  if (typeof r.autoEffort === 'boolean') d.autoEffort = r.autoEffort;
  if (typeof r.leanSubagents === 'boolean') d.leanSubagents = r.leanSubagents;
  if (typeof r.leanOpus === 'boolean') d.leanOpus = r.leanOpus;
  if (typeof r.collapseReports === 'boolean') d.collapseReports = r.collapseReports;
  d.maxRunMinutes = clampInt(r.maxRunMinutes, 0, 24 * 60, d.maxRunMinutes);
  if (typeof r.defaultCwd === 'string' && r.defaultCwd.startsWith('/')) d.defaultCwd = r.defaultCwd;
  return d;
}

export function loadSettings(file: string = SETTINGS_FILE): Settings {
  try {
    return sanitizeSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return defaultSettings();
  }
}

/** Writes a file by renaming a finished temporary copy over it, so a crash never leaves half a file. */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function saveSettings(s: Settings, file: string = SETTINGS_FILE): void {
  writeFileAtomic(file, JSON.stringify(s, null, 2) + '\n');
}

const SECRET_FORMAT = /^[0-9a-f]{64}$/;
/** A proof nonce: 32 random bytes as lowercase hex. */
export const NONCE_FORMAT = /^[0-9a-f]{64}$/;

/**
 * The server's proof that it knows the secret, for a nonce the launcher chose: HMAC-SHA256 over the
 * port and the nonce. It reveals nothing about the secret. The port is part of it so another program
 * holding port N cannot pass on a question to a real Masthead on another port and replay its answer.
 */
export function proofOf(secret: string, port: number, nonce: string): string {
  return createHmac('sha256', secret).update(`masthead-proof\n${port}\n${nonce}`).digest('hex');
}

/** Whether `answer` is the proof for this secret, port and nonce, compared in constant time. */
export function proofOk(secret: string, port: number, nonce: string, answer: unknown): boolean {
  if (typeof answer !== 'string' || !/^[0-9a-f]{64}$/.test(answer)) return false;
  return timingSafeEqual(Buffer.from(answer, 'hex'), Buffer.from(proofOf(secret, port, nonce), 'hex'));
}


/** The secret in `file`, or null when there is none (or it is not one Masthead wrote). */
export function readSecret(file: string = SECRET_FILE): string | null {
  try {
    const s = readFileSync(file, 'utf8').trim();
    return SECRET_FORMAT.test(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * The secret in `file`, created once (32 random bytes, hex, mode 0600) when it is missing. It is kept
 * across restarts so a signed-in browser stays signed in. Creation is atomic, so a launcher and a
 * server starting together end up with the same secret.
 */
export function loadSecret(file: string = SECRET_FILE): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const existing = readSecret(file);
  if (existing) {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    return existing;
  }
  const secret = randomBytes(32).toString('hex');
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, secret + '\n', { mode: 0o600 });
  try {
    if (existsSync(file)) renameSync(tmp, file); // present but unusable: replace it
    else linkSync(tmp, file); // fails if another process created it meanwhile
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already renamed
    }
  }
  const s = readSecret(file);
  if (!s) throw new Error(`Could not create ${file}.`);
  return s;
}

/** What a running Claude Code session sets about itself. Settings a person exports on purpose are not in here. */
const SESSION_VARS = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_WORKER_EPOCH',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENVIRONMENT_KIND',
  'CLAUDE_CODE_EXECPATH',
]);

export interface ClaudeInfo {
  path: string | null;
  version: string | null;
  error?: string;
}

/** Finds the Claude Code the person installed. Masthead runs that program as it is and never touches its login. */
export function findClaude(): ClaudeInfo {
  const candidates: string[] = [];
  if (process.env.MASTHEAD_CLAUDE) candidates.push(process.env.MASTHEAD_CLAUDE);
  for (const dir of (process.env.PATH || '').split(delimiter)) if (dir) candidates.push(join(dir, 'claude'));
  candidates.push(join(HOME, '.local', 'bin', 'claude'), join(HOME, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/usr/bin/claude');
  const path = candidates.find((c) => existsSync(c)) ?? null;
  if (!path) {
    return { path: null, version: null, error: 'Claude Code was not found. Install it and sign in with `claude`, then restart Masthead.' };
  }
  try {
    const out = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 15_000, env: agentEnv() });
    return { path, version: out.trim().split('\n')[0] ?? null };
  } catch (e) {
    return { path, version: null, error: `Could not run ${path}: ${(e as Error).message}` };
  }
}

/**
 * Environment for the Claude Code processes Masthead starts. Variables that an enclosing Claude Code
 * session sets about itself are removed so a server launched from inside one still starts clean ones.
 * Credentials (ANTHROPIC_API_KEY and the like) are passed through untouched.
 */
export function agentEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SESSION_VARS.has(k) || k.startsWith('CLAUDE_CODE_BRIDGE_')) continue;
    env[k] = v;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `masthead/${VERSION}`;
  return env;
}

