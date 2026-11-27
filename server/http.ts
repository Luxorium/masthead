import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { VERSION, type ServerMsg } from '../shared/protocol.js';
import type { App, Client } from './app.js';

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

export interface ServeOptions {
  port: number;
  webDir: string;
  /** Extra origins allowed to open the socket, e.g. the Vite dev server. */
  extraOrigins?: string[];
  onShutdown: () => void;
}

/**
 * The server listens on 127.0.0.1 only, and it can run commands as the person, so it also refuses
 * requests a web page elsewhere could trick a browser into making: the Host header must name this
 * server (which defeats DNS rebinding) and a socket must be opened by Masthead's own page.
 */
export function serve(app: App, opts: ServeOptions): Promise<Server> {
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  // In development the page is served by another local server that forwards requests here.
  for (const origin of opts.extraOrigins ?? []) hosts.add(new URL(origin).host);
  const origins = new Set([`http://127.0.0.1:${opts.port}`, `http://localhost:${opts.port}`, ...(opts.extraOrigins ?? [])]);
  const webRoot = resolve(opts.webDir);

  const hostOk = (req: IncomingMessage) => hosts.has(req.headers.host ?? '');

  const server = createServer((req, res) => {
    if (!hostOk(req)) return void send(res, 403, 'Forbidden');
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/health') {
      return void sendJson(res, 200, { name: 'masthead', version: VERSION, pid: process.pid });
    }
    if (url.pathname === '/api/shutdown') {
      // A custom header cannot be sent cross-site without a preflight this server never grants.
      if (req.method !== 'POST' || req.headers['x-masthead'] !== '1') return void send(res, 403, 'Forbidden');
      sendJson(res, 200, { ok: true });
      setTimeout(opts.onShutdown, 50);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return void send(res, 405, 'Method not allowed');
    serveStatic(webRoot, url.pathname, req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws' || !hostOk(req) || !origins.has(req.headers.origin ?? '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(app, ws));
  });

  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolveServer(server);
    });
  });
}

function attach(app: App, ws: WebSocket): void {
  const client: Client = {
    send(msg: ServerMsg) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  };
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
  const alive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 30_000);
  ws.on('close', () => {
    clearInterval(alive);
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

function serveStatic(root: string, pathname: string, req: IncomingMessage, res: ServerResponse): void {
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname));
  } catch {
    return send(res, 400, 'Bad request');
  }
  let file = join(root, rel);
  if (!file.startsWith(root)) return send(res, 403, 'Forbidden');
  const isAsset = rel.startsWith('/assets/');
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (isAsset || extname(rel)) return send(res, 404, 'Not found');
    file = join(root, 'index.html'); // the page handles its own routes
  }
  if (!existsSync(file)) return send(res, 503, 'The web page has not been built. Run: npm run build');
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    // Built assets have a content hash in their name; the page itself must always be fresh.
    'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}
