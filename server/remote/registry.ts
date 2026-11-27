// Devices allowed to use Masthead over the tailnet: pending requests with pairing codes, approval,
// roles, tokens bound to the Tailscale node, expiry, revocation, and an audit log. Pure logic plus a
// small versioned file; the transport calls it and never decides on its own.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Identity } from './tailscale.js';

/** What an approved device may do. `full` is everything the local browser can, except shutting down. */
export type Role = 'full' | 'approve' | 'read';
export const ROLES: readonly Role[] = ['full', 'approve', 'read'];

export interface Device {
  /** The Tailscale node's stable id. */
  nodeId: string;
  nodeName: string;
  os: string;
  user?: { login: string; name: string };
  address: string;
  role: Role;
  /** SHA-256 of the token, hex. The token itself is never stored. */
  tokenHash: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
}

export interface PendingRequest {
  id: string;
  nodeId: string;
  nodeName: string;
  os: string;
  user?: { login: string; name: string };
  address: string;
  /** Six digits the device shows; the person checks they match before allowing. */
  code: string;
  createdAt: number;
  /** Hash of the secret the device polls with; only it can collect the token. */
  pollHash: string;
  /** Set once approved, until the device collects it. */
  token?: string;
  role?: Role;
  denied?: boolean;
}

export interface AuditEntry {
  ts: number;
  event: 'request' | 'allow' | 'deny' | 'revoke' | 'expire' | 'role' | 'connect' | 'refuse' | 'collect' | 'switch';
  nodeId?: string;
  nodeName?: string;
  user?: string;
  address?: string;
  detail?: string;
}

export interface RegistryOptions {
  /** Folder for `devices.json` and `audit.jsonl`, e.g. `<DATA_DIR>/remote`. Created 0700. */
  dir: string;
  now?: () => number;
  tokenDays?: number;
  allowOtherTailnets?: boolean;
  allowTagged?: boolean;
}

const FILE_VERSION = 1;
const DAY = 24 * 3600 * 1000;
const PENDING_MS = 10 * 60 * 1000;
const DENY_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_PENDING = 20;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Why a device cannot even ask, or null if it may. */
export function refusalFor(id: Identity, ourTailnet: string, opts: { allowOtherTailnets?: boolean; allowTagged?: boolean }): string | null {
  if (id.tagged && !opts.allowTagged) return 'tagged devices are not allowed';
  if (ourTailnet && id.tailnetId && id.tailnetId !== ourTailnet && !opts.allowOtherTailnets) return 'devices from other tailnets are not allowed';
  return null;
}

export class DeviceRegistry {
  private devices = new Map<string, Device>();
  private pending = new Map<string, PendingRequest>();
  private deniedUntil = new Map<string, number>();
  private now: () => number;
  private file: string;
  private auditFile: string;

  constructor(private opts: RegistryOptions) {
    this.now = opts.now ?? Date.now;
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    chmodSync(opts.dir, 0o700);
    this.file = join(opts.dir, 'devices.json');
    this.auditFile = join(opts.dir, 'audit.jsonl');
    this.load();
  }

  get tokenMs(): number {
    return (this.opts.tokenDays ?? 30) * DAY;
  }

  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return; // none yet, or unreadable: nobody is approved
    }
    const r = raw as { version?: number; devices?: Device[] };
    if (r?.version !== FILE_VERSION || !Array.isArray(r.devices)) return;
    for (const d of r.devices) if (d && typeof d.nodeId === 'string' && typeof d.tokenHash === 'string' && ROLES.includes(d.role)) this.devices.set(d.nodeId, d);
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, devices: [...this.devices.values()] }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  audit(e: Omit<AuditEntry, 'ts'>): void {
    try {
      appendFileSync(this.auditFile, JSON.stringify({ ts: this.now(), ...e }) + '\n', { mode: 0o600 });
    } catch {
      // A full disk must not stop remote access decisions.
    }
  }

  readAudit(limit = 100): AuditEntry[] {
    try {
      return readFileSync(this.auditFile, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l) as AuditEntry);
    } catch {
      return [];
    }
  }

  list(): Device[] {
    this.sweep();
    return [...this.devices.values()];
  }

  requests(): PendingRequest[] {
    this.sweep();
    return [...this.pending.values()].filter((p) => !p.token && !p.denied);
  }

  /** Drops expired devices and stale requests. */
  sweep(): void {
    const now = this.now();
    let changed = false;
    for (const d of this.devices.values()) {
      if (d.expiresAt <= now) {
        this.devices.delete(d.nodeId);
        changed = true;
        this.audit({ event: 'expire', nodeId: d.nodeId, nodeName: d.nodeName, user: d.user?.login });
      }
    }
    if (changed) this.save();
    for (const p of this.pending.values()) if (now - p.createdAt > PENDING_MS) this.pending.delete(p.id);
  }

  /**
   * A device asks to be allowed. One open request per node; asking again returns the same code (with
   * a new poll secret). Returns the poll secret, which only this caller gets.
   */
  request(id: Identity, address: string): { request: PendingRequest; pollSecret: string } | { refused: string } {
    this.sweep();
    const until = this.deniedUntil.get(id.nodeId);
    if (until && until > this.now()) {
      this.audit({ event: 'refuse', nodeId: id.nodeId, nodeName: id.nodeName, user: id.user?.login, address, detail: 'denied recently' });
      return { refused: 'This device was turned down recently; try again later.' };
    }
    const pollSecret = randomBytes(24).toString('hex');
    const existing = [...this.pending.values()].find((p) => p.nodeId === id.nodeId && !p.denied);
    if (existing) {
      existing.pollHash = sha(pollSecret);
      return { request: existing, pollSecret };
    }
    if (this.pending.size >= MAX_PENDING) return { refused: 'Too many devices are waiting for approval.' };
    const request: PendingRequest = {
      id: randomBytes(12).toString('hex'),
      nodeId: id.nodeId,
      nodeName: id.nodeName,
      os: id.os,
      user: id.user,
      address,
      code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
      createdAt: this.now(),
      pollHash: sha(pollSecret),
    };
    this.pending.set(request.id, request);
    this.audit({ event: 'request', nodeId: id.nodeId, nodeName: id.nodeName, user: id.user?.login, address });
    return { request, pollSecret };
  }

  /** The person allows a request. The token waits for the device to collect it. */
  allow(requestId: string, role: Role = 'full'): Device | null {
    const p = this.pending.get(requestId);
    if (!p || p.denied || p.token || !ROLES.includes(role)) return null;
    const token = randomBytes(32).toString('hex');
    const now = this.now();
    const device: Device = { nodeId: p.nodeId, nodeName: p.nodeName, os: p.os, user: p.user, address: p.address, role, tokenHash: sha(token), createdAt: now, lastSeen: now, expiresAt: now + this.tokenMs };
    this.devices.set(p.nodeId, device); // replaces any earlier approval of that node and its token
    this.save();
    p.token = token;
    p.role = role;
    this.audit({ event: 'allow', nodeId: p.nodeId, nodeName: p.nodeName, user: p.user?.login, address: p.address, detail: role });
    return device;
  }

  deny(requestId: string): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.token) return false;
    p.denied = true;
    this.pending.delete(requestId);
    this.deniedUntil.set(p.nodeId, this.now() + DENY_COOLDOWN_MS);
    this.audit({ event: 'deny', nodeId: p.nodeId, nodeName: p.nodeName, user: p.user?.login, address: p.address });
    return true;
  }

  /**
   * The waiting device polls with its secret. Returns 'pending', 'denied'/'gone', or the token once.
   * The node must be the one that asked.
   */
  collect(requestId: string, pollSecret: string, nodeId: string): { state: 'pending' } | { state: 'gone' } | { state: 'allowed'; token: string; role: Role } {
    const p = this.pending.get(requestId);
    if (!p || p.nodeId !== nodeId || !sameHash(sha(pollSecret), p.pollHash)) return { state: 'gone' };
    if (!p.token) return { state: 'pending' };
    this.pending.delete(requestId);
    this.audit({ event: 'collect', nodeId: p.nodeId, nodeName: p.nodeName, user: p.user?.login, address: p.address });
    return { state: 'allowed', token: p.token, role: p.role! };
  }

  revoke(nodeId: string): boolean {
    const d = this.devices.get(nodeId);
    if (!d) return false;
    this.devices.delete(nodeId);
    this.save();
    this.audit({ event: 'revoke', nodeId, nodeName: d.nodeName, user: d.user?.login });
    return true;
  }

  setRole(nodeId: string, role: Role): boolean {
    const d = this.devices.get(nodeId);
    if (!d || !ROLES.includes(role)) return false;
    d.role = role;
    this.save();
    this.audit({ event: 'role', nodeId, nodeName: d.nodeName, user: d.user?.login, detail: role });
    return true;
  }

  /** The device for this token, if it is the node's current token and has not expired. Renews on use. */
  check(nodeId: string, token: string, address: string): Device | null {
    this.sweep();
    const d = this.devices.get(nodeId);
    if (!d || !/^[0-9a-f]{64}$/.test(token) || !sameHash(sha(token), d.tokenHash)) return null;
    const now = this.now();
    d.lastSeen = now;
    d.address = address;
    // Renewed on use; written at most once an hour so a busy socket does not rewrite the file.
    if (d.expiresAt - now < this.tokenMs - 3600_000) {
      d.expiresAt = now + this.tokenMs;
      this.save();
    }
    return d;
  }

  /** Whether some approved device holds this token, whichever node presents it (to log copied tokens). */
  ownerOf(token: string): Device | null {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const h = sha(token);
    return [...this.devices.values()].find((d) => sameHash(h, d.tokenHash)) ?? null;
  }

  /** Changes who may ask (the person's setting). */
  setPolicy(p: { allowOtherTailnets: boolean; allowTagged: boolean }): void {
    this.opts.allowOtherTailnets = p.allowOtherTailnets;
    this.opts.allowTagged = p.allowTagged;
  }

  get options(): { allowOtherTailnets: boolean; allowTagged: boolean } {
    return { allowOtherTailnets: !!this.opts.allowOtherTailnets, allowTagged: !!this.opts.allowTagged };
  }
}
