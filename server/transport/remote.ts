// The private listener that only `tailscale serve` reaches: a Unix socket in a private folder where the
// platform has one; on Windows (where Tailscale cannot serve a Unix socket) a loopback port, where
// the device token is the only protection against another local program that forges the forwarded
// address. Everything here assumes a request came through tailscaled and checks it again anyway.
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { authorise, type Decision } from '../remote/authorise.js';
import type { RemoteAccess, RemoteTarget } from '../remote/access.js';
import type { Client } from '../app/clients.js';
import { BlobTokens, handleBlobGet, handleBlobPost } from './blobs.js';
import { attach, serveStatic, type ServedApp } from './http.js';
import type { BlobStore } from '../storage/blobs.js';

const MAX_BODY = 4096;
const MAX_WS_PAYLOAD = 48 * 1024 * 1024;
const DEVICE_PREFIX = 'device.';
/** Pairing requests per address per minute. */
const REQUESTS_PER_MINUTE = 10;

export function remoteCsp(origin: string): string {
  const wss = origin.replace(/^https:/, 'wss:');
  return `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ${wss}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
}

function offeredToken(req: IncomingMessage): string | undefined {
  const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
  return offered.find((p) => p.startsWith(DEVICE_PREFIX))?.slice(DEVICE_PREFIX.length);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export interface RemoteServer {
  close(): Promise<void>;
  /** Ends the sockets of one device (revoked), or of every device. */
  disconnect(nodeId?: string): void;
  /** A device's role changed: its open sockets follow at once. */
  setRole(nodeId: string, role: Client['role']): void;
  /** The loopback port when the target is a port (tests ask for 0). */
  port?: number;
}

/**
 * Starts the remote listener. `expectedHost` is `<tailnet name>:<port>`: the only name a browser on the
 * tailnet uses to reach Masthead; requests naming anything else are refused.
 */
export async function serveRemote(
  app: ServedApp,
  access: RemoteAccess,
  opts: { webDir: string; blobs?: BlobStore; convExists?: (id: string) => boolean; now?: () => number },
): Promise<RemoteServer> {
  const status = access.status;
  if (!status?.dnsName) throw new Error('Tailscale has no name for this computer.');
  const expectedHost = `${status.dnsName}:${access.port}`;
  const origin = `https://${expectedHost}`;
  const csp = remoteCsp(origin);
  const webRoot = resolve(opts.webDir);
  const tokens = new BlobTokens();
  const sockets = new Map<string, Set<{ ws: WebSocket; client: Client }>>();
  const recent = new Map<string, number[]>();
  const now = opts.now ?? Date.now;
  const deps = () => ({ tailscale: access.tailscale, registry: access.registry, ourTailnet: access.status?.tailnetId ?? '', selfNodeId: access.status?.selfNodeId ?? '' });

  /** The checks every request passes: it came through tailscale serve for our name. */
  const fromServe = (req: IncomingMessage): boolean => {
    const forwardedHost = String(req.headers['x-forwarded-host'] ?? '');
    const host = String(req.headers.host ?? '');
    // serve keeps the tailnet name as Host for a port target, and sends `localhost` to a socket target.
    const hostOk = access.target.kind === 'socket' ? host === 'localhost' || host === expectedHost : host === expectedHost;
    return forwardedHost === expectedHost && hostOk && typeof req.headers['x-forwarded-for'] === 'string';
  };
  const decide = (req: IncomingMessage, token?: string): Promise<Decision> =>
    authorise({ via: 'remote', forwardedFor: String(req.headers['x-forwarded-for'] ?? ''), token }, deps());

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!access.enabled) return json(res, 503, { code: 'refused', message: 'Remote access is switched off on that computer.' });
    if (!fromServe(req)) return json(res, 403, { code: 'refused', message: 'Forbidden' });
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      return json(res, 400, { code: 'invalid', message: 'Bad request' });
    }
    if (url.pathname === '/api/health') return json(res, 200, { name: 'masthead' });
    if (url.pathname === '/api/shutdown') return json(res, 404, { code: 'not_found', message: 'Not found' });

    if (url.pathname === '/api/remote/whoami') {
      // What an unapproved device's page asks first: who am I to this computer, and may I ask?
      const token = String(req.headers['x-masthead-device'] ?? '') || undefined;
      let d = await decide(req, token);
      // A stored token that no longer works (revoked, expired): the device may simply ask again.
      if (d.kind === 'refused' && token) {
        const fresh = await decide(req);
        if (fresh.kind === 'unknown') d = fresh;
      }
      if (d.kind === 'refused') return json(res, 200, { state: 'refused', reason: d.reason });
      if (d.kind === 'unknown') return json(res, 200, { state: 'unknown', device: { name: d.identity.nodeName, os: d.identity.os, user: d.identity.user?.login } });
      if (d.kind === 'remote') return json(res, 200, { state: 'approved', role: d.role, device: { name: d.device.nodeName } });
      return json(res, 403, { code: 'refused', message: 'Forbidden' });
    }

    if (url.pathname === '/api/remote/request' && req.method === 'POST') {
      const d = await decide(req);
      if (d.kind !== 'unknown') return json(res, 403, { code: 'refused', message: d.kind === 'refused' ? d.reason : 'Forbidden' });
      const addr = String(req.headers['x-forwarded-for']).split(',')[0]!.trim();
      for (const [k, ts] of recent) if (ts.every((t) => now() - t >= 60_000)) recent.delete(k);
      const times = (recent.get(addr) ?? []).filter((t) => now() - t < 60_000);
      if (times.length >= REQUESTS_PER_MINUTE) return json(res, 429, { code: 'refused', message: 'Too many requests; wait a minute.' });
      recent.set(addr, [...times, now()]);
      const r = access.registry.request(d.identity, addr);
      if ('refused' in r) return json(res, 403, { code: 'refused', message: r.refused });
      access.changed();
      return json(res, 200, { requestId: r.request.id, pollSecret: r.pollSecret, code: r.request.code });
    }

    const poll = /^\/api\/remote\/request\/([0-9a-f]{24})$/.exec(url.pathname);
    if (poll && req.method === 'POST') {
      const d = await decide(req);
      if (d.kind !== 'unknown' && d.kind !== 'remote') return json(res, 403, { code: 'refused', message: d.kind === 'refused' ? d.reason : 'Forbidden' });
      let secret = '';
      try {
        secret = String((JSON.parse(await readBody(req)) as { pollSecret?: unknown }).pollSecret ?? '');
      } catch {
        return json(res, 400, { code: 'invalid', message: 'Bad request' });
      }
      const c = access.registry.collect(poll[1]!, secret, d.identity.nodeId);
      if (c.state === 'allowed') access.changed();
      return json(res, 200, c);
    }

    if (opts.blobs && (url.pathname === '/blob' || url.pathname.startsWith('/blob/'))) {
      // Fetching needs only the socket's blob token; uploading needs an approved device that may send.
      if (handleBlobGet(req, res, url, { blobs: opts.blobs, tokens })) return;
      const token = String(req.headers['x-masthead-device'] ?? '') || undefined;
      const d = token && req.method === 'POST' ? await decide(req, token) : null;
      const canSend = d?.kind === 'remote' && d.role === 'full';
      if (handleBlobPost(req, res, url, { blobs: opts.blobs, authorised: canSend, convExists: opts.convExists ?? (() => false) })) return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { code: 'invalid', message: 'Method not allowed' });
    // The page holds no secret; it is served to any device that passed the checks above.
    serveStatic(webRoot, url.pathname, req, res, csp);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { code: 'invalid', message: 'Something went wrong.' });
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD, handleProtocols: () => 'masthead' });
  server.on('upgrade', (req, socket, head) => {
    const refuse = () => {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    };
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      return refuse(); // a request line no URL parser accepts
    }
    if (!access.enabled || url.pathname !== '/ws' || !fromServe(req) || req.headers.origin !== origin) return refuse();
    decide(req, offeredToken(req)).then(
      (d) => {
        if (d.kind !== 'remote') return refuse();
        access.registry.audit({ event: 'connect', nodeId: d.device.nodeId, nodeName: d.device.nodeName, user: d.device.user?.login, address: d.device.address });
        wss.handleUpgrade(req, socket, head, (ws) => {
          attach(app, ws, tokens, {
            role: d.role,
            onClient: (client) => {
              client.deviceId = d.device.nodeId;
              const set = sockets.get(d.device.nodeId) ?? new Set();
              const entry = { ws, client };
              set.add(entry);
              sockets.set(d.device.nodeId, set);
              ws.on('close', () => set.delete(entry));
            },
          });
        });
      },
      () => refuse(),
    );
  });

  const target: RemoteTarget = access.target;
  if (target.kind === 'socket') {
    privateFolder(dirname(target.path));
    try {
      unlinkSync(target.path); // a socket left by a previous run
    } catch {
      // none
    }
  }
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    const done = () => {
      server.off('error', fail);
      ok();
    };
    if (target.kind === 'socket') server.listen(target.path, done);
    else server.listen(target.port, '127.0.0.1', done);
  });
  if (target.kind === 'socket') chmodSync(target.path, 0o600);

  const all = () => [...sockets.values()].flatMap((s) => [...s]);
  return {
    port: target.kind === 'loopback' ? (server.address() as { port: number }).port : undefined,
    disconnect(nodeId?: string) {
      for (const { ws } of nodeId ? [...(sockets.get(nodeId) ?? [])] : all()) ws.close(4001, 'Access was withdrawn.');
    },
    setRole(nodeId, role) {
      for (const { client } of sockets.get(nodeId) ?? []) client.role = role;
    },
    close: () =>
      new Promise<void>((done) => {
        for (const { ws } of all()) ws.terminate();
        server.closeAllConnections?.();
        server.close(() => {
          if (target.kind === 'socket') {
            try {
              unlinkSync(target.path);
            } catch {
              // gone
            }
          }
          done();
        });
      }),
  };
}

/** Where `tailscale serve` should point on this platform. */
export function chooseTarget(env: Record<string, string | undefined>, dataDir: string, platform: NodeJS.Platform = process.platform, uid: number = process.getuid?.() ?? 0): RemoteTarget {
  // Tailscale serves Unix sockets on Unix-like systems only; Windows gets a loopback port, which any
  // local program can reach: the pairing code is the only guard there, and the settings say so.
  if (platform === 'win32') return { kind: 'loopback', port: 7719 };
  void dataDir;
  // A Unix socket path may be at most about 104 bytes (macOS) or 108 (Linux): use the runtime folder
  // when its path is short, else a private folder of our own in /tmp, so Unix never needs a port.
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && runtime.startsWith('/') && Buffer.byteLength(`${runtime}/masthead/remote.sock`) < 100) return { kind: 'socket', path: `${runtime}/masthead/remote.sock` };
  return { kind: 'socket', path: `/tmp/masthead-${uid}/remote.sock` };
}

/**
 * Makes the socket's folder ours and private. In a shared place such as /tmp someone else could have
 * made it first (or a symlink by that name): refuse rather than listen inside it.
 */
export function privateFolder(dir: string, uid: number = process.getuid?.() ?? -1): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (uid >= 0 && st.uid !== uid)) throw new Error(`${dir} is not a private folder of this user; remove it and try again.`);
  chmodSync(dir, 0o700);
}

/**
 * Keeps the remote listener in step with the switch: open while remote access is on, closed while it
 * is off; a revoked device's sockets end at once and a role change applies to open sockets.
 */
export async function startRemote(app: ServedApp, access: RemoteAccess, opts: Parameters<typeof serveRemote>[2]): Promise<{ stop(): Promise<void> }> {
  let server: RemoteServer | null = null;
  let busy = Promise.resolve();
  const sync = () => {
    busy = busy.then(async () => {
      if (access.enabled && !server && access.status?.dnsName) {
        try {
          server = await serveRemote(app, access, opts);
        } catch (e) {
          console.error(`Masthead could not open its remote listener: ${(e as Error).message}`);
        }
      } else if (!access.enabled && server) {
        const s = server;
        server = null;
        await s.close();
      }
    });
  };
  const offChange = access.onChange(sync);
  const offDevice = access.onDevice((nodeId, change) => {
    if ('revoked' in change) server?.disconnect(nodeId);
    else server?.setRole(nodeId, change.role);
  });
  await access.reconcile().catch((e) => console.error(`Masthead could not read Tailscale's state: ${(e as Error).message}`));
  sync();
  await busy;
  return {
    async stop() {
      offChange();
      offDevice();
      await busy;
      if (server) await server.close();
      server = null;
    },
  };
}
