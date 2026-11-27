// Remote access as a whole: the on/off switch, Masthead's own `tailscale serve` entry, the device
// registry, and the state shown to local sessions. The transport (server/transport/remote.ts) opens
// and closes the private listener when told; App relays the person's decisions.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../storage/atomic.js';
import { DeviceRegistry, ROLES, type AuditEntry, type Device, type Role } from './registry.js';
import { CachedWhois, type ServeState, type TailnetStatus, type TailscaleProvider } from './tailscale.js';

export const DEFAULT_REMOTE_PORT = 7443;

/** What Tailscale's `serve` points at: a private Unix socket, or (Windows) a loopback port. */
export type RemoteTarget = { kind: 'socket'; path: string } | { kind: 'loopback'; port: number };

export function targetUrl(t: RemoteTarget): string {
  return t.kind === 'socket' ? `unix:${t.path}` : `http://127.0.0.1:${t.port}`;
}

export interface RemoteConfig {
  version: 1;
  enabled: boolean;
  port: number;
  allowOtherTailnets: boolean;
  allowTagged: boolean;
}

/** Shown to local sessions only. */
export interface RemoteState {
  enabled: boolean;
  port: number;
  /** Tailscale is installed, running and can issue HTTPS certificates. */
  available: boolean;
  /** `https://<name>.ts.net:<port>` while switched on. */
  url?: string;
  serve: ServeState['kind'] | 'unknown';
  /** What is wrong, in plain words, and the command that fixes it if there is one. */
  problem?: string;
  command?: string;
  target: RemoteTarget['kind'];
  /** Said plainly when the target is a loopback port (Windows): what the person must watch for. */
  warning?: string;
  allowOtherTailnets: boolean;
  allowTagged: boolean;
  devices: Array<Omit<Device, 'tokenHash'>>;
  requests: Array<{ id: string; nodeName: string; os: string; user?: { login: string; name: string }; address: string; code: string; createdAt: number }>;
}

const DEFAULTS: RemoteConfig = { version: 1, enabled: false, port: DEFAULT_REMOTE_PORT, allowOtherTailnets: false, allowTagged: false };

/** The fix for "only root or the operator may change serve config". */
export function operatorCommand(platform: NodeJS.Platform = process.platform, user = process.env.USER ?? process.env.USERNAME ?? '$USER'): string {
  return platform === 'win32' ? 'Run Tailscale as an administrator, or ask your tailnet admin.' : `sudo tailscale set --operator=${user}`;
}

function looksLikePermission(message: string): boolean {
  return /access denied|permission|operator|not permitted|must be root|requires root/i.test(message);
}

export class RemoteAccess {
  readonly registry: DeviceRegistry;
  private config: RemoteConfig;
  private file: string;
  private tailnet: TailnetStatus | null = null;
  private serveKind: RemoteState['serve'] = 'unknown';
  private problem: { text: string; command?: string } | null = null;
  private listeners = new Set<() => void>();
  private deviceListeners = new Set<(nodeId: string, change: { revoked: true } | { role: Role }) => void>();

  constructor(
    private opts: { dir: string; tailscale: TailscaleProvider; target: RemoteTarget; now?: () => number; platform?: NodeJS.Platform },
  ) {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    this.file = join(opts.dir, 'config.json');
    this.config = this.load();
    this.registry = new DeviceRegistry({
      dir: opts.dir,
      now: opts.now,
      allowOtherTailnets: this.config.allowOtherTailnets,
      allowTagged: this.config.allowTagged,
      loopback: opts.target.kind === 'loopback',
      // An approval that runs out ends the device's open sockets, as a revoke does.
      onExpire: (nodeId) => {
        for (const fn of this.deviceListeners) fn(nodeId, { revoked: true });
      },
    });
    this.provider = new CachedWhois(opts.tailscale, { now: opts.now });
  }

  private provider: TailscaleProvider;
  get tailscale(): TailscaleProvider {
    return this.provider;
  }
  get target(): RemoteTarget {
    return this.opts.target;
  }
  get enabled(): boolean {
    return this.config.enabled;
  }
  get port(): number {
    return this.config.port;
  }
  get status(): TailnetStatus | null {
    return this.tailnet;
  }

  private load(): RemoteConfig {
    try {
      const r = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<RemoteConfig>;
      if (r?.version !== 1) return { ...DEFAULTS };
      return {
        version: 1,
        enabled: r.enabled === true,
        port: Number.isInteger(r.port) && r.port! >= 1024 && r.port! <= 65535 ? r.port! : DEFAULT_REMOTE_PORT,
        allowOtherTailnets: r.allowOtherTailnets === true,
        allowTagged: r.allowTagged === true,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.config, null, 2) + '\n');
  }

  /** Called on every change the local pages should see. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  changed(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * At start-up: brings Tailscale's state and Masthead's setting together. The setting wins: an entry
   * of ours left on while the setting is off is removed; a setting that is on re-adds a missing entry.
   * Someone else's entry on our port is never touched.
   */
  async reconcile(): Promise<void> {
    await this.refresh();
    if (!this.tailnet?.running) return;
    if (this.config.enabled && this.serveKind === 'off') await this.apply(true);
    else if (!this.config.enabled && this.serveKind === 'ours') await this.apply(false);
  }

  /** Reads Tailscale's state again (status and our serve entry). Never changes anything. */
  async refresh(): Promise<void> {
    this.tailnet = await this.opts.tailscale.status();
    if (!this.tailnet?.running) {
      this.serveKind = 'unknown';
      this.problem = { text: this.tailnet ? 'Tailscale is not connected on this computer.' : 'Tailscale is not installed or not running on this computer.' };
      this.changed();
      return;
    }
    try {
      this.serveKind = (await this.opts.tailscale.serveState(this.config.port, targetUrl(this.opts.target))).kind;
      this.problem = this.problemFor(this.serveKind);
    } catch (e) {
      this.serveKind = 'unknown';
      this.problem = { text: (e as Error).message };
    }
    this.changed();
  }

  private problemFor(kind: RemoteState['serve']): { text: string; command?: string } | null {
    if (!this.tailnet?.https) return { text: 'HTTPS certificates are switched off for this tailnet; turn on HTTPS in the Tailscale admin console.' };
    if (kind === 'funnel') return { text: `Port ${this.config.port} is published to the internet with Tailscale Funnel. Masthead will not serve there; turn Funnel off or choose another port.` };
    if (kind === 'elsewhere') return { text: `Port ${this.config.port} on Tailscale already serves something else. Choose another port.` };
    if (this.config.enabled && kind === 'off') return { text: 'Remote access is on, but Tailscale is not serving Masthead yet.' };
    return null;
  }

  /** The switch. Adds or removes only Masthead's own serve entry; refusals come back as a problem. */
  async setEnabled(on: boolean): Promise<{ ok: boolean; problem?: string; command?: string }> {
    await this.refresh();
    if (!this.tailnet?.running) return { ok: false, problem: this.problem?.text };
    if (on && !this.tailnet.https) return { ok: false, problem: this.problemFor('off')?.text };
    const result = await this.apply(on);
    if (result.ok) {
      this.config.enabled = on;
      this.save();
      this.registry.audit({ event: 'switch', detail: on ? 'remote access switched on' : 'remote access switched off' });
      await this.refresh();
    }
    // A refusal keeps its message (and the command that fixes it) on show.
    return result;
  }

  private async apply(on: boolean): Promise<{ ok: boolean; problem?: string; command?: string }> {
    const target = targetUrl(this.opts.target);
    try {
      if (on) await this.opts.tailscale.addServe(this.config.port, target);
      else await this.opts.tailscale.removeServe(this.config.port, target);
      this.problem = null;
      return { ok: true };
    } catch (e) {
      const message = (e as Error).message;
      if (looksLikePermission(message)) {
        const command = operatorCommand(this.opts.platform);
        this.problem = { text: `Tailscale did not let Masthead change its settings. Make yourself the Tailscale operator once, then switch remote access on again.`, command };
      } else {
        this.problem = { text: message };
      }
      this.changed();
      return { ok: false, problem: this.problem.text, command: this.problem.command };
    }
  }

  /** Port and policy, while switched off (changing the port of a live entry is off, change, on). */
  configure(patch: { port?: unknown; allowOtherTailnets?: unknown; allowTagged?: unknown }): void {
    if (patch.port !== undefined) {
      const p = Number(patch.port);
      if (this.config.enabled) throw new Error('Switch remote access off before changing its port.');
      if (!Number.isInteger(p) || p < 1024 || p > 65535 || [7717, 8443, 10000].includes(p)) throw new Error('Choose a port from 1024 to 65535 that is not 7717, 8443 or 10000.');
      this.config.port = p;
    }
    if (typeof patch.allowOtherTailnets === 'boolean') this.config.allowOtherTailnets = patch.allowOtherTailnets;
    if (typeof patch.allowTagged === 'boolean') this.config.allowTagged = patch.allowTagged;
    this.registry.setPolicy(this.config);
    this.save();
    this.changed();
  }

  /** Open sockets of a device must follow a revoke or a role change at once; the transport listens. */
  onDevice(fn: (nodeId: string, change: { revoked: true } | { role: Role }) => void): () => void {
    this.deviceListeners.add(fn);
    return () => this.deviceListeners.delete(fn);
  }

  revoke(nodeId: string): void {
    if (!this.registry.revoke(nodeId)) throw new Error('That device is not allowed anyway.');
    for (const fn of this.deviceListeners) fn(nodeId, { revoked: true });
    this.changed();
  }

  setRole(nodeId: string, role: unknown): void {
    if (!ROLES.includes(role as Role) || !this.registry.setRole(nodeId, role as Role)) throw new Error('Unknown device or role.');
    for (const fn of this.deviceListeners) fn(nodeId, { role: role as Role });
    this.changed();
  }

  /** The person's decisions, from a local session. */
  decide(requestId: string, decision: 'allow' | 'deny', role: unknown = 'full'): void {
    if (decision === 'allow') {
      if (!ROLES.includes(role as Role)) throw new Error('Unknown role.');
      if (!this.registry.allow(requestId, role as Role)) throw new Error('That request is no longer waiting.');
    } else if (!this.registry.deny(requestId)) throw new Error('That request is no longer waiting.');
    this.changed();
  }

  state(): RemoteState {
    const url = this.tailnet?.dnsName && this.config.enabled ? `https://${this.tailnet.dnsName}:${this.config.port}` : undefined;
    return {
      enabled: this.config.enabled,
      port: this.config.port,
      available: !!this.tailnet?.running && !!this.tailnet.https,
      ...(url ? { url } : {}),
      serve: this.serveKind,
      ...(this.problem ? { problem: this.problem.text, ...(this.problem.command ? { command: this.problem.command } : {}) } : {}),
      target: this.opts.target.kind,
      ...(this.opts.target.kind === 'loopback'
        ? { warning: 'On this computer Tailscale reaches Masthead through a local port, so another program on this computer, including one run by another user account, could pretend to be one of your devices. Approve a device only while you are pairing it, and only when the code on its screen matches.' }
        : {}),
      allowOtherTailnets: this.config.allowOtherTailnets,
      allowTagged: this.config.allowTagged,
      devices: this.registry.list().map(({ tokenHash: _t, ...d }) => d),
      requests: this.registry.requests().map(({ id, nodeName, os, user, address, code, createdAt }) => ({ id, nodeName, os, user, address, code, createdAt })),
    };
  }

  audit(limit = 100): AuditEntry[] {
    return this.registry.readAudit(limit);
  }
}
