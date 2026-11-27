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

