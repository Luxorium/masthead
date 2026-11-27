// Devices allowed to use Masthead over the tailnet: pending requests with pairing codes, approval,
// roles, tokens bound to the Tailscale node, expiry, revocation, and an audit log. Pure logic plus a
// small versioned file; the transport calls it and never decides on its own.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
  /**
   * The remote listener is a loopback port (Windows), where any local program can claim to be any
   * device: then a device may have a few waiting requests (each its own code and poll secret; the
   * matching code is the guard) and a denial locks out that request only, not the whole device.
   */
  loopback?: boolean;
  /** Called when a device's approval ends by expiry, so its open sockets can be closed. */
  onExpire?: (nodeId: string) => void;
}

const FILE_VERSION = 1;
/** Pending requests one tailnet user (or all tagged nodes together) may have at once. */
const MAX_PENDING_PER_USER = 3;
/** Waiting requests one device may have when the listener is a loopback port. */
const MAX_PENDING_PER_NODE_LOOPBACK = 3;
/** The audit log is moved aside past this size; reads take a bounded tail. */
const AUDIT_MAX_BYTES = 1024 * 1024;
const AUDIT_TAIL_BYTES = 256 * 1024;
/** One refusal line per node and reason per this long, so a noisy device cannot fill the disk. */
const REFUSE_LOG_MS = 60_000;
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

  private refusalsLogged = new Map<string, number>();

  audit(e: Omit<AuditEntry, 'ts'>): void {
    if (e.event === 'refuse') {
      const key = `${e.nodeId ?? e.address ?? ''}|${e.detail ?? ''}`;
      const last = this.refusalsLogged.get(key);
      if (last !== undefined && this.now() - last < REFUSE_LOG_MS) return;
      this.refusalsLogged.set(key, this.now());
      if (this.refusalsLogged.size > 1000) this.refusalsLogged.clear();
    }
    try {
      try {
        if (statSync(this.auditFile).size > AUDIT_MAX_BYTES) renameSync(this.auditFile, `${this.auditFile}.1`);
      } catch {
        // no log yet
      }
      appendFileSync(this.auditFile, JSON.stringify({ ts: this.now(), ...e }) + '\n', { mode: 0o600 });
    } catch {
      // A full disk must not stop remote access decisions.
    }
  }

  /** The newest entries, from a bounded tail of the log. */
  readAudit(limit = 100): AuditEntry[] {
    try {
      const fd = openSync(this.auditFile, 'r');
      try {
        const size = fstatSync(fd).size;
        const len = Math.min(size, AUDIT_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString('utf8').split('\n');
        if (len < size) lines.shift(); // a partial first line
        const out: AuditEntry[] = [];
        for (const l of lines.filter(Boolean).slice(-limit)) {
          try {
            out.push(JSON.parse(l) as AuditEntry);
          } catch {
            // a torn line
          }
        }
        return out;
      } finally {
        closeSync(fd);
      }
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
        this.opts.onExpire?.(d.nodeId);
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
    // One waiting request per node, and its poll secret never changes: a second asker (on a loopback
    // listener, another local user forging this node's address) must not take over the first one's
    // request. The device keeps its poll secret; a page that lost it waits for the request to expire.
    const waiting = [...this.pending.values()].filter((p) => p.nodeId === id.nodeId && !p.denied).length;
    if (waiting >= (this.opts.loopback ? MAX_PENDING_PER_NODE_LOOPBACK : 1)) {
      return { refused: 'A request from this device is already waiting for approval.' };
    }
    if (this.pending.size >= MAX_PENDING) return { refused: 'Too many devices are waiting for approval.' };
    const owner = id.user?.login ?? 'tagged';
    if ([...this.pending.values()].filter((p) => (p.user?.login ?? 'tagged') === owner).length >= MAX_PENDING_PER_USER * (this.opts.loopback ? 2 : 1)) {
      return { refused: 'Too many devices of this tailnet user are waiting for approval.' };
    }
    const pollSecret = randomBytes(24).toString('hex');
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
    // On a loopback listener the device id may have been claimed by someone else: lock out nothing more.
    if (!this.opts.loopback) this.deniedUntil.set(p.nodeId, this.now() + DENY_COOLDOWN_MS);
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
