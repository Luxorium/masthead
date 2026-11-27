// Command-line parsing and the sign-in step for `masthead`, kept apart from main.ts so they can be
// tested without running anything.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PORT, proofOk } from './config.js';

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

/** The port of the Vite page in development: MASTHEAD_DEV_WEB_PORT, else 7718. */
export function parseDevWebPort(env: Record<string, string | undefined> = {}): number {
  const raw = env.MASTHEAD_DEV_WEB_PORT;
  return raw ? checkPort(raw) : 7718;
}

/** The address that signs a browser in. The key is in the fragment, which browsers never send to a server. */
export function signInUrl(base: string, secret: string): string {
  return `${base}/#key=${secret}`;
}

/**
 * Where sign-in files go: $XDG_RUNTIME_DIR/masthead (a per-user tmpfs, normally 0700) when it is set,
 * else <DATA_DIR>/open.
 */
export function signInDir(env: Record<string, string | undefined>, dataDir: string): string {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime && runtime.startsWith('/') ? join(runtime, 'masthead') : join(dataDir, 'open');
}

const SIGN_IN_PREFIX = 'sign-in-';
/** Sign-in files older than this are removed on the next run, in case the timed removal never ran. */
export const SIGN_IN_STALE_MS = 2 * 60_000;

function htmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Writes a page, readable only by the person (folder 0700, file 0600), that sends the browser on to
 * `target`. Opening this file instead of the address keeps the key out of every process's arguments,
 * which other users on the machine can read. Stale sign-in files are removed first.
 */
export function writeSignInFile(dir: string, target: string, now = Date.now()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(SIGN_IN_PREFIX)) continue;
    try {
      if (now - statSync(join(dir, name)).mtimeMs > SIGN_IN_STALE_MS) unlinkSync(join(dir, name));
    } catch {
      // gone already
    }
  }
  const file = join(dir, `${SIGN_IN_PREFIX}${randomBytes(6).toString('hex')}.html`);
  const t = htmlAttr(target);
  writeFileSync(
    file,
    `<!doctype html>\n<meta charset="utf-8">\n<meta name="referrer" content="no-referrer">\n<meta http-equiv="refresh" content="0; url=${t}">\n<title>Masthead</title>\n<p><a href="${t}">Open Masthead</a></p>\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return file;
}

/** How long the opener may run before it counts as having opened the browser. */
export const OPENER_WAIT_MS = 3_000;
const BROWSER_HINT = 'If the browser did not open signed in, run: masthead --no-browser';

/**
 * Asks the server at `base` to prove it knows `secret` (see proofOf in config.ts), with a fresh nonce.
 * Only a server that passes may be sent the secret. Any failure (no answer, an older Masthead without
 * /api/proof, another program, a wrong proof) is false.
 */
export async function serverProves(
  base: string,
  port: number,
  secret: string,
  fetchFn: (url: string, init: { signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }> = fetch,
): Promise<boolean> {
  const nonce = randomBytes(32).toString('hex');
  try {
    const res = await fetchFn(`${base}/api/proof?nonce=${nonce}`, { signal: AbortSignal.timeout(1500) });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { proof?: unknown } | null;
    return proofOk(secret, port, nonce, body?.proof);
  } catch {
    return false;
  }
}

export interface Opener {
  /** Whether a command exists. */
  has(cmd: string): boolean;
  /** Starts a command; resolves with its exit code, or null if it could not start. It must not keep the process alive. */
  run(cmd: string, args: string[]): Promise<number | null>;
  /** Starts a command in the background and forgets it. */
  detach(cmd: string, args: string[]): void;
  log(line: string): void;
}

/**
 * Opens Masthead in the browser, signed in, without putting the key on any command line: the opener
 * gets the path of a private sign-in file, which is removed a minute later. The opener is waited for
 * at most `waitMs`: some run the browser in the foreground, and one still running has opened it. If
 * there is no opener or it fails, the address is printed, but only to a terminal (`tty`): output that
 * is not a terminal may end up in a log other people can read.
 */
export async function openSignedIn(opts: { base: string; secret: string; dir: string; opener: Opener; tty: boolean; waitMs?: number }): Promise<boolean> {
  const { base, secret, dir, opener, tty, waitMs = OPENER_WAIT_MS } = opts;
  const target = signInUrl(base, secret);
  const cmd = ['xdg-open', 'gio'].find((c) => opener.has(c));
  let file: string | null = null;
  if (cmd) {
    try {
      file = writeSignInFile(dir, target);
    } catch (e) {
      opener.log(`Could not write the sign-in file in ${dir}: ${(e as Error).message}`);
    }
  }
  if (cmd && file) {
    let timer: NodeJS.Timeout | undefined;
    const stillRunning = new Promise<'running'>((resolve) => (timer = setTimeout(() => resolve('running'), waitMs)));
    const code = await Promise.race([opener.run(cmd, cmd === 'gio' ? ['open', file] : [file]), stillRunning]);
    clearTimeout(timer);
    if (code === 0 || code === 'running') {
      // Long enough for a browser that is still starting; the file's name is no secret.
      opener.detach('sh', ['-c', 'sleep 60; rm -f -- "$1"', 'sh', file]);
      // A confined browser (snap, flatpak) may not be able to read the file, which nothing here can see.
      if (tty) opener.log(BROWSER_HINT);
      return true;
    }
    try {
      unlinkSync(file);
    } catch {
      // gone already
    }
  }
  if (tty) {
    opener.log(`Open this address in your browser to sign it in (keep it private):\n  ${target}`);
    opener.log(BROWSER_HINT);
  } else {
    opener.log('Could not open the browser. Run `masthead --no-browser` in a terminal to get the sign-in address.');
  }
  return false;
}
