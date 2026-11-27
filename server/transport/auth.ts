import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SECRET_FILE } from '../paths.js';

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

/** Runs a command and returns its exit status; tests replace it. */
export type Runner = (cmd: string, args: string[]) => number | null;
const realRunner: Runner = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true }).status;

/**
 * Makes `file` readable only by the person. POSIX: mode 0600. Windows ignores modes, so the file's
 * inherited permissions are replaced by one entry for the current user (`icacls /inheritance:r
 * /grant:r`). A failure there is not fatal: the data folder under %LOCALAPPDATA% is per-user anyway.
 */
export function makePrivate(file: string, platform: NodeJS.Platform = process.platform, run: Runner = realRunner, env = process.env): void {
  if (platform !== 'win32') {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    return;
  }
  const user = env.USERNAME ? (env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME) : null;
  if (user) run('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`]);
}

/** Codes from file systems that cannot make hard links (FAT, exFAT, some network and synced folders). */
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL', 'ENOSYS']);
/** Codes Windows gives while another program (antivirus, the indexer) briefly holds a file. */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** renameSync, retried for a moment while Windows reports the target busy. */
export function renameRetry(from: string, to: string, platform: NodeJS.Platform = process.platform): void {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      if (platform !== 'win32' || i >= 9 || !BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}

/**
 * The secret in `file`, created once (32 random bytes, hex, private to the person) when it is missing.
 * It is kept across restarts so a signed-in browser stays signed in. Creation is atomic, so a launcher
 * and a server starting together end up with the same secret.
 */
export function loadSecret(file: string = SECRET_FILE): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const existing = readSecret(file);
  if (existing) {
    makePrivate(file);
    return existing;
  }
  const secret = randomBytes(32).toString('hex');
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, secret + '\n', { mode: 0o600 });
  makePrivate(tmp);
  try {
    if (existsSync(file)) renameRetry(tmp, file); // present but unusable: replace it
    else linkSync(tmp, file); // fails if another process created it meanwhile
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    if (NO_LINKS.has(code) && !existsSync(file)) {
      // No hard links here: create the file exclusively instead ('wx' also fails if another process won).
      try {
        writeFileSync(file, secret + '\n', { mode: 0o600, flag: 'wx' });
        makePrivate(file);
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2;
      }
    } else if (code !== 'EEXIST') throw e;
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
