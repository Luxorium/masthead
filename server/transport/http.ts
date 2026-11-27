import { timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, posix, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { VERSION, type ServerMsg } from '../../shared/protocol.js';
import type { App, Client } from '../app/app.js';
import type { BlobStore } from '../storage/blobs.js';
import { NONCE_FORMAT, proofOf } from './auth.js';
import { BlobTokens, handleBlobGet, handleBlobPost } from './blobs.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const MAX_WS_PAYLOAD = 48 * 1024 * 1024;
const PING_MS = 30_000;
/** The socket's subprotocol. The page also offers `key.<secret>`, which is checked and never echoed. */
const PROTOCOL = 'masthead';
const KEY_PREFIX = 'key.';
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** What the server needs from the app; tests pass a stand-in. */
export type ServedApp = Pick<App, 'connect' | 'disconnect' | 'handle' | 'workingCount'>;

export interface ServeOptions {
  /** 0 picks a free port (tests). */
  port: number;
  webDir: string;
  /** The local secret (see config.ts loadSecret). */
  secret: string;
  /** Extra origins allowed to open the socket, e.g. the Vite dev server. */
  extraOrigins?: string[];
  onShutdown: () => void;
  /** Conversation images; without it the /blob routes answer 404. */
  blobs?: BlobStore;
  /** Whether a conversation exists, so uploads only go to real ones. */
  convExists?: (convId: string) => boolean;
}

/** Whether `given` is the secret, compared in constant time. */
function secretOk(secret: string, given: unknown): boolean {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The request's path, or null when its target cannot be parsed (a malformed request line). */
function pathOf(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://x');
  } catch {
    return null;
  }
}

/** The secret offered as a `key.<secret>` subprotocol, if any. */
function offeredKey(req: IncomingMessage): string | undefined {
  const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
  return offered.find((p) => p.startsWith(KEY_PREFIX))?.slice(KEY_PREFIX.length);
}

/**
 * The server listens on 127.0.0.1 only, and it can run commands as the person, so it also refuses
 * requests a web page elsewhere could trick a browser into making: the Host header must name this
 * server (which defeats DNS rebinding) and a socket must be opened by Masthead's own page. On top of
 * that the socket and shutdown need the local secret, which other users on the machine cannot read.
 * `masthead` opens the page with `#key=<secret>` (the fragment is never sent here); the page keeps it
 * (per origin) and offers it as a subprotocol when it opens the socket. The page itself holds no secret and is served to anyone.
 */
export function serve(app: ServedApp, opts: ServeOptions): Promise<Server> {
  const hosts = new Set<string>();
  const origins = new Set<string>(opts.extraOrigins ?? []);
  const webRoot = resolve(opts.webDir);

  const hostOk = (req: IncomingMessage) => hosts.has(req.headers.host ?? '');

  /** The port actually listened on (known once listening; `opts.port` may be 0). */
  let boundPort = opts.port;

  const blobTokens = new BlobTokens();
  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostOk(req)) return void send(res, 403, 'Forbidden');
    const url = pathOf(req);
    if (!url) return void send(res, 400, 'Bad request');
    if (url.pathname === '/api/health') {
      return void sendJson(res, 200, { name: 'masthead', version: VERSION, pid: process.pid, busy: app.workingCount() });
    }
    if (url.pathname === '/api/proof') {
      // Lets `masthead` check that this server knows its secret before sending it the secret: the answer
      // is an HMAC of the launcher's nonce (see proofOf), which reveals nothing. No secret is needed to ask.
      if (req.method !== 'GET') return void send(res, 405, 'Method not allowed');
      const nonce = url.searchParams.get('nonce') ?? '';
      if (!NONCE_FORMAT.test(nonce)) return void send(res, 400, 'Bad request');
      return void sendJson(res, 200, { name: 'masthead', proof: proofOf(opts.secret, boundPort, nonce) });
    }
    if (url.pathname === '/api/shutdown') {
      // A custom header cannot be sent cross-site without a preflight this server never grants.
      const authorised = secretOk(opts.secret, req.headers['x-masthead-key']);
      if (req.method !== 'POST' || req.headers['x-masthead'] !== '1' || !authorised) return void send(res, 403, 'Forbidden');
      sendJson(res, 200, { ok: true });
      setTimeout(opts.onShutdown, 50);
      return;
    }
    if (opts.blobs) {
      if (handleBlobGet(req, res, url, { blobs: opts.blobs, tokens: blobTokens })) return;
      // Uploads need the secret in a custom header, which no other site can send without a preflight.
      const authorised = secretOk(opts.secret, req.headers['x-masthead-key']);
      if (handleBlobPost(req, res, url, { blobs: opts.blobs, authorised, convExists: opts.convExists ?? (() => false) })) return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return void send(res, 405, 'Method not allowed');
    serveStatic(webRoot, url.pathname, req, res);
  };

  const server = createServer((req, res) => {
    // Nothing a request carries may stop the server: anything unexpected is a 500 for that request.
    try {
      handleRequest(req, res);
    } catch (e) {
      console.error(`Masthead could not answer ${req.method ?? '?'} request: ${(e as Error)?.message ?? String(e)}`);
      if (!res.headersSent) send(res, 500, 'Internal error');
      else res.destroy();
    }
  });

  // The key was checked before the upgrade; the answer names only the plain subprotocol.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD, handleProtocols: () => PROTOCOL });
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = pathOf(req);
      if (!url) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (url.pathname !== '/ws' || !hostOk(req) || !origins.has(req.headers.origin ?? '') || !secretOk(opts.secret, offeredKey(req))) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => attach(app, ws, blobTokens));
    } catch (e) {
      console.error(`Masthead could not answer a socket upgrade: ${(e as Error)?.message ?? String(e)}`);
      socket.destroy();
    }
  });

  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      const port = (server.address() as AddressInfo).port;
      boundPort = port;
      hosts.add(`127.0.0.1:${port}`).add(`localhost:${port}`);
      // In development the page is served by another local server that forwards requests here.
      for (const origin of opts.extraOrigins ?? []) hosts.add(new URL(origin).host);
      origins.add(`http://127.0.0.1:${port}`).add(`http://localhost:${port}`);
      resolveServer(server);
    });
  });
}

/** Connects a socket to the app. A remote device's socket gets its role; `onClient` lets the remote side track it. */
export function attach(app: ServedApp, ws: WebSocket, tokens: BlobTokens, remote?: { role: Client['role']; onClient?: (c: Client) => void }): void {
  const blobToken = tokens.issue();
  const client: Client = {
    blobToken,
    ...(remote ? { role: remote.role } : {}),
    send(msg: ServerMsg) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  remote?.onClient?.(client);
  app.connect(client);
  ws.on('message', (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      client.send({ t: 'error', message: 'Malformed message.' });
      return;
    }
    app.handle(client, parsed);
  });
  // A socket that stops answering pings (a sleeping laptop, a dropped network) is ended.
  let answered = true;
  ws.on('pong', () => (answered = true));
  const alive = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!answered) return void ws.terminate();
    answered = false;
    ws.ping();
  }, PING_MS);
  ws.on('close', () => {
    clearInterval(alive);
    tokens.release(blobToken);
    app.disconnect(client);
  });
  ws.on('error', () => ws.close());
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Serves the built page. `csp` differs on the remote listener (wss to the tailnet name). */
export function serveStatic(root: string, pathname: string, req: IncomingMessage, res: ServerResponse, csp: string = CSP): void {
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname));
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (rel.includes('\0')) return send(res, 400, 'Bad request');
  let file = join(root, rel);
  if (file !== root && !file.startsWith(root + sep)) return send(res, 403, 'Forbidden');
  // Decided on the URL path, not the file path: on Windows `normalize` turns `/assets/` into `\\assets\\`.
  const isAsset = posix.normalize(decodeURIComponent(pathname)).startsWith('/assets/');
  if (!isFile(file)) {
    if (isAsset || extname(rel)) return send(res, 404, 'Not found');
    file = join(root, 'index.html'); // the page handles its own routes
  }
  if (!isFile(file)) return send(res, 503, 'The web page has not been built. Run: npm run build');
  const head = {
    'x-content-type-options': 'nosniff',
    // Also keeps the ?key in the address from leaking to any other site.
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    // Built assets have a content hash in their name; the page itself must always be fresh.
    'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, head);
    return void res.end();
  }
  // The file can vanish between the check and the read (during a rebuild): answer 404, never crash.
  const stream = createReadStream(file);
  stream.on('open', () => {
    res.writeHead(200, head);
    stream.pipe(res);
  });
  stream.on('error', () => {
    if (!res.headersSent) send(res, 404, 'Not found');
    else res.destroy();
  });
  res.on('close', () => stream.destroy());
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
