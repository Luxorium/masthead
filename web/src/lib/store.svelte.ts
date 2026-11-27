import type {
  AgentInfo,
  AppState,
  BlobRef,
  CompactState,
  ClientMsg,
  ConversationMeta,
  Draft,
  ImageAttachment,
  Item,
  PermissionRequest,
  RateLimitNotice,
  ServerMsg,
  Settings,
} from '../../../shared/protocol.ts';
import type { ApprovalSummary, Capability, ClientMsgV2, ServerMsgV2 } from '../../../shared/protocol-v2.ts';
import { deviceToken, forgetDevice, forgetDeviceToken, isRemoteDevice, saveDeviceToken, whoami, type DeviceRole } from './signin.ts';
import { dropCandidate, idFromHash, keepCandidate, serverUp, storedKey, takeKey } from './signin.ts';
import { limitKey, settingsPatch, worstLimit } from './state/pure.ts';
import { T } from './text.ts';

/** What the composer holds for one conversation and agent: text and attached images. */
export interface ComposerImage extends ImageAttachment {
  url: string;
  name: string;
  size: number;
  /** In an existing chat the picture is uploaded at once (POST /blob); this is how it was stored. */
  ref?: BlobRef;
  uploading?: boolean;
  /** Why the upload failed; the picture must be removed before sending. */
  error?: string;
}
export interface ComposerDraft {
  text: string;
  images: ComposerImage[];
}

/** A message handed to the server and not yet accepted, kept so a refusal can give it back. */
interface Sent {
  ref: string;
  key: string;
  convId: string | null;
  text: string;
  images: ComposerImage[];
}

/** Closes before the socket ever opened, in a row, before the page stops trying by itself. */
const MAX_REFUSALS = 3;

export interface DirListing {
  path: string;
  parent: string | null;
  entries: string[];
  error?: string;
}

/**
 * Everything the page knows, kept in step with the server over one WebSocket. The server owns the
 * truth; this is a view of it, rebuilt from scratch whenever the connection comes back.
 */
export class Store {
  connected = $state(false);
  app = $state<AppState | null>(null);
  settings = $state<Settings | null>(null);
  conversations = $state<ConversationMeta[]>([]);

  /** The open conversation, or null on the new-conversation screen. */
  convId = $state<string | null>(null);
  agents = $state<Record<string, AgentInfo>>({});
  /** The agent whose transcript is shown; null means the lead. */
  viewAgentId = $state<string | null>(null);
  items = $state<Record<string, Item[]>>({});
  drafts = $state<Record<string, Draft | null>>({});
  pending = $state<PermissionRequest[]>([]);
  newCwd = $state('');
  /** The team chosen on the new-chat screen (ProfileChip); null means the default team. */
  newProfile = $state<string | null>(null);
  dirs = $state<DirListing | null>(null);
  error = $state<string | null>(null);
  /** The banner's notice key the person dismissed; the banner returns when the worst notice changes. */
  private dismissedLimit = $state<string | null>(null);
  /** The worst usage window known (any rejected, else any warning), unless the person dismissed it. */
  rateLimit = $derived.by((): RateLimitNotice | null => {
    const worst = worstLimit(this.usage);
    return worst && limitKey(worst) !== this.dismissedLimit ? worst : null;
  });
  /** True between sending the first message of a new conversation and the server creating it. */
  creating = $state(false);
  /** The latest notice per usage-limit type. */
  usage = $state<Record<string, RateLimitNotice>>({});
  /** Why the page cannot connect at all: no key in this browser, or the server keeps refusing it. */
  /**
   * Why the page cannot connect: no key in this browser, the server keeps refusing it, or (on a remote
   * device, served over https) the device has no approved token yet, or the computer withdrew access.
   */
  signedOut = $state<'nokey' | 'refused' | 'device' | 'withdrawn' | null>(null);
  /** Unsent text and images per conversation and agent; see `composerKey`. */
  composer = $state<Record<string, ComposerDraft>>({});

  private ws: WebSocket | null = null;
  private retry = 0;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRef: string | null = null;
  private refusals = 0;
  private sent: Sent[] = [];
  /** Agents whose transcript the page wants; an `items` reply for any other is dropped. */
  private wanted = new Set<string>();

  // ---- protocol version 2 (see web.md section 2) ----
  /** True once the server answered hello with protocol 2; false for an older server (version 1). */
  v2 = false;
  /** Approval requests in every conversation, as summaries: for the badges in the chat list. */
  approvals = $state<ApprovalSummary[]>([]);
  /** For images: `/blob/<conv>/<hash>?t=<blobToken>` (Stage B). */
  blobToken = $state<string | null>(null);
  /** Items that arrived clipped (`truncated`), by id; opening one fetches it whole. */
  clipped = $state<Record<string, true>>({});
  /** Per agent: the cursor of the oldest page loaded, whether older pages exist, and whether one is loading. */
  pages = $state<Record<string, { cursor: number | null; more: boolean; loading: boolean }>>({});
  /** The last per-conversation event number seen for the open conversation, for resync after a drop. */
  private seq = 0;
  /** The server's start marker: a different one after a reconnect means it restarted, so sequence
   *  numbers start again and the page reloads the conversation instead of replaying. */
  private epoch: string | null = null;
  /** The conversation this tab is subscribed to. */
  private subscribed: string | null = null;
  /** Each streaming draft's step count, to notice a missed step. */
  private dseq: Record<string, number> = {};
  /** The v1 state the server sends on connect, used only if it never answers hello (an older server). */
  private v1State: ServerMsg | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  /** A hello was sent on this socket and not yet answered. */
  private helloPending = false;
  /** Items per transcript page. */
  static PAGE = 100;

  // ---- for the settings and remote-access pieces (web/src/lib/settings, web/src/lib/remote) ----
  /** `state.remote` (local page only) and its live updates (`{t:'remote'}`); null on a device or an older server. */
  remote = $state<Record<string, unknown> | null>(null);
  /** On a remote device: what its role allows (full, approve, read); null on this computer's own page. */
  deviceRole = $state<DeviceRole | null>(null);
  /** The device is signing itself out (Forget this device): its socket closing is expected. */
  private forgetting = false;
  /** `state.backends` (protocol v2) and the answer to `check_backends`. */
  backends = $state<Record<string, unknown>[]>([]);
  private listeners = new Map<string, Set<(msg: Record<string, unknown>) => void>>();

  /**
   * Calls `fn` for every server message of type `t` (after the store has handled it). Returns the
   * function that stops listening. For replies only one component cares about (e.g. `remote_audit`).
   */
  listen(t: string, fn: (msg: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(t);
    if (!set) this.listeners.set(t, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Sends any protocol message (for message types the store itself does not use). False when offline. */
  request(msg: Record<string, unknown> & { t: string }): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.fail(T.errors.notConnected);
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }
  /** Whether the server already has this tab subscribed to `subscribed` on the current socket. */
  private subscribedOnServer = false;

  conv = $derived(this.conversations.find((c) => c.id === this.convId) ?? null);
  /** The team: every agent of the open chat except archived ones (they live under "Archived helpers"). */
  agentList = $derived(Object.values(this.agents).filter((a) => !a.archived).sort((a, b) => a.createdAt - b.createdAt));
  /** Helpers a team tidy-up archived, newest first: readable, and the person may restore them. */
  archivedAgents = $derived(Object.values(this.agents).filter((a) => !!a.archived).sort((a, b) => (b.archived ?? 0) - (a.archived ?? 0)));
  /** A team tidy-up (compaction) under way or just ended in the open chat; null when none. */
  compact = $state<CompactState | null>(null);
  /** The one the person talks to: the agent nobody started. Its tier id is 'lead' only in Claude's built-in team (other teams use '<profile>:0'). */
  lead = $derived(this.agentList.find((a) => !a.parentId) ?? null);
  viewAgent = $derived((this.viewAgentId ? this.agents[this.viewAgentId] : null) ?? this.lead);
  viewItems = $derived(this.viewAgent ? (this.items[this.viewAgent.id] ?? []) : []);
  viewDraft = $derived(this.viewAgent ? (this.drafts[this.viewAgent.id] ?? null) : null);
  /**
   * Whether an agent backend is there to run. Until the server sends `state.backends` (W8) this reads
   * the Claude Code info: a path, or (for the test-only fake backend) a version without a path.
   */
  canRun = $derived(
    !!this.app &&
      (this.backends.some((b) => b.available === true) || !!this.app.claude.path || !!this.app.claude.version),
  );
  convPending = $derived(this.pending.filter((p) => p.convId === this.convId));
  liveCount = $derived(this.agentList.filter((a) => !!a.parentId && (a.status === 'queued' || a.status === 'running' || a.status === 'waiting')).length);

  /** The key in the composer map for what is on screen now. */
  composerKey = $derived(`${this.convId ?? 'new'}:${this.viewAgentId ?? 'lead'}`);

  composerFor(key: string): ComposerDraft {
    this.composer[key] ??= { text: '', images: [] };
    return this.composer[key]!;
  }

  connect(): void {
    // A remote device (golf's Tailscale access) is always served over https; the local page never is.
    if (isRemoteDevice()) return this.connectDevice();
    const { key, untried } = takeKey();
    if (!key) {
      this.signedOut = 'nokey';
      return;
    }
    this.signedOut = null;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`, ['masthead', `key.${key}`]);
    } catch {
      // A key with characters a subprotocol cannot carry: it did not come from `masthead`.
      if (untried && storedKey()) {
        dropCandidate();
        this.connect();
        return;
      }
      this.signedOut = 'refused';
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      if (untried) keepCandidate();
      this.connected = true;
      this.retry = 0;
      this.refusals = 0;
      this.v2 = false;
      this.subscribedOnServer = false;
      const caps: Capability[] = ['drafts-delta', 'items-paging', 'blobs', 'resync'];
      this.v1State = null;
      this.helloPending = this.sendV2({ t: 'hello', protocol: 2, caps });
      // An older server ignores the hello; fall back to the version 1 state it sent on connect.
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = setTimeout(() => {
        this.helloPending = false;
        if (!this.v2 && this.v1State) this.receive(this.v1State);
      }, 2000);
    };
    ws.onmessage = (ev) => this.receive(JSON.parse(ev.data as string) as ServerMsgV2);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      this.dropped();
      if (opened) return this.later();
      // Closed before it opened: refused, or the server is down (a restart takes a while). Only a
      // server that answers can have refused us; while it is down, keep trying (and keep any
      // candidate key) for as long as it takes.
      void serverUp().then((up) => {
        if (this.ws) return; // something else connected meanwhile
        if (!up) return this.later();
        if (untried && storedKey()) {
          // A key from the address that the server refused, with a good one already stored: forget
          // it and carry on with the stored key, without the sign-in page.
          dropCandidate();
          return this.connect();
        }
        if (++this.refusals >= MAX_REFUSALS) {
          this.signedOut = 'refused';
          return;
        }
        this.later();
      });
    };
    ws.onerror = () => ws.close();
  }

  /** Connects again after the back-off: 400 ms, doubling up to 5 s. */
  private later(): void {
    const wait = Math.min(5000, 400 * 2 ** this.retry++);
    setTimeout(() => {
      if (!this.ws && !this.signedOut) this.connect();
    }, wait);
  }

  /**
   * The address changed and its fragment carries `key=` (the sign-in address pasted into an open
   * tab): take it as a candidate and connect with it now, closing any current socket.
   */
  keyFromAddress(): void {
    if (!/(^#|&)key=/.test(location.hash) && !new URLSearchParams(location.search).has('key')) return;
    takeKey();
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.refusals = 0;
    this.retry = 0;
    this.signedOut = null;
    this.connect();
  }

  /** The usage banner's Dismiss: hidden until the worst notice changes. */
  dismissLimit(): void {
    if (this.rateLimit) this.dismissedLimit = limitKey(this.rateLimit);
  }

  /** A remote device connects with its approved token (`device.<token>`), never a key. */
  private connectDevice(): void {
    const token = deviceToken();
    if (!token) {
      this.signedOut = 'device';
      return;
    }
    this.signedOut = null;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`wss://${location.host}/ws`, ['masthead', `device.${token}`]);
    } catch {
      forgetDeviceToken();
      this.signedOut = 'device';
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.connected = true;
      this.retry = 0;
      this.v2 = false;
      this.subscribedOnServer = false;
      this.v1State = null;
      this.helloPending = this.sendV2({ t: 'hello', protocol: 2, caps: ['drafts-delta', 'items-paging', 'blobs', 'resync'] });
      // The role decides what this page offers (the server enforces it either way).
      void whoami().then((w) => {
        if (w?.state === 'approved') this.deviceRole = w.role;
      });
    };
    ws.onmessage = (ev) => this.receive(JSON.parse(ev.data as string) as ServerMsgV2);
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      this.dropped();
      if (this.forgetting) {
        // Forget this device: the server closes with 4001 too, but this was the person's own choice.
        this.forgetting = false;
        this.signedOut = 'device';
        return;
      }
      if (ev.code === 4001) {
        // The computer withdrew this device's access.
        forgetDeviceToken();
        this.signedOut = 'withdrawn';
        return;
      }
      if (opened) return this.later();
      // Refused before it opened. A brief refusal (remote access switched off and on, the listener
      // restarting) must not cost the token: forget it only when the server says it is no longer valid.
      void whoami().then((w) => {
        if (this.ws) return;
        if (w?.state === 'unknown' || w?.state === 'refused') {
          forgetDeviceToken();
          this.signedOut = 'device';
          return;
        }
        this.later();
      });
    };
    ws.onerror = () => ws.close();
  }

  /**
   * Forget this device (on a borrowed or shared phone): tell the server to drop it, forget the token and
   * any pairing request, close the socket and go back to the sign-in screen.
   */
  forgetThisDevice(): void {
    this.forgetting = true;
    this.request({ t: 'forget_me' });
    forgetDevice();
    this.deviceRole = null;
    const ws = this.ws;
    setTimeout(() => {
      // If the server did not close it already, close it here.
      if (this.ws === ws && ws) ws.close();
      else if (!this.ws) {
        this.forgetting = false;
        this.signedOut = 'device';
      }
    }, 1500);
  }

  /** What this page may do: everything on this computer; on a device, what its role allows. */
  get mayAct(): boolean {
    return this.deviceRole === null || this.deviceRole === 'full';
  }
  /** Stopping work: full and approve devices may (the server allows both). */
  get mayStop(): boolean {
    return this.deviceRole !== 'read';
  }
  get mayAnswer(): boolean {
    return this.deviceRole === null || this.deviceRole !== 'read';
  }

  /** The remote sign-in screen got a token for this device: keep it and connect. */
  deviceApproved(token: string): void {
    saveDeviceToken(token);
    this.retryConnect();
  }

  /** "Try again" on the signed-out page. */
  retryConnect(): void {
    this.refusals = 0;
    this.retry = 0;
    this.connect();
  }

  /** The socket closed: whatever was not yet accepted goes back in the composer. */
  private dropped(): void {
    this.creating = false;
    this.pendingRef = null;
    for (const s of this.sent.splice(0)) this.giveBack(s);
  }

  /** Puts a refused message back where it was typed, unless the person has typed something new there. */
  private giveBack(s: Sent): void {
    const d = this.composerFor(s.key);
    if (d.text.trim() || d.images.length) {
      for (const img of s.images) URL.revokeObjectURL(img.url);
      return;
    }
    d.text = s.text;
    d.images = s.images;
  }

  private accepted(match: (s: Sent) => boolean): void {
    const i = this.sent.findIndex(match);
    if (i < 0) return;
    const [s] = this.sent.splice(i, 1);
    for (const img of s!.images) URL.revokeObjectURL(img.url);
  }

  send(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.fail('Not connected to Masthead. Is it still running?');
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  fail(message: string): void {
    this.error = message;
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => (this.error = null), 8000);
  }

  /** The app state, from a version 1 `state` or a version 2 one (approvals already taken out). */
  private receiveState(state: AppState): void {
    this.app = state;
    const extra = state as AppState & { remote?: Record<string, unknown>; backends?: Record<string, unknown>[] };
    this.remote = extra.remote ?? null;
    this.backends = extra.backends ?? [];
    this.settings = state.settings;
    this.conversations = state.conversations;
    this.pending = state.pending ?? [];
    this.usage = Object.fromEntries((state.usage ?? []).map((n) => [n.type ?? '', n]));
    this.creating = false;
    this.pendingRef = null;
    if (!this.newCwd) this.newCwd = state.settings.defaultCwd;
    // First load or a reconnect: fetch the open conversation again so nothing is stale. With
    // version 2 a reconnect resubscribes from the last event seen and keeps what is loaded.
    const wanted = this.convId ?? idFromHash();
    if (wanted && state.conversations.some((c) => c.id === wanted)) {
      if (this.v2 && wanted === this.subscribed && this.seq > 0) this.resubscribe();
      else this.open(wanted, this.viewAgentId);
    } else this.newConversation();
  }

  /** Applies one message from the server. Public so tests can drive the store without a socket. */
  receive(msg: ServerMsg | ServerMsgV2): void {
    this.handle(msg);
    const any = msg as Record<string, unknown> & { t: string };
    for (const fn of this.listeners.get(any.t) ?? []) fn(any);
  }

  private handle(msg: ServerMsg | ServerMsgV2): void {
    const raw = msg as Record<string, unknown> & { t: string };
    if (raw.t === 'remote') {
      this.remote = (raw.remote as Record<string, unknown>) ?? null;
      return;
    }
    if (raw.t === 'backends') {
      this.backends = (raw.backends as Record<string, unknown>[]) ?? [];
      return;
    }
    // Version 2 messages that version 1 does not have, or that differ from it.
    if (this.receiveV2(msg)) return;
    const m = msg as ServerMsg;
    switch (m.t) {
      case 'state':
        this.receiveState(m.state);
        return;
      case 'conversations':
        this.conversations = m.conversations;
        return;
      case 'conversation': {
        if (m.conv.id !== this.convId) return;
        const agents: Record<string, AgentInfo> = {};
        for (const a of m.agents) agents[a.id] = a;
        this.agents = agents;
        this.compact = m.conv.compact ?? null;
        this.pending = [...this.pending.filter((p) => p.convId !== m.conv.id), ...m.pending];
        const snap = m as typeof m & { seq?: number; drafts?: Record<string, Draft & { dseq: number }> };
        if (typeof snap.seq === 'number') {
          // A version 2 snapshot: the event number to resync from, and the drafts in progress.
          this.seq = snap.seq;
          for (const [agentId, d] of Object.entries(snap.drafts ?? {})) {
            this.drafts[agentId] = { kind: d.kind, text: d.text };
            this.dseq[agentId] = d.dseq;
          }
        }
        const view = this.viewAgentId && agents[this.viewAgentId] ? this.viewAgentId : m.conv.leadId;
        this.viewAgentId = view === m.conv.leadId ? null : view;
        this.loadItems(view);
        return;
      }
      case 'created':
        if (m.ref) this.accepted((s) => s.ref === m.ref);
        if (m.ref && m.ref === this.pendingRef) {
          this.pendingRef = null;
          this.creating = false;
          this.open(m.convId, null);
        }
        return;
      case 'deleted':
        this.pending = this.pending.filter((p) => p.convId !== m.convId);
        this.approvals = this.approvals.filter((p) => p.convId !== m.convId);
        if (m.convId === this.convId) this.newConversation();
        return;
      case 'items': {
        // A preview that closed before its reply came does not want it any more (see dropItems).
        if (m.convId !== this.convId || !this.wanted.has(m.agentId)) return;
        const paged = m as typeof m & { cursor?: number | null; more?: boolean };
        const page = this.pages[m.agentId];
        if (paged.cursor !== undefined && page?.loading && this.items[m.agentId]) {
          // An older page: put it in front, keeping any item already here (ours is newer).
          const have = new Set(this.items[m.agentId]!.map((i) => i.id));
          this.items[m.agentId] = [...m.items.filter((i) => !have.has(i.id)), ...this.items[m.agentId]!];
        } else {
          this.items[m.agentId] = m.items;
          if (this.drafts[m.agentId] === undefined || !this.v2) this.drafts[m.agentId] = m.draft;
        }
        if (paged.cursor !== undefined) this.pages[m.agentId] = { cursor: paged.cursor ?? null, more: !!paged.more, loading: false };
        return;
      }
      case 'agent':
        if (m.agent.convId === this.convId) this.agents[m.agent.id] = m.agent;
        return;
      case 'item': {
        const it = m.item;
        if (it.kind === 'user') this.accepted((s) => s.convId === m.convId && s.text === it.text);
        if (m.convId !== this.convId) return;
        if ((m as typeof m & { truncated?: boolean }).truncated) this.clipped[it.id] = true;
        else delete this.clipped[it.id];
        const list = this.items[m.agentId];
        if (!list) return; // not loaded; it is fetched when the agent is opened
        const i = list.findIndex((x) => x.id === m.item.id);
        if (i >= 0) list[i] = m.item;
        else list.push(m.item);
        return;
      }
      case 'draft':
        if (m.convId === this.convId) this.drafts[m.agentId] = m.draft;
        return;
      case 'permission_request':
        if (!this.pending.some((p) => p.id === m.request.id)) this.pending.push(m.request);
        return;
      case 'permission_resolved':
        this.pending = this.pending.filter((p) => p.id !== m.requestId);
        this.approvals = this.approvals.filter((p) => p.id !== m.requestId);
        return;
      case 'settings':
        this.settings = m.settings;
        return;
      case 'rate_limit':
        // The banner (rateLimit) is derived from usage, so it follows the worst window known.
        if (m.notice) this.usage[m.notice.type ?? ''] = m.notice;
        return;
      case 'dirs':
        this.dirs = { path: m.path, parent: m.parent, entries: m.entries, error: m.error };
        return;
      case 'error':
        if (m.ref) {
          const i = this.sent.findIndex((s) => s.ref === m.ref);
          if (i >= 0) this.giveBack(this.sent.splice(i, 1)[0]!);
          if (m.ref === this.pendingRef) {
            this.pendingRef = null;
            this.creating = false;
          }
        } else {
          // An error that names no request: do not leave the composer stuck on "Starting…".
          this.creating = false;
        }
        this.fail(m.message);
        return;
    }
  }

  open(convId: string, agentId: string | null = null): void {
    this.convId = convId;
    this.viewAgentId = agentId;
    this.agents = {};
    this.items = {};
    this.drafts = {};
    this.pages = {};
    this.clipped = {};
    this.dseq = {};
    this.wanted.clear();
    if (location.hash !== `#/c/${convId}`) history.replaceState(null, '', `#/c/${convId}`);
    if (this.v2) {
      // Version 2: events of this conversation only, starting with a snapshot.
      this.unsubscribe();
      this.seq = 0;
      this.subscribed = convId;
      this.subscribedOnServer = this.sendV2({ t: 'subscribe', convId });
    } else {
      this.send({ t: 'open', convId });
    }
  }

  /** After a reconnect: subscribe again from the last event seen, keeping what is loaded. */
  private resubscribe(): void {
    if (!this.subscribed) return;
    this.subscribedOnServer = this.sendV2({ t: 'subscribe', convId: this.subscribed, since: this.seq, ...(this.epoch ? { epoch: this.epoch } : {}) } as ClientMsgV2);
  }

  private unsubscribe(): void {
    if (this.subscribed && this.subscribedOnServer) this.sendV2({ t: 'unsubscribe', convId: this.subscribed });
    this.subscribed = null;
    this.subscribedOnServer = false;
  }

  /** Sends a version 2 message (the same socket as version 1). */
  private sendV2(msg: ClientMsgV2): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Handles what is new in version 2. Returns true when the message was fully handled here; false lets
   * the version 1 handler take it (most messages are the same in both).
   */
  private receiveV2(msg: ServerMsg | ServerMsgV2): boolean {
    const m = msg as Record<string, unknown> & { t: string };
    if (typeof m.seq === 'number' && (m.convId === this.subscribed || (m.t === 'agent' && (m.agent as AgentInfo)?.convId === this.subscribed))) {
      this.seq = Math.max(this.seq, m.seq);
    }
    switch (m.t) {
      case 'state': {
        if (m.protocol === 2) {
          const epoch = typeof m.epoch === 'string' ? m.epoch : null;
          if (this.epoch && epoch && epoch !== this.epoch) this.seq = 0; // restarted: no replay
          this.epoch = epoch;
          this.v2 = true;
          this.helloPending = false;
          if (this.helloTimer) clearTimeout(this.helloTimer);
          const st = m.state as AppState & { pending: ApprovalSummary[]; blobToken?: string };
          this.approvals = st.pending ?? [];
          this.blobToken = st.blobToken ?? null;
          // Full requests arrive per conversation; the v1 handler below must not treat summaries as requests.
          this.receiveState({ ...st, pending: [] } as AppState);
          return true;
        }
        // The version 1 state sent on connect, while our hello is unanswered: kept in case the server
        // never answers it (an older server). Otherwise it is an ordinary version 1 state.
        if (this.helloPending) {
          this.v1State = msg as ServerMsg;
          return true;
        }
        return this.v2; // a version 2 tab ignores a state without `protocol`
      }
      case 'compact':
        if (m.convId === this.convId) this.compact = (m.compact as CompactState | null) ?? null;
        return true;
      case 'archived':
        if (m.convId === this.convId) for (const a of m.agents as AgentInfo[]) this.agents[a.id] = a;
        return true;
      case 'archive_items':
        // An archived helper's chat, read-only: handled like a transcript page.
        this.handle({ ...(m as object), t: 'items', draft: null } as unknown as ServerMsg);
        return true;
      case 'approval': {
        if (!this.v2) return false;
        const sum = m.summary as ApprovalSummary;
        if (!this.approvals.some((a) => a.id === sum.id)) this.approvals = [...this.approvals, sum];
        return true;
      }
      case 'resync':
        // Too far behind to replay: start this conversation afresh; a snapshot follows.
        if (m.convId === this.subscribed) {
          this.items = {};
          this.drafts = {};
          this.pages = {};
          this.dseq = {};
        }
        return true;
      case 'draft': {
        if (typeof m.dseq !== 'number') return false; // version 1: the whole draft
        if (m.convId !== this.convId) return true;
        const agentId = m.agentId as string;
        const kind = m.kind as Draft['kind'];
        if (typeof m.text === 'string') {
          this.drafts[agentId] = { kind, text: m.text };
          this.dseq[agentId] = m.dseq;
        } else if ((this.dseq[agentId] ?? 0) + 1 === m.dseq && this.drafts[agentId]) {
          this.drafts[agentId] = { kind, text: this.drafts[agentId]!.text + String(m.append ?? '') };
          this.dseq[agentId] = m.dseq;
        } else if (m.dseq === 1) {
          this.drafts[agentId] = { kind, text: String(m.append ?? '') };
          this.dseq[agentId] = 1;
        } else {
          // A step went missing: ask for the whole text once.
          this.sendV2({ t: 'draft_sync', convId: this.convId!, agentId });
        }
        return true;
      }
      case 'draft_end':
        if (m.convId === this.convId) {
          this.drafts[m.agentId as string] = null;
          delete this.dseq[m.agentId as string];
        }
        return true;
      case 'item_full': {
        if (m.convId !== this.convId) return true;
        const item = m.item as Item;
        const list = this.items[m.agentId as string];
        const i = list?.findIndex((x) => x.id === item.id) ?? -1;
        if (list && i >= 0) list[i] = item;
        delete this.clipped[item.id];
        return true;
      }
      default:
        return false;
    }
  }

  /** The person's answer to the tidy-up card: which helpers to keep, and whether to go ahead. */
  answerCompact(keep: string[], accept: boolean): void {
    if (this.convId && this.compact) this.request({ t: 'compact_answer', convId: this.convId, id: this.compact.id, keep, accept });
  }

  cancelCompact(): void {
    if (this.convId) this.request({ t: 'compact_cancel', convId: this.convId });
  }

  /** Brings an archived helper back into the team. */
  restoreAgent(agentId: string): void {
    if (this.convId) this.request({ t: 'restore_agent', convId: this.convId, agentId });
  }

  /** Fetches the whole of an item that arrived clipped. */
  fetchFull(agentId: string, itemId: string): void {
    if (this.convId && this.clipped[itemId]) this.sendV2({ t: 'item_full', convId: this.convId, agentId, itemId });
  }

  /** Fetches the next older page of an agent's transcript, when there is one. */
  loadEarlier(agentId: string): void {
    const page = this.pages[agentId];
    if (!this.convId || !page || !page.more || page.loading) return;
    page.loading = true;
    this.sendV2({ t: 'items', convId: this.convId, agentId, before: page.cursor, limit: Store.PAGE });
  }

  newConversation(): void {
    this.unsubscribe();
    this.convId = null;
    this.viewAgentId = null;
    this.agents = {};
    this.items = {};
    this.drafts = {};
    this.wanted.clear();
    if (location.hash) history.replaceState(null, '', location.pathname);
  }

  /** Fetches an agent's transcript if the page does not have it yet. */
  loadItems(agentId: string): void {
    if (!this.convId) return;
    this.wanted.add(agentId);
    if (this.items[agentId]) return;
    if (this.agents[agentId]?.archived) this.request({ t: 'archive_items', convId: this.convId, agentId, limit: Store.PAGE });
    else if (this.v2) this.sendV2({ t: 'items', convId: this.convId, agentId, limit: Store.PAGE });
    else this.send({ t: 'items', convId: this.convId, agentId });
  }

  /** Approvals waiting in a conversation, for its badge in the chat list. */
  waitingIn(convId: string): number {
    return this.v2 ? this.approvals.filter((a) => a.convId === convId).length : this.pending.filter((p) => p.convId === convId).length;
  }

  /** Forgets a transcript fetched only for a preview. It is fetched again if the agent is opened. */
  dropItems(agentId: string): void {
    if (agentId === this.viewAgent?.id) return;
    this.wanted.delete(agentId);
    delete this.items[agentId];
    delete this.pages[agentId];
  }

  /** Shows one agent's transcript. */
  viewOf(agentId: string): void {
    const isLead = !this.agents[agentId]?.parentId;
    this.viewAgentId = isLead ? null : agentId;
    this.loadItems(agentId);
  }

  /**
   * Sends what is in the composer for `key` and empties it. The text and images are kept until the
   * server accepts them, and put back if it refuses them or the connection drops first.
   */
  sendMessage(key: string): boolean {
    const d = this.composerFor(key);
    const text = d.text.trim();
    const ref = crypto.randomUUID();
    const isNew = this.convId === null;
    // A new chat sends its pictures inline (base64); an existing one sends references to the uploads.
    const uploaded = d.images.filter((i) => i.ref).map((i) => i.ref!);
    const inline = d.images.filter((i) => !i.ref && i.data).map(({ mediaType, data }) => ({ mediaType, data }));
    const msg: ClientMsg = isNew
      ? { t: 'send', convId: null, cwd: this.newCwd, text, images: inline, ref, ...(this.newProfile ? { profile: this.newProfile } : {}) }
      : { t: 'send', convId: this.convId, text, images: inline, ...(uploaded.length ? { blobs: uploaded } : {}), agentId: this.viewAgentId ?? undefined, ref };
    if (!this.send(msg)) return false;
    if (isNew) {
      this.pendingRef = ref;
      this.creating = true;
    }
    this.sent.push({ ref, key, convId: this.convId, text, images: d.images });
    d.text = '';
    d.images = [];
    return true;
  }

  /** Changes a copy of the settings and saves it. */
  /**
   * Changes a copy of the settings, shows it at once, and sends only the fields that changed. The
   * server merges a partial update, so a tab with stale settings cannot put back an old folder or limit.
   */
  updateSettings(change: (s: Settings) => void): void {
    if (!this.settings) return;
    const before = $state.snapshot(this.settings) as Settings;
    const next = structuredClone(before);
    change(next);
    const patch = settingsPatch(before, next);
    if (Object.keys(patch).length === 0) return;
    this.settings = next;
    this.send({ t: 'settings', settings: patch });
  }

  answer(requestId: string, decision: 'allow' | 'always' | 'deny', answers?: Record<string, string>): void {
    if (!this.send({ t: 'permission', requestId, decision, answers })) return;
    this.pending = this.pending.filter((p) => p.id !== requestId);
  }

  childrenOf(agentId: string): AgentInfo[] {
    return this.agentList.filter((a) => a.parentId === agentId);
  }

  /** The chain from the lead down to this agent. */
  pathTo(agentId: string): AgentInfo[] {
    const path: AgentInfo[] = [];
    for (let a: AgentInfo | undefined = this.agents[agentId]; a; a = a.parentId ? this.agents[a.parentId] : undefined) path.unshift(a);
    return path;
  }
}

export const store = new Store();

// Helpers that used to live here; components may import them from either place.
export { STATUS_LABEL, fmtTokens, shortPath, shortReason, statusWords } from './words.ts';
