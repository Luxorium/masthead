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

/** Runs a command; tests replace it. `status` is null when the command could not be started. */
export type Runner = (cmd: string, args: string[]) => { status: number | null; stdout: string };
const realRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

/** The current Windows user's SID (`whoami /user`), or null. A SID cannot be faked through environment variables. */
export function currentSid(run: Runner = realRunner): string | null {
  const r = run('whoami', ['/user', '/fo', 'csv', '/nh']);
  if (r.status !== 0) return null;
  const m = /"(S-1-[0-9-]+)"/.exec(r.stdout);
  return m ? m[1]! : null;
}

/**
 * Windows: replaces the inherited permissions of a folder with one entry for the current user (by SID),
 * inherited by everything created inside it. A file made in the folder afterwards is private from the
 * first moment. Returns false when that could not be done. POSIX: chmod 0700, always true.
 */
export function makeDirPrivate(dir: string, platform: NodeJS.Platform = process.platform, run: Runner = realRunner): boolean {
  if (platform !== 'win32') {
    chmodSync(dir, 0o700);
    return true;
  }
  const sid = currentSid(run);
  if (!sid) return false;
  return run('icacls', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]).status === 0;
}

/**
 * Makes `file` readable only by the person. POSIX: mode 0600. Windows ignores modes: the file's
 * inherited permissions are replaced by one entry for the current user's SID. Returns false when that
 * failed (the caller must not use the file as a secret then).
 */
export function makePrivate(file: string, platform: NodeJS.Platform = process.platform, run: Runner = realRunner): boolean {
  if (platform !== 'win32') {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    return true;
  }
  const sid = currentSid(run);
  if (!sid) return false;
  return run('icacls', [file, '/inheritance:r', '/grant:r', `*${sid}:F`]).status === 0;
}

/**
 * Whether only the current user can reach `file`. POSIX: no group or other bits. Windows: `icacls`
 * lists exactly one entry, not inherited, and none for a group such as Everyone or Users.
 */
export function isPrivate(file: string, platform: NodeJS.Platform = process.platform, run: Runner = realRunner): boolean {
  if (platform !== 'win32') return (statSync(file).mode & 0o077) === 0;
  const r = run('icacls', [file]);
  if (r.status !== 0) return false;
  const aces = r.stdout
    .split(/\r?\n/)
    .map((l, i) => (i === 0 ? l.slice(file.length) : l).trim())
    .filter((l) => l && /:\(/.test(l));
  if (aces.length !== 1) return false;
  return !/\(I\)/.test(aces[0]!) && !/everyone|\busers\b|authenticated users/i.test(aces[0]!);
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
 * and a server starting together end up with the same secret. A secret others could read is replaced,
 * not just tightened: it may already have been read. If the folder or file cannot be made private,
 * this throws and Masthead does not start.
 */
export function loadSecret(file: string = SECRET_FILE, platform: NodeJS.Platform = process.platform, run: Runner = realRunner): string {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The folder first, so a new file inside it is private from the moment it exists (Windows: by inheritance).
  if (!makeDirPrivate(dir, platform, run)) throw new Error(`Could not make ${dir} private to you (icacls failed).`);
  const existing = readSecret(file);
  if (existing && isPrivate(file, platform, run)) return existing;
  if (existing) unlinkSync(file); // readable by others: never trust it again
  const secret = randomBytes(32).toString('hex');
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, secret + '\n', { mode: 0o600 });
  if (!makePrivate(tmp, platform, run)) {
    unlinkSync(tmp);
    throw new Error(`Could not make ${file} private to you (icacls failed).`);
  }
  try {
    if (existsSync(file)) renameRetry(tmp, file, platform); // present but unusable: replace it
    else linkSync(tmp, file); // fails if another process created it meanwhile
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    if (NO_LINKS.has(code) && !existsSync(file)) {
      // No hard links here: create the file exclusively instead ('wx' also fails if another process won).
      try {
        writeFileSync(file, secret + '\n', { mode: 0o600, flag: 'wx' });
        if (!makePrivate(file, platform, run)) throw new Error(`Could not make ${file} private to you (icacls failed).`);
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
