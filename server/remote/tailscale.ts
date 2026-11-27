// The Tailscale side of remote access, behind one interface so the rest can be tested with a fake.
// Masthead only ever adds and removes its own `tailscale serve` entry (one HTTPS port it owns). It
// never runs `serve reset`, never touches another port and never uses Funnel.
import { execFile } from 'node:child_process';

/** Who is at the other end of a tailnet connection, from `tailscale whois`. */
export interface Identity {
  /** The node's stable id: the device identity Masthead binds approvals to. */
  nodeId: string;
  nodeName: string;
  os: string;
  addresses: string[];
  tagged: boolean;
  /** Absent for tagged nodes. */
  user?: { login: string; name: string };
  /** The tailnet the node belongs to; differs from ours for a node shared from another tailnet. */
  tailnetId: string;
}

export interface TailnetStatus {
  running: boolean;
  /** This machine's MagicDNS name without the trailing dot, e.g. `host.tailnet.ts.net`. */
  dnsName: string;
  tailnetId: string;
  selfNodeId: string;
  /** Whether the tailnet can issue HTTPS certificates (needed by `serve --https`). */
  https: boolean;
}

/** The state of Masthead's own serve entry on its port. */
export type ServeState =
  | { kind: 'off' }
  | { kind: 'ours' }
  | { kind: 'elsewhere'; target: string }
  | { kind: 'funnel' };

export interface TailscaleProvider {
  status(): Promise<TailnetStatus | null>;
  serveState(port: number, target: string): Promise<ServeState>;
  /** Adds Masthead's entry: `serve --bg --https=<port> <target>`. Refuses if the port is in other use. */
  addServe(port: number, target: string): Promise<void>;
  /** Removes Masthead's entry only: `serve --https=<port> off`. Refuses if the port serves something else. */
  removeServe(port: number, target: string): Promise<void>;
  whois(address: string): Promise<Identity | null>;
}

/** Runs the tailscale CLI; tests replace it. Resolves with stdout, rejects with a readable error. */
export type Runner = (args: string[]) => Promise<string>;

export const runTailscale: Runner = (args) =>
  new Promise((resolve, reject) => {
    execFile('tailscale', args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });

/** Ports Masthead may claim: unprivileged, not Tailscale's Funnel ports, not the local app's. */
export function checkServePort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid remote port: ${port}.`);
  if ([8443, 10000].includes(port)) throw new Error(`Port ${port} is one Tailscale Funnel can use; choose another.`);
  if (port === 7717) throw new Error('Port 7717 is Masthead\'s own local port; choose another.');
}

/** Masthead's own target: a private Unix socket (or, as a fallback, a loopback port). */
export function checkServeTarget(target: string): void {
  if (/^unix:\/[^\s]*$/.test(target)) return;
  if (/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(target)) return;
  throw new Error(`Masthead serves only its own socket or loopback port, not ${target}.`);
}

/** The commands Masthead may run to change serve config; anything else is a bug. */
export function addCommand(port: number, target: string): string[] {
  checkServePort(port);
  checkServeTarget(target);
  return ['serve', '--bg', `--https=${port}`, target];
}
export function removeCommand(port: number): string[] {
  checkServePort(port);
  return ['serve', `--https=${port}`, 'off'];
}

interface ServeJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
  TCP?: Record<string, unknown>;
  AllowFunnel?: Record<string, boolean>;
}

/** Reads Masthead's entry out of `tailscale serve status --json`. */
export function serveStateFrom(json: ServeJson, dnsName: string, port: number, target: string): ServeState {
  const hostPort = `${dnsName}:${port}`;
  // Only the layout Masthead understands counts as "off" or "ours". Anything else (a foreground
  // session, services, a shape from a newer Tailscale) is someone else's: refuse rather than overwrite.
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { kind: 'elsewhere', target: 'an unrecognised serve configuration' };
  const unknown = Object.entries(json).filter(([k, v]) => !['Web', 'TCP', 'AllowFunnel'].includes(k) && v !== null && !(typeof v === 'object' && Object.keys(v as object).length === 0) && v !== false);
  if (unknown.length) return { kind: 'elsewhere', target: `serve configuration Masthead does not know (${unknown.map(([k]) => k).join(', ')})` };
  if (json.AllowFunnel?.[hostPort]) return { kind: 'funnel' };
  const web = json.Web?.[hostPort];
  if (!web && !json.TCP?.[String(port)]) return { kind: 'off' };
  if (web && (typeof web.Handlers !== 'object' || web.Handlers === null)) return { kind: 'elsewhere', target: 'an unrecognised serve entry' };
  const tcp = json.TCP?.[String(port)] as Record<string, unknown> | undefined;
  if (tcp && (!web || Object.keys(tcp).some((k) => k !== 'HTTPS'))) return { kind: 'elsewhere', target: 'a TCP forward' };
  const handlers = web?.Handlers ?? {};
  const names = Object.keys(handlers);
  const root = handlers['/'];
  const what = root?.Proxy ?? root?.Path ?? root?.Text ?? 'another service';
  if (names.length === 1 && root?.Proxy === target) return { kind: 'ours' };
  return { kind: 'elsewhere', target: names.length === 1 ? what : `${names.length} handlers` };
}

/** Parses `tailscale whois --json`. */
export function identityFrom(json: unknown): Identity | null {
  const j = json as { Node?: Record<string, unknown>; UserProfile?: { LoginName?: string; DisplayName?: string } } | null;
  const n = j?.Node;
  if (!n || typeof n.StableID !== 'string') return null;
  const tags = Array.isArray(n.Tags) ? (n.Tags as string[]) : [];
  const hostinfo = (n.Hostinfo ?? {}) as { OS?: string; Hostname?: string };
  const tagged = tags.length > 0;
  return {
    nodeId: n.StableID,
    nodeName: String(n.ComputedName ?? hostinfo.Hostname ?? n.Name ?? '').replace(/\.$/, ''),
    os: hostinfo.OS ?? '',
    addresses: Array.isArray(n.Addresses) ? (n.Addresses as string[]).map((a) => a.replace(/\/\d+$/, '')) : [],
    tagged,
    user: !tagged && j?.UserProfile?.LoginName ? { login: j.UserProfile.LoginName, name: j.UserProfile.DisplayName ?? j.UserProfile.LoginName } : undefined,
    tailnetId: typeof n.StableTailnetID === 'string' ? n.StableTailnetID : '',
  };
}

/** The real provider, using the `tailscale` command. */
export class CliTailscale implements TailscaleProvider {
  constructor(private run: Runner = runTailscale) {}

  async status(): Promise<TailnetStatus | null> {
    try {
      const j = JSON.parse(await this.run(['status', '--json'])) as {
        BackendState?: string;
        Self?: { DNSName?: string; ID?: string; CapMap?: Record<string, unknown> };
        CurrentTailnet?: { StableID?: string };
      };
      return {
        running: j.BackendState === 'Running',
        dnsName: (j.Self?.DNSName ?? '').replace(/\.$/, ''),
        tailnetId: j.CurrentTailnet?.StableID ?? '',
        selfNodeId: j.Self?.ID ?? '',
        https: !!j.Self?.CapMap && 'https' in j.Self.CapMap,
      };
    } catch {
      return null;
    }
  }

  private async serveJson(): Promise<ServeJson> {
    const out = (await this.run(['serve', 'status', '--json'])).trim();
    return out ? (JSON.parse(out) as ServeJson) : {};
  }

  async serveState(port: number, target: string): Promise<ServeState> {
    const s = await this.status();
    if (!s?.dnsName) throw new Error('Tailscale is not running or has no name for this machine.');
    return serveStateFrom(await this.serveJson(), s.dnsName, port, target);
  }

  async addServe(port: number, target: string): Promise<void> {
    const cmd = addCommand(port, target);
    const state = await this.serveState(port, target);
    if (state.kind === 'ours') return;
    if (state.kind !== 'off') throw new Error(`Port ${port} on Tailscale is already in use (${state.kind === 'funnel' ? 'Funnel' : state.target}). Choose another port.`);
    await this.run(cmd);
  }

  async removeServe(port: number, target: string): Promise<void> {
    const cmd = removeCommand(port);
    const state = await this.serveState(port, target);
    if (state.kind === 'off') return;
    if (state.kind !== 'ours') throw new Error(`Port ${port} on Tailscale serves something other than Masthead; left as it is.`);
    await this.run(cmd);
  }

  async whois(address: string): Promise<Identity | null> {
    if (!/^[0-9a-fA-F:.]+$/.test(address)) return null;
    try {
      return identityFrom(JSON.parse(await this.run(['whois', '--json', address])));
    } catch {
      return null;
    }
  }
}

/** A stand-in for tests: records every command it would have run. */
export class FakeTailscale implements TailscaleProvider {
  commands: string[][] = [];
  identities = new Map<string, Identity>();
  serve: ServeJson = {};
  constructor(public tailnet: TailnetStatus | null = { running: true, dnsName: 'host.example.ts.net', tailnetId: 'T1', selfNodeId: 'nSELF', https: true }) {}
  async status() {
    return this.tailnet;
  }
  async serveState(port: number, target: string) {
    if (!this.tailnet) throw new Error('Tailscale is not running.');
    return serveStateFrom(this.serve, this.tailnet.dnsName, port, target);
  }
  async addServe(port: number, target: string) {
    const cmd = addCommand(port, target);
    const state = await this.serveState(port, target);
    if (state.kind === 'ours') return;
    if (state.kind !== 'off') throw new Error(`Port ${port} on Tailscale is already in use.`);
    this.commands.push(cmd);
    (this.serve.Web ??= {})[`${this.tailnet!.dnsName}:${port}`] = { Handlers: { '/': { Proxy: target } } };
    (this.serve.TCP ??= {})[String(port)] = { HTTPS: true };
  }
  async removeServe(port: number, target: string) {
    const cmd = removeCommand(port);
    const state = await this.serveState(port, target);
    if (state.kind === 'off') return;
    if (state.kind !== 'ours') throw new Error(`Port ${port} serves something else.`);
    this.commands.push(cmd);
    delete this.serve.Web?.[`${this.tailnet!.dnsName}:${port}`];
    delete this.serve.TCP?.[String(port)];
  }
  async whois(address: string) {
    return this.identities.get(address) ?? null;
  }
}

/**
 * Wraps a provider so a burst of requests from the tailnet cannot start a `tailscale whois` each: an
 * address's answer is kept for a minute, and at most a few lookups run at once (the rest wait).
 */
export class CachedWhois implements TailscaleProvider {
  private cache = new Map<string, { at: number; id: Identity | null; pending?: Promise<Identity | null> }>();
  private running = 0;
  private waiting: Array<() => void> = [];
  constructor(
    private inner: TailscaleProvider,
    private opts: { ttlMs?: number; maxConcurrent?: number; now?: () => number } = {},
  ) {}
  status() {
    return this.inner.status();
  }
  serveState(port: number, target: string) {
    return this.inner.serveState(port, target);
  }
  addServe(port: number, target: string) {
    return this.inner.addServe(port, target);
  }
  removeServe(port: number, target: string) {
    return this.inner.removeServe(port, target);
  }
  async whois(address: string): Promise<Identity | null> {
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(address);
    if (hit?.pending) return hit.pending;
    if (hit && now - hit.at < (this.opts.ttlMs ?? 60_000)) return hit.id;
    const pending = this.limited(() => this.inner.whois(address));
    this.cache.set(address, { at: now, id: null, pending });
    const id = await pending.catch(() => null);
    // Only answers are kept: a failed or empty lookup (tailscaled restarting) must not lock a device out.
    if (id) this.cache.set(address, { at: now, id });
    else this.cache.delete(address);
    if (this.cache.size > 1000) this.cache.clear();
    return id;
  }
  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= (this.opts.maxConcurrent ?? 4)) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
