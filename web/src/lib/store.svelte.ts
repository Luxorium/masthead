import type {
  AgentInfo,
  AppState,
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
import { dropCandidate, idFromHash, keepCandidate, serverUp, storedKey, takeKey } from './signin.ts';
import { limitKey, settingsPatch, worstLimit } from './state/pure.ts';

/** What the composer holds for one conversation and agent: text and attached images. */
export interface ComposerImage extends ImageAttachment {
  url: string;
  name: string;
  size: number;
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
  view = $state<'chat' | 'map'>('chat');
  newCwd = $state('');
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
  signedOut = $state<'nokey' | 'refused' | null>(null);
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

  conv = $derived(this.conversations.find((c) => c.id === this.convId) ?? null);
  agentList = $derived(Object.values(this.agents).sort((a, b) => a.createdAt - b.createdAt));
  lead = $derived(this.agentList.find((a) => a.tier === 'lead') ?? null);
  viewAgent = $derived((this.viewAgentId ? this.agents[this.viewAgentId] : null) ?? this.lead);
  viewItems = $derived(this.viewAgent ? (this.items[this.viewAgent.id] ?? []) : []);
  viewDraft = $derived(this.viewAgent ? (this.drafts[this.viewAgent.id] ?? null) : null);
  /**
   * Whether an agent backend is there to run. Until the server sends `state.backends` (W8) this reads
   * the Claude Code info: a path, or (for the test-only fake backend) a version without a path.
   */
  canRun = $derived(!!this.app && (!!this.app.claude.path || !!this.app.claude.version));
  convPending = $derived(this.pending.filter((p) => p.convId === this.convId));
  liveCount = $derived(this.agentList.filter((a) => a.tier !== 'lead' && (a.status === 'queued' || a.status === 'running' || a.status === 'waiting')).length);

  /** The key in the composer map for what is on screen now. */
  composerKey = $derived(`${this.convId ?? 'new'}:${this.viewAgentId ?? 'lead'}`);

  composerFor(key: string): ComposerDraft {
    this.composer[key] ??= { text: '', images: [] };
    return this.composer[key]!;
  }

  connect(): void {
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
    };
    ws.onmessage = (ev) => this.receive(JSON.parse(ev.data as string) as ServerMsg);
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

  /** Applies one message from the server. Public so tests can drive the store without a socket. */
  receive(m: ServerMsg): void {
    switch (m.t) {
      case 'state': {
        this.app = m.state;
        this.settings = m.state.settings;
        this.conversations = m.state.conversations;
        this.pending = m.state.pending ?? [];
        this.usage = Object.fromEntries((m.state.usage ?? []).map((n) => [n.type ?? '', n]));
        this.creating = false;
        this.pendingRef = null;
        if (!this.newCwd) this.newCwd = m.state.settings.defaultCwd;
        // First load or a reconnect: fetch the open conversation again so nothing is stale.
        const wanted = this.convId ?? idFromHash();
        if (wanted && m.state.conversations.some((c) => c.id === wanted)) this.open(wanted, this.viewAgentId);
        else this.newConversation();
        return;
      }
      case 'conversations':
        this.conversations = m.conversations;
        return;
      case 'conversation': {
        if (m.conv.id !== this.convId) return;
        const agents: Record<string, AgentInfo> = {};
        for (const a of m.agents) agents[a.id] = a;
        this.agents = agents;
        this.pending = [...this.pending.filter((p) => p.convId !== m.conv.id), ...m.pending];
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
        if (m.convId === this.convId) this.newConversation();
        return;
      case 'items':
        // A preview that closed before its reply came does not want it any more (see dropItems).
        if (m.convId !== this.convId || !this.wanted.has(m.agentId)) return;
        this.items[m.agentId] = m.items;
        this.drafts[m.agentId] = m.draft;
        return;
      case 'agent':
        if (m.agent.convId === this.convId) this.agents[m.agent.id] = m.agent;
        return;
      case 'item': {
        const it = m.item;
        if (it.kind === 'user') this.accepted((s) => s.convId === m.convId && s.text === it.text);
        if (m.convId !== this.convId) return;
        const list = this.items[m.agentId];
        if (!list) return; // not loaded; it is fetched whole when the agent is opened
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
        return;
      case 'settings':
        this.settings = m.settings;
        return;
      case 'rate_limit':
        // The banner (rateLimit) is derived from usage, so it follows the worst window known.
        this.usage[m.notice.type ?? ''] = m.notice;
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
    this.wanted.clear();
    this.view = 'chat';
    if (location.hash !== `#/c/${convId}`) history.replaceState(null, '', `#/c/${convId}`);
    this.send({ t: 'open', convId });
  }

  newConversation(): void {
    this.convId = null;
    this.viewAgentId = null;
    this.agents = {};
    this.items = {};
    this.drafts = {};
    this.wanted.clear();
    this.view = 'chat';
    if (location.hash) history.replaceState(null, '', location.pathname);
  }

  /** Fetches an agent's transcript if the page does not have it yet. */
  loadItems(agentId: string): void {
    if (!this.convId) return;
    this.wanted.add(agentId);
    if (!this.items[agentId]) this.send({ t: 'items', convId: this.convId, agentId });
  }

  /** Forgets a transcript fetched only for a preview. It is fetched again if the agent is opened. */
  dropItems(agentId: string): void {
    if (agentId === this.viewAgent?.id) return;
    this.wanted.delete(agentId);
    delete this.items[agentId];
  }

  /** Shows one agent's transcript. */
  viewOf(agentId: string): void {
    const isLead = this.agents[agentId]?.tier === 'lead';
    this.viewAgentId = isLead ? null : agentId;
    this.view = 'chat';
    this.loadItems(agentId);
  }

  /**
   * Sends what is in the composer for `key` and empties it. The text and images are kept until the
   * server accepts them, and put back if it refuses them or the connection drops first.
   */
  sendMessage(key: string): boolean {
    const d = this.composerFor(key);
    const text = d.text.trim();
    const images = d.images.map(({ mediaType, data }) => ({ mediaType, data }));
    const ref = crypto.randomUUID();
    const isNew = this.convId === null;
    const msg: ClientMsg = isNew
      ? { t: 'send', convId: null, cwd: this.newCwd, text, images, ref }
      : { t: 'send', convId: this.convId, text, images, agentId: this.viewAgentId ?? undefined, ref };
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
