// The one decision the transport asks for: may this request go on, and as whom?
import type { Device, DeviceRegistry, Role } from './registry.js';
import { refusalFor } from './registry.js';
import type { Identity } from './tailscale.js';
import type { TailscaleProvider } from './tailscale.js';

export interface RequestFacts {
  /** Which listener the request arrived on. Only the private remote socket is ever treated as remote. */
  via: 'loopback' | 'remote';
  /** X-Forwarded-For as received; set by tailscaled on the remote socket, ignored on loopback. */
  forwardedFor?: string;
  /** The device token offered, if any. */
  token?: string;
}

export type Decision =
  | { kind: 'local' }
  | { kind: 'remote'; role: Role; device: Device; identity: Identity }
  | { kind: 'unknown'; identity: Identity }
  | { kind: 'refused'; reason: string };

/**
 * Decides what a request is.
 * - On the loopback listener it is local, whatever Tailscale or forwarding headers it carries: such
 *   headers there can only be forged by a local process. (The local secret check stays in http.ts.)
 * - On the remote socket the forwarded address is looked up with whois; the node must not be this
 *   machine, must pass the tailnet and tag rules, and a token must be that node's own current token.
 */
export async function authorise(facts: RequestFacts, deps: { tailscale: TailscaleProvider; registry: DeviceRegistry; ourTailnet: string; selfNodeId: string }): Promise<Decision> {
  if (facts.via === 'loopback') return { kind: 'local' };
  const addr = (facts.forwardedFor ?? '').split(',')[0]!.trim();
  if (!addr) return { kind: 'refused', reason: 'no forwarded address' };
  const identity = await deps.tailscale.whois(addr);
  if (!identity) return { kind: 'refused', reason: 'unknown tailnet address' };
  if (identity.nodeId === deps.selfNodeId) return { kind: 'refused', reason: 'this machine uses the local address' };
  const why = refusalFor(identity, deps.ourTailnet, deps.registry.options);
  if (why) {
    deps.registry.audit({ event: 'refuse', nodeId: identity.nodeId, nodeName: identity.nodeName, user: identity.user?.login, address: addr, detail: why });
    return { kind: 'refused', reason: why };
  }
  if (!facts.token) return { kind: 'unknown', identity };
  const device = deps.registry.check(identity.nodeId, facts.token, addr);
  if (device) return { kind: 'remote', role: device.role, device, identity };
  const owner = deps.registry.ownerOf(facts.token);
  const detail = owner ? `token of ${owner.nodeName} offered from another node` : 'unknown or expired token';
  deps.registry.audit({ event: 'refuse', nodeId: identity.nodeId, nodeName: identity.nodeName, user: identity.user?.login, address: addr, detail });
  return { kind: 'refused', reason: detail };
}

/** Which browser messages each role may send. `full` may send everything except device management. */
// Reading includes the version 2 connection messages (subscribe, resync, drafts, whole items).
const READ = new Set(['hello', 'open', 'items', 'subscribe', 'unsubscribe', 'draft_sync', 'item_full', 'archive_items']);
const APPROVE = new Set([...READ, 'permission', 'interrupt', 'stop_agent', 'stop_all', 'check_backends', 'compact_answer', 'compact_cancel']);
const LOCAL_ONLY = new Set(['device_decision', 'device_revoke', 'device_role', 'remote_settings', 'remote_audit', 'shutdown']);

export function allowedMessage(role: Role | 'local', type: string): boolean {
  // A device may always forget itself; the local browser has nothing to forget.
  if (type === 'forget_me') return role !== 'local';
  if (role === 'local') return true;
  if (LOCAL_ONLY.has(type)) return false;
  if (role === 'full') return true;
  return (role === 'approve' ? APPROVE : READ).has(type);
}
