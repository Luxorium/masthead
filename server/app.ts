import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  VERSION,
  type AppState,
  type ClientMsg,
  type Draft,
  type ImageAttachment,
  type Item,
  type PermissionRequest,
  type Question,
  type RateLimitNotice,
  type ServerMsg,
  type Settings,
} from '../shared/protocol.js';
import type { Agent } from './agent.js';
import { HOME, SETTINGS_FILE, findClaude, loadSettings, sanitizeSettings, saveSettings, type ClaudeInfo } from './config.js';
import { Conversation, type ConversationHost } from './conversation.js';
import { Scheduler } from './scheduler.js';
import { Store } from './store.js';

/** A browser tab connected to the server. */
export interface Client {
  send(msg: ServerMsg): void;
}

interface PendingPermission {
  request: PermissionRequest;
  input: Record<string, unknown>;
  suggestions: Parameters<CanUseTool>[2]['suggestions'];
  resolve(result: PermissionResult): void;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 8;
const MAX_TEXT = 400_000;
const SAVE_DELAY_MS = 400;

/**
 * The whole application behind the web page: settings, conversations, the slot scheduler and the
 * open approval requests. Browser tabs are views onto this state; closing a tab stops nothing.
 */
export class App implements ConversationHost {
  readonly scheduler: Scheduler;
  private currentSettings: Settings;
  private settingsFile: string;
  private claude: ClaudeInfo;
  private store: Store;
  private conversations = new Map<string, Conversation>();
  private clients = new Set<Client>();
  private pending = new Map<string, PendingPermission>();
  private dirty = new Map<string, NodeJS.Timeout>();
  private busy = new Map<string, boolean>();
  /** The latest usage-limit notice of each kind, so a tab that connects later sees it too. */
  private usage = new Map<string, RateLimitNotice>();
  /** Disk writes that are failing; each is logged once until it works again. */
  private failing = new Set<string>();

  /**
   * `settingsFile` is where changes to the settings are written. Tests pass their own file so they
   * never touch the person's real settings.
   */
  constructor(opts: { store?: Store; claude?: ClaudeInfo; settings?: Settings; settingsFile?: string } = {}) {
    this.settingsFile = opts.settingsFile ?? SETTINGS_FILE;
    this.currentSettings = opts.settings ?? loadSettings(this.settingsFile);
    this.claude = opts.claude ?? findClaude();
    this.store = opts.store ?? new Store();
    this.scheduler = new Scheduler((tier) => this.currentSettings.tiers[tier].max);
    for (const stored of this.store.loadAll()) {
      const conv = Conversation.restore(this, stored);
      this.conversations.set(conv.meta.id, conv);
    }
  }

  // ---- ConversationHost ----

  settings(): Settings {
    return this.currentSettings;
  }

  claudePath(): string | null {
    return this.claude.path;
  }

  agentChanged(conv: Conversation, agent: Agent): void {
    this.broadcast({ t: 'agent', agent: agent.info });
    this.scheduleSave(conv);
    const busy = conv.busy();
    if (this.busy.get(conv.meta.id) !== busy) {
      this.busy.set(conv.meta.id, busy);
      this.broadcast({ t: 'conversations', conversations: this.metas() });
    }
  }

  itemChanged(conv: Conversation, agent: Agent, item: Item): void {
    // A deleted conversation's processes may still be winding down; nothing of theirs is kept.
    if (this.conversations.get(conv.meta.id) !== conv) return;
    this.safely('transcript', () => this.store.appendItem(conv.meta.id, agent.id, item));
    this.broadcast({ t: 'item', convId: conv.meta.id, agentId: agent.id, item });
  }

  draftChanged(conv: Conversation, agent: Agent, draft: Draft | null): void {
    this.broadcast({ t: 'draft', convId: conv.meta.id, agentId: agent.id, draft });
  }

  metaChanged(conv: Conversation): void {
    this.scheduleSave(conv);
    this.broadcast({ t: 'conversations', conversations: this.metas() });
  }

  rateLimit(notice: RateLimitNotice): void {
    this.usage.set(notice.type ?? '', notice);
    this.broadcast({ t: 'rate_limit', notice });
  }

  askPermission(conv: Conversation, agent: Agent, toolName: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    // Masthead's own tools are checked by the conversation, not by the person.
    if (toolName.startsWith('mcp__masthead__')) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const isQuestion = toolName === 'AskUserQuestion';
    const request: PermissionRequest = {
      id: randomUUID(),
      convId: conv.meta.id,
      agentId: agent.id,
      agentName: agent.name,
      kind: isQuestion ? 'question' : 'permission',
      toolName,
      title: opts.title,
      description: opts.description ?? opts.decisionReason,
      input,
      canAlways: !isQuestion && (opts.suggestions?.length ?? 0) > 0,
      questions: isQuestion && Array.isArray(input.questions) ? (input.questions as Question[]) : undefined,
      ts: Date.now(),
    };
    return new Promise<PermissionResult>((resolvePermission) => {
      const settle = (result: PermissionResult) => {
        if (!this.pending.delete(request.id)) return;
        opts.signal.removeEventListener('abort', onAbort);
        this.broadcast({ t: 'permission_resolved', requestId: request.id });
        resolvePermission(result);
      };
      const onAbort = () => settle({ behavior: 'deny', message: 'The request was cancelled.' });
      this.pending.set(request.id, { request, input, suggestions: opts.suggestions, resolve: settle });
      opts.signal.addEventListener('abort', onAbort, { once: true });
      this.broadcast({ t: 'permission_request', request });
    });
  }

  cancelPermissions(agentId: string): void {
    for (const p of [...this.pending.values()]) {
      if (p.request.agentId === agentId) p.resolve({ behavior: 'deny', message: 'The agent was stopped.' });
    }
  }

  // ---- persistence ----

  /** Runs a disk write. A failure (a full disk, say) is logged once and never stops the server. */
  private safely(what: string, write: () => void): void {
    try {
      write();
      this.failing.delete(what);
    } catch (e) {
      if (this.failing.has(what)) return;
      this.failing.add(what);
      console.error(`Masthead could not save the ${what}: ${(e as Error).message}`);
    }
  }

  /** How many conversations have agents working. */
  workingCount(): number {
    let n = 0;
    for (const c of this.conversations.values()) if (c.busy()) n++;
    return n;
  }

  private scheduleSave(conv: Conversation): void {
    const id = conv.meta.id;
    if (this.dirty.has(id)) return;
    this.dirty.set(
      id,
      setTimeout(() => {
        this.dirty.delete(id);
        if (this.conversations.has(id)) this.safely('conversation', () => this.store.saveConversation(conv.toStored()));
      }, SAVE_DELAY_MS),
    );
  }

  private flush(): void {
    for (const [id, timer] of this.dirty) {
      clearTimeout(timer);
      const conv = this.conversations.get(id);
      if (conv) this.safely('conversation', () => this.store.saveConversation(conv.toStored()));
    }
    this.dirty.clear();
  }

  /** Stops every agent and writes everything to disk. */
  shutdown(): void {
    for (const p of [...this.pending.values()]) p.resolve({ behavior: 'deny', message: 'Masthead is shutting down.' });
    for (const conv of this.conversations.values()) conv.shutdown();
    this.flush();
  }

  // ---- browser tabs ----

  private metas() {
    return [...this.conversations.values()].map((c) => ({ ...c.meta, busy: c.busy() })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private state(): AppState {
    return { version: VERSION, settings: this.currentSettings, conversations: this.metas(), claude: this.claude, home: HOME, pending: [...this.pending.values()].map((p) => p.request), usage: [...this.usage.values()] };
  }

  private broadcast(msg: ServerMsg): void {
    for (const c of this.clients) c.send(msg);
  }

  connect(client: Client): void {
    this.clients.add(client);
    client.send({ t: 'state', state: this.state() });
  }

  disconnect(client: Client): void {
    this.clients.delete(client);
  }

  /** Handles one message from a browser tab. Anything malformed is answered with an error, never thrown. */
  handle(client: Client, raw: unknown): void {
    try {
      this.dispatch(client, raw as ClientMsg);
    } catch (e) {
      const ref = (raw as { ref?: unknown } | null)?.ref;
      client.send({ t: 'error', message: (e as Error).message, ...(typeof ref === 'string' ? { ref: ref.slice(0, 80) } : {}) });
    }
  }

  private conv(id: unknown): Conversation {
    const conv = typeof id === 'string' ? this.conversations.get(id) : undefined;
    if (!conv) throw new Error('That conversation no longer exists.');
    return conv;
  }

  private dispatch(client: Client, msg: ClientMsg): void {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error('Malformed message.');
    switch (msg.t) {
      case 'hello':
        client.send({ t: 'state', state: this.state() });
        return;
      case 'open': {
        const conv = this.conv(msg.convId);
        client.send({
          t: 'conversation',
          conv: conv.meta,
          agents: conv.infos(),
          pending: [...this.pending.values()].filter((p) => p.request.convId === conv.meta.id).map((p) => p.request),
        });
        return;
      }
      case 'items': {
        const conv = this.conv(msg.convId);
        const agent = conv.agents.get(String(msg.agentId));
        if (!agent) throw new Error('That agent no longer exists.');
        client.send({ t: 'items', convId: conv.meta.id, agentId: agent.id, items: this.store.loadItems(conv.meta.id, agent.id), draft: agent.currentDraft() });
        return;
      }
      case 'send': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        const images = this.checkImages(msg.images);
        if (!text.trim() && images.length === 0) throw new Error('The message is empty.');
        if (text.length > MAX_TEXT) throw new Error('The message is too long.');
        let conv: Conversation;
        if (msg.convId === null || msg.convId === undefined) {
          if (!this.claude.path) throw new Error(this.claude.error ?? 'Claude Code was not found.');
          const cwd = this.checkDir(typeof msg.cwd === 'string' && msg.cwd ? msg.cwd : this.currentSettings.defaultCwd);
          conv = Conversation.create(this, cwd);
          this.conversations.set(conv.meta.id, conv);
          if (cwd !== this.currentSettings.defaultCwd) this.updateSettings({ ...this.currentSettings, defaultCwd: cwd });
          client.send({ t: 'created', convId: conv.meta.id, ref: msg.ref });
        } else {
          conv = this.conv(msg.convId);
        }
        conv.userSend(text, images, typeof msg.agentId === 'string' ? msg.agentId : undefined);
        return;
      }
      case 'interrupt':
        void this.conv(msg.convId).interruptLead();
        return;
      case 'stop_agent':
        this.conv(msg.convId).stopAgent(String(msg.agentId), 'Stopped by the person.');
        return;
      case 'stop_all':
        this.conv(msg.convId).stopAll();
        return;
      case 'permission':
        this.answerPermission(msg);
        return;
      case 'settings':
        // A partial update changes only the fields it names.
        this.updateSettings(sanitizeSettings(msg.settings, this.currentSettings));
        return;
      case 'rename': {
        const conv = this.conv(msg.convId);
        const title = String(msg.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (title) {
          conv.meta.title = title;
          this.metaChanged(conv);
        }
        return;
      }
      case 'delete': {
        const conv = this.conv(msg.convId);
        conv.stopAll();
        conv.shutdown();
        const timer = this.dirty.get(conv.meta.id);
        if (timer) clearTimeout(timer);
        this.dirty.delete(conv.meta.id);
        this.conversations.delete(conv.meta.id);
        this.busy.delete(conv.meta.id);
        this.store.deleteConversation(conv.meta.id);
        this.broadcast({ t: 'deleted', convId: conv.meta.id });
        this.broadcast({ t: 'conversations', conversations: this.metas() });
        return;
      }
      case 'dirs':
        client.send(this.listDirs(String(msg.path ?? '')));
        return;
      default:
        throw new Error('Unknown request.');
    }
  }

  private updateSettings(next: Settings): void {
    this.currentSettings = next;
    this.safely('settings', () => saveSettings(next, this.settingsFile));
    this.scheduler.limitsChanged();
    this.broadcast({ t: 'settings', settings: next });
  }

  private answerPermission(msg: Extract<ClientMsg, { t: 'permission' }>): void {
    const p = this.pending.get(String(msg.requestId));
    if (!p) return; // already answered, perhaps from another tab
    if (msg.decision === 'deny') {
      p.resolve({ behavior: 'deny', message: (typeof msg.message === 'string' && msg.message.trim()) || 'The person declined this.' });
    } else if (p.request.kind === 'question') {
      const answers: Record<string, string> = {};
      for (const [k, v] of Object.entries(msg.answers ?? {})) if (typeof v === 'string') answers[k] = v;
      p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers } });
    } else if (msg.decision === 'always' && p.suggestions?.length) {
      p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: p.suggestions });
    } else {
      p.resolve({ behavior: 'allow', updatedInput: p.input });
    }
  }

  private checkImages(images: unknown): ImageAttachment[] {
    if (!Array.isArray(images)) return [];
    if (images.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per message.`);
    return images.map((img) => {
      const i = img as ImageAttachment;
      if (!i || !IMAGE_TYPES.has(i.mediaType) || typeof i.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(i.data)) throw new Error('Unsupported image.');
      return { mediaType: i.mediaType, data: i.data };
    });
  }

  private checkDir(path: string): string {
    const full = resolve(path.replace(/^~(?=$|\/)/, HOME));
    let ok = false;
    try {
      ok = statSync(full).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`${full} is not a folder.`);
    return full;
  }

  /** Folders inside `path`, for the folder picker. Hidden folders are left out. */
  private listDirs(path: string): ServerMsg {
    const full = resolve((path || HOME).replace(/^~(?=$|\/)/, HOME));
    const parent = dirname(full) === full ? null : dirname(full);
    try {
      const entries = readdirSync(full, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && this.isDir(join(full, e.name)))))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
      return { t: 'dirs', path: full, parent, entries };
    } catch (e) {
      return { t: 'dirs', path: full, parent, entries: [], error: (e as Error).message };
    }
  }

  private isDir(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
}
