// HTTP routes for conversation images: upload (POST /blob?conv=<id>) and fetch
// (GET /blob/<convId>/<sha256>?t=<blob token>). http.ts does the Host/Origin checks and decides who the
// caller is; these handlers do the rest. No path from the client ever reaches the file system.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlobError, MAX_BLOB_BYTES, type BlobStore } from '../storage/blobs.js';

const GRACE_MS = 60_000;

/**
 * Per-socket tokens for fetching images with a plain `<img src>`: valid while the socket is open and
 * for a minute after, so cached pages keep working across a quick reconnect.
 */
export class BlobTokens {
  private tokens: Array<{ hash: Buffer; until: number }> = [];
  constructor(private now: () => number = Date.now) {}

  /** A new token for a socket; call `release` when it closes. */
  issue(): string {
    const token = randomBytes(24).toString('base64url');
    this.tokens.push({ hash: createHash('sha256').update(token).digest(), until: Infinity });
    return token;
  }

  release(token: string): void {
    const h = createHash('sha256').update(token).digest();
    for (const t of this.tokens) if (timingSafeEqual(t.hash, h)) t.until = Math.min(t.until, this.now() + GRACE_MS);
  }

  /** Whether the token is live. Compares against every token in constant time per entry. */
  check(token: unknown): boolean {
    if (typeof token !== 'string' || token.length === 0 || token.length > 100) return false;
    const now = this.now();
    this.tokens = this.tokens.filter((t) => t.until > now);
    const h = createHash('sha256').update(token).digest();
    let ok = false;
    for (const t of this.tokens) if (timingSafeEqual(t.hash, h)) ok = true;
    return ok;
  }
}

function plain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
  res.end(body);
}

/** GET /blob/<convId>/<hash>?t=… — returns true if the path was a blob route (handled either way). */
export function handleBlobGet(req: IncomingMessage, res: ServerResponse, url: URL, deps: { blobs: BlobStore; tokens: BlobTokens }): boolean {
  const m = /^\/blob\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{64})$/.exec(url.pathname);
  if (!url.pathname.startsWith('/blob/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed'), true;
  if (!deps.tokens.check(url.searchParams.get('t'))) return plain(res, 403, 'Forbidden'), true;
  const found = m ? deps.blobs.find(m[1]!, m[2]!) : null;
  if (!found) return plain(res, 404, 'Not found'), true;
  const head = {
    'content-type': found.mediaType,
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
    // Opened on its own, the response can run nothing.
    'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    'cache-control': 'private, max-age=31536000, immutable',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, head);
    res.end();
    return true;
  }
  const stream = createReadStream(found.file);
  stream.on('open', () => {
    res.writeHead(200, head);
    stream.pipe(res);
  });
  stream.on('error', () => {
    if (!res.headersSent) plain(res, 404, 'Not found');
    else res.destroy();
  });
  res.on('close', () => stream.destroy());
  return true;
}

/**
 * POST /blob?conv=<convId> with the raw image bytes. `authorised` is http.ts's decision (local key
 * header, or an approved remote device that may send). `convExists` keeps uploads to real conversations.
 * Answers the BlobRef as JSON, or `{code, message}` with 400/403/404/413.
 */
export function handleBlobPost(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: { blobs: BlobStore; authorised: boolean; convExists: (convId: string) => boolean },
): boolean {
  if (url.pathname !== '/blob') return false;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return json(405, { code: 'invalid', message: 'Method not allowed' }), true;
  if (!deps.authorised) return json(403, { code: 'refused', message: 'Forbidden' }), true;
  const convId = url.searchParams.get('conv') ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(convId) || !deps.convExists(convId)) return json(404, { code: 'not_found', message: 'That conversation no longer exists.' }), true;
  const declared = String(req.headers['content-type'] ?? '').split(';')[0]!.trim() || undefined;
  const length = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(length) && length > MAX_BLOB_BYTES) {
    json(413, { code: 'too_large', message: 'An image may be at most 5 MB.' });
    req.resume();
    return true;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on('data', (c: Buffer) => {
    if (over) return;
    size += c.length;
    if (size > MAX_BLOB_BYTES) {
      over = true;
      json(413, { code: 'too_large', message: 'An image may be at most 5 MB.' });
      req.resume();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (over) return;
    try {
      json(200, deps.blobs.put(convId, Buffer.concat(chunks), declared === 'application/octet-stream' ? undefined : declared));
    } catch (e) {
      if (e instanceof BlobError) json(e.code === 'too_large' ? 413 : 400, { code: e.code, message: e.message });
      else json(500, { code: 'invalid', message: 'Could not store the image.' });
    }
  });
  req.on('error', () => res.destroy());
  return true;
}
