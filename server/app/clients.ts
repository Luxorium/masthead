// The browser tabs and what each one is sent. App publishes version 1 events here; each tab gets them
// in the form it asked for:
// - a version 1 tab (0.1.x page, or one that has not said hello with protocol 2) gets them unchanged;
// - a version 2 tab gets list-level events always, and a conversation's detailed events (agents,
//   items, drafts as deltas, full approval requests) only while subscribed to it, each with a
//   per-conversation `seq` so it can resync after a reconnect.
// Every message a tab sends passes `admit()` first: the one place a remote device's role (see
// server/remote/authorise.ts) is enforced.
import type { AgentInfo, AppState, ConversationMeta, Draft, Item, PermissionRequest, ServerMsg } from '../../shared/protocol.js';
import { randomBytes } from 'node:crypto';
import { CLIP_CHARS, PROTOCOL_VERSION, RING_SIZE, type ApprovalSummary, type Capability, type ErrorCode } from '../../shared/protocol-v2.js';
import { allowedMessage } from '../remote/authorise.js';
import type { Role } from '../remote/registry.js';

/** A browser tab connected to the server. */
export interface Client {
  send(msg: unknown): void;
  /** The socket's token for fetching images (`/blob/<conv>/<hash>?t=`); set by the transport. */
  blobToken?: string;
  /** Set by the transport for a remote device; absent means the local browser. */
  role?: Role;
  /** The remote device's Tailscale node id; set with `role`. */
  deviceId?: string;
}

/** What the hub needs from the app. */
export interface HubHost {
  /** `lastItemIds`: each agent's newest stored item, so a reconnecting page fetches only newer ones. */
  snapshot(convId: string): { conv: ConversationMeta; agents: AgentInfo[]; pending: PermissionRequest[]; lastItemIds: Record<string, string> } | null;
  fullItem(convId: string, agentId: string, itemId: string): Item | null;
  state(client: Client): AppState;
}

interface Session {
  /** 0: a remote socket that has not said hello with protocol 2 yet; it gets nothing. */
  version: 0 | 1 | 2;
  caps: Set<Capability>;
  subscribed: Set<string>;
}

interface Ring {
  seq: number;
  bytes: number;
  events: Array<{ seq: number; msg: Record<string, unknown>; bytes: number }>;
}

/** A ring also stops growing past this many bytes of events. */
const RING_BYTES = 8 * 1024 * 1024;

interface DraftState {
  kind: Draft['kind'];
  text: string;
  dseq: number;
}

/** A coded error, for version 2 tabs; version 1 tabs get `{t:'error', message, ref}` as before. */
export class ClientError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The code for an error App threw as plain text. */
export function codeOf(e: unknown): ErrorCode {
  if (e instanceof ClientError) return e.code;
  const m = (e as Error)?.message ?? '';
  if (/no longer exists/i.test(m)) return 'not_found';
  if (/too long|larger than|at most|too large/i.test(m)) return 'too_large';
  return 'invalid';
}

function convOf(msg: ServerMsg): string | null {
  switch (msg.t) {
    case 'agent':
      return msg.agent.convId;
    case 'item':
    case 'draft':
      return msg.convId;
    case 'permission_request':
      return msg.request.convId;
    default:
      return null;
  }
}

/** Clips heavy tool fields of an item for the live stream. */
export function clipItem(item: Item): { item: Item; truncated: boolean } {
  if (item.kind !== 'tool') return { item, truncated: false };
  const t = item as Item & { input?: unknown; result?: string };
  let truncated = false;
  const out: Record<string, unknown> = { ...t };
  if (typeof t.result === 'string' && t.result.length > CLIP_CHARS) {
    out.result = t.result.slice(0, CLIP_CHARS);
    truncated = true;
  }
  const input = JSON.stringify(t.input ?? null);
  if (input.length > CLIP_CHARS) {
    out.input = { clipped: input.slice(0, CLIP_CHARS) };
    truncated = true;
  }
  return { item: out as unknown as Item, truncated };
}

export class Hub {
  /** Changes on every server start: a page holding a `seq` from another start must not replay with it. */
  readonly epoch = randomBytes(6).toString('hex');
  private sessions = new Map<Client, Session>();
  private rings = new Map<string, Ring>();
  private drafts = new Map<string, DraftState>(); // `${convId}/${agentId}`
  /** A draft whose text item arrived while it was still open: the end then names that item. */
  private finals = new Map<string, string>();
  /** Drafts that ended before their item arrived: the end waits for it, briefly. */
  private ending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private host: HubHost) {}

  add(client: Client): void {
    // The version 1 adapter is for the local browser only: a remote device speaks version 2 from its
    // first message and is sent nothing until then.
    this.sessions.set(client, { version: client.role ? 0 : 1, caps: new Set(), subscribed: new Set() });
  }

  /** Whether this tab gets the version 1 greeting on connect. */
  greets(client: Client): boolean {
    return this.sessions.get(client)?.version === 1;
  }

  remove(client: Client): void {
    this.sessions.delete(client);
  }

  clients(): Client[] {
    return [...this.sessions.keys()];
  }

  isV2(client: Client): boolean {
    return this.sessions.get(client)?.version === 2;
  }

  /**
   * May this tab send this message? The role decides the type; a version 2 tab (every remote device is
   * one) reads a conversation's details only while subscribed to it.
   */
  admit(client: Client, msg: { t: string; convId?: unknown }): void {
    const s = this.sessions.get(client);
    if (s?.version === 0 && msg.t !== 'hello') throw new ClientError('protocol', 'Say hello with protocol 2 first.');
    if (!allowedMessage(client.role ?? 'local', msg.t)) throw new ClientError('refused', 'This device may not do that.');
    if (s?.version === 2 && ['open', 'items', 'item_full', 'draft_sync'].includes(msg.t) && !s.subscribed.has(String(msg.convId ?? ''))) {
      throw new ClientError('refused', 'Subscribe to that conversation first.');
    }
  }

  private ring(convId: string): Ring {
    let r = this.rings.get(convId);
    if (!r) this.rings.set(convId, (r = { seq: 0, bytes: 0, events: [] }));
    return r;
  }

  private record(convId: string, msg: Record<string, unknown>): Record<string, unknown> {
    const r = this.ring(convId);
    const event = { ...msg, seq: ++r.seq };
    const bytes = JSON.stringify(event).length;
    r.events.push({ seq: r.seq, msg: event, bytes });
    r.bytes += bytes;
    while (r.events.length > RING_SIZE || (r.bytes > RING_BYTES && r.events.length > 1)) r.bytes -= r.events.shift()!.bytes;
    return event;
  }

  /** Turns a full draft (as App reports it) into the version 2 event: a delta, a replacement or an end. */
  private draftEvent(convId: string, agentId: string, draft: Draft | null): Record<string, unknown> | null {
    const key = `${convId}/${agentId}`;
    const was = this.drafts.get(key);
    if (!draft) {
      if (!was) return null;
      this.drafts.delete(key);
      const itemId = this.finals.get(key);
      this.finals.delete(key);
      if (itemId) return { t: 'draft_end', convId, agentId, itemId };
      // Some backends end the draft before the final text item: wait a moment for it to name it.
      this.ending.set(
        key,
        setTimeout(() => {
          this.ending.delete(key);
          this.emit(convId, { t: 'draft_end', convId, agentId });
        }, 1500),
      );
      return null;
    }
    if (was && was.kind === draft.kind && draft.text.startsWith(was.text)) {
      if (draft.text.length === was.text.length) return null;
      const append = draft.text.slice(was.text.length);
      was.text = draft.text;
      was.dseq++;
      return { t: 'draft', convId, agentId, dseq: was.dseq, kind: draft.kind, append };
    }
    // A new draft: an earlier one still waiting for its item ends now, so the wait cannot end this one.
    const timer = this.ending.get(key);
    if (timer) {
      clearTimeout(timer);
      this.ending.delete(key);
      this.emit(convId, { t: 'draft_end', convId, agentId });
    }
    this.finals.delete(key);
    const next: DraftState = { kind: draft.kind, text: draft.text, dseq: 1 };
    this.drafts.set(key, next);
    return { t: 'draft', convId, agentId, dseq: 1, kind: draft.kind, text: draft.text };
  }

  /** One event from App, to every tab in the form it wants. */
  publish(msg: ServerMsg): void {
    const convId = convOf(msg);
    let v2: Record<string, unknown> | null = null;
    if (convId) {
      if (msg.t === 'draft') {
        const d = this.draftEvent(convId, msg.agentId, msg.draft);
        v2 = d ? this.record(convId, d) : null;
      } else if (msg.t === 'item') {
        const { item, truncated } = clipItem(msg.item);
        v2 = this.record(convId, { ...msg, item, ...(truncated ? { truncated: true } : {}) });
        if (msg.item.kind === 'text' || msg.item.kind === 'thinking') {
          const key = `${convId}/${msg.agentId}`;
          const timer = this.ending.get(key);
          if (timer) {
            clearTimeout(timer);
            this.ending.delete(key);
            this.sendTo(convId, v2, msg);
            this.emit(convId, { t: 'draft_end', convId, agentId: msg.agentId, itemId: msg.item.id });
            return;
          } else if (this.drafts.has(key)) this.finals.set(key, msg.item.id);
        }
      } else {
        v2 = this.record(convId, msg as unknown as Record<string, unknown>);
      }
    }
    if (msg.t === 'deleted') {
      this.rings.delete(msg.convId);
      for (const k of this.drafts.keys()) if (k.startsWith(`${msg.convId}/`)) this.drafts.delete(k);
      for (const [k, t] of this.ending) if (k.startsWith(`${msg.convId}/`)) (clearTimeout(t), this.ending.delete(k));
      for (const k of this.finals.keys()) if (k.startsWith(`${msg.convId}/`)) this.finals.delete(k);
    }
    this.sendTo(convId, v2, msg);
  }

  /** Only to the local browser's tabs (remote access management): never to a remote device. */
  publishLocal(msg: Record<string, unknown>): void {
    for (const client of this.sessions.keys()) if (!client.role) client.send(msg);
  }

  /** A version 2 event the hub makes itself (not from App), to subscribers only. */
  private emit(convId: string, event: Record<string, unknown>): void {
    const e = this.record(convId, event);
    for (const [client, s] of this.sessions) if (s.version === 2 && s.subscribed.has(convId)) client.send(e);
  }

  private sendTo(convId: string | null, v2: Record<string, unknown> | null, msg: ServerMsg): void {
    for (const [client, s] of this.sessions) {
      if (s.version === 0) continue;
      if (s.version === 1) {
        client.send(msg);
        continue;
      }
      if (msg.t === 'permission_request') {
        const r = msg.request;
        client.send({ t: 'approval', summary: { id: r.id, convId: r.convId, agentName: r.agentName, kind: r.kind } satisfies ApprovalSummary });
      }
      if (!convId) {
        if (msg.t === 'deleted') s.subscribed.delete(msg.convId);
        client.send(msg);
      } else if (v2 && s.subscribed.has(convId)) {
        client.send(v2);
      }
    }
  }

  /**
   * Handles the version 2 messages that are about the connection itself. Returns true when the message
   * was one of them; anything else goes on to App.
   */
  intercept(client: Client, raw: Record<string, unknown>): boolean {
    const s = this.sessions.get(client);
    if (!s) return false;
    switch (raw.t) {
      case 'hello': {
        if (raw.protocol === undefined) return false; // a version 1 hello: App answers with state
        if (raw.protocol !== PROTOCOL_VERSION) throw new ClientError('protocol', `This Masthead speaks protocol ${PROTOCOL_VERSION}. Reload the page.`);
        s.version = 2;
        s.caps = new Set((Array.isArray(raw.caps) ? raw.caps : []).filter((c): c is Capability => typeof c === 'string'));
        client.send(this.stateV2(client));
        return true;
      }
      case 'subscribe': {
        this.requireV2(s);
        const convId = String(raw.convId ?? '');
        const snap = this.host.snapshot(convId);
        if (!snap) throw new ClientError('not_found', 'That conversation no longer exists.');
        s.subscribed.add(convId);
        const ring = this.ring(convId);
        // A seq from another server start means nothing here: treat it as too old.
        const sameStart = raw.epoch === undefined || raw.epoch === this.epoch;
        const since = typeof raw.since === 'number' && sameStart ? raw.since : null;
        if (!sameStart) {
          client.send({ t: 'resync', convId });
          client.send(this.snapshot(convId, snap));
          return true;
        }
        const oldest = ring.events[0]?.seq ?? ring.seq + 1;
        if (since !== null && since <= ring.seq && since >= oldest - 1) {
          for (const e of ring.events) if (e.seq > since) client.send(e.msg);
          return true;
        }
        if (since !== null && since !== ring.seq) client.send({ t: 'resync', convId });
        client.send(this.snapshot(convId, snap));
        return true;
      }
      case 'unsubscribe':
        this.requireV2(s);
        s.subscribed.delete(String(raw.convId ?? ''));
        return true;
      case 'draft_sync': {
        this.requireV2(s);
        const convId = String(raw.convId ?? '');
        if (!this.rings.has(convId) && !this.host.snapshot(convId)) throw new ClientError('not_found', 'That conversation no longer exists.');
        const agentId = String(raw.agentId ?? '');
        const d = this.drafts.get(`${convId}/${agentId}`);
        if (!d) client.send({ t: 'draft_end', convId, agentId, seq: this.ring(convId).seq });
        else client.send({ t: 'draft', convId, agentId, dseq: d.dseq, kind: d.kind, text: d.text, seq: this.ring(convId).seq });
        return true;
      }
      case 'item_full': {
        this.requireV2(s);
        const convId = String(raw.convId ?? '');
        const agentId = String(raw.agentId ?? '');
        const item = this.host.fullItem(convId, agentId, String(raw.itemId ?? ''));
        if (!item) throw new ClientError('not_found', 'That item no longer exists.');
        client.send({ t: 'item_full', convId, agentId, item });
        return true;
      }
      default:
        return false;
    }
  }

  private requireV2(s: Session): void {
    if (s.version !== 2) throw new ClientError('protocol', 'Say hello with protocol 2 first.');
  }

  private snapshot(convId: string, snap: NonNullable<ReturnType<HubHost['snapshot']>>): Record<string, unknown> {
    const drafts: Record<string, Draft & { dseq: number }> = {};
    for (const [k, d] of this.drafts) if (k.startsWith(`${convId}/`)) drafts[k.slice(convId.length + 1)] = { kind: d.kind, text: d.text, dseq: d.dseq };
    return { t: 'conversation', ...snap, drafts, seq: this.ring(convId).seq };
  }

  /** `state` for a version 2 tab: approvals as summaries. */
  stateV2(client: Client): Record<string, unknown> {
    const st = this.host.state(client);
    const pending = st.pending.map((r) => ({ id: r.id, convId: r.convId, agentName: r.agentName, kind: r.kind }));
    return { t: 'state', protocol: PROTOCOL_VERSION, epoch: this.epoch, state: { ...st, pending } };
  }

  /** An error, in the form this tab understands. */
  error(client: Client, e: unknown, ref?: string): void {
    const base = { t: 'error', message: (e as Error)?.message ?? String(e), ...(ref ? { ref } : {}) };
    // Only a local version 1 tab gets the old shape; every other tab gets the code.
    client.send(this.sessions.get(client)?.version === 1 ? base : { ...base, code: codeOf(e) });
  }
}
