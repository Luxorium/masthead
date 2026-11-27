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
class Store {
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
  rateLimit = $state<RateLimitNotice | null>(null);
  /** True between sending the first message of a new conversation and the server creating it. */
  creating = $state(false);

  private ws: WebSocket | null = null;
  private retry = 0;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRef: string | null = null;

  conv = $derived(this.conversations.find((c) => c.id === this.convId) ?? null);
  agentList = $derived(Object.values(this.agents).sort((a, b) => a.createdAt - b.createdAt));
  lead = $derived(this.agentList.find((a) => a.tier === 'lead') ?? null);
  viewAgent = $derived((this.viewAgentId ? this.agents[this.viewAgentId] : null) ?? this.lead);
  viewItems = $derived(this.viewAgent ? (this.items[this.viewAgent.id] ?? []) : []);
  viewDraft = $derived(this.viewAgent ? (this.drafts[this.viewAgent.id] ?? null) : null);
  convPending = $derived(this.pending.filter((p) => p.convId === this.convId));
  liveCount = $derived(this.agentList.filter((a) => a.tier !== 'lead' && (a.status === 'queued' || a.status === 'running' || a.status === 'waiting')).length);

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
    };
    ws.onmessage = (ev) => this.receive(JSON.parse(ev.data as string) as ServerMsg);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      const wait = Math.min(5000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => ws.close();
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

  private receive(m: ServerMsg): void {
    switch (m.t) {
      case 'state': {
        this.app = m.state;
        this.settings = m.state.settings;
        this.conversations = m.state.conversations;
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
        if (m.convId !== this.convId) return;
        this.items[m.agentId] = m.items;
        this.drafts[m.agentId] = m.draft;
        return;
      case 'agent':
        if (m.agent.convId === this.convId) this.agents[m.agent.id] = m.agent;
        return;
      case 'item': {
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
        this.rateLimit = m.notice.status === 'allowed' ? null : m.notice;
        return;
      case 'dirs':
        this.dirs = { path: m.path, parent: m.parent, entries: m.entries, error: m.error };
        return;
      case 'error':
        this.creating = false;
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
    this.view = 'chat';
    if (location.hash) history.replaceState(null, '', location.pathname);
  }

  /** Fetches an agent's transcript if the page does not have it yet. */
  loadItems(agentId: string): void {
    if (this.convId && !this.items[agentId]) this.send({ t: 'items', convId: this.convId, agentId });
  }

  /** Shows one agent's transcript. */
  viewOf(agentId: string): void {
    const isLead = this.agents[agentId]?.tier === 'lead';
    this.viewAgentId = isLead ? null : agentId;
    this.view = 'chat';
    this.loadItems(agentId);
  }

  sendMessage(text: string, images: ImageAttachment[]): boolean {
    if (this.convId === null) {
      const ref = crypto.randomUUID();
      this.pendingRef = ref;
      this.creating = true;
      const ok = this.send({ t: 'send', convId: null, cwd: this.newCwd, text, images, ref });
      if (!ok) this.creating = false;
      return ok;
    }
    return this.send({ t: 'send', convId: this.convId, text, images, agentId: this.viewAgentId ?? undefined });
  }

  saveSettings(next: Settings): void {
    this.settings = next;
    this.send({ t: 'settings', settings: next });
  }

  answer(requestId: string, decision: 'allow' | 'always' | 'deny', answers?: Record<string, string>): void {
    this.send({ t: 'permission', requestId, decision, answers });
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

function idFromHash(): string | null {
  const m = /^#\/c\/([A-Za-z0-9_-]+)$/.exec(location.hash);
  return m ? m[1]! : null;
}

export const store = new Store();

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function shortPath(path: string, home: string | undefined): string {
  return home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path;
}

export const STATUS_LABEL: Record<AgentInfo['status'], string> = {
  queued: 'Queued',
  running: 'Working',
  waiting: 'Waiting on its agents',
  idle: 'Idle',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};
