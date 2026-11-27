import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Backend, PermissionAnswer, PermissionAsk } from '../backends/types.js';
import { FakeBackend, fakeBackendSelected } from '../backends/fake/index.js';
import { ClaudeBackend } from '../backends/claude/session.js';
import {
  VERSION,
  type AppState,
  type ClientMsg,
  type Draft,
  type ImageAttachment,
  type Item,
  type PermissionRequest,
  type RateLimitNotice,
  type ServerMsg,
  type Settings,
} from '../../shared/protocol.js';
import type { Agent } from '../runtime/agent.js';
import { HOME, SETTINGS_FILE } from '../paths.js';
import { findClaude, type ClaudeInfo } from '../backends/claude/env.js';
import { loadSettings, sanitizeSettings, saveSettings } from '../settings/settings.js';
import { Conversation, type ConversationHost } from '../core/conversation.js';
import { Scheduler } from '../core/scheduler.js';
import type { BlobRef } from '../storage/blobs.js';
import { Store } from '../storage/store.js';
import { Hub, type Client } from './clients.js';

/** A browser tab connected to the server. */
export type { Client } from './clients.js';

interface PendingPermission {
  request: PermissionRequest;
  resolve(answer: PermissionAnswer): void;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 8;
/** The same limits as the page's composer (web/src/lib/Composer.svelte), in decoded bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 30 * 1024 * 1024;
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
  private pending = new Map<string, PendingPermission>();
  private dirty = new Map<string, NodeJS.Timeout>();
  private busy = new Map<string, boolean>();
  /** The latest usage-limit notice of each kind, so a tab that connects later sees it too. */
  private usage = new Map<string, RateLimitNotice>();
  /** Disk writes that are failing; each is logged once until it works again. */
  private failing = new Set<string>();
  /** The fake backend when the environment selects it (see the constructor); otherwise null. */
  private fake: FakeBackend | null;
  private claudeBackend: ClaudeBackend | undefined;

  /**
   * `settingsFile` is where changes to the settings are written. Tests pass their own file so they
   * never touch the person's real settings.
   */
  constructor(opts: { store?: Store; claude?: ClaudeInfo; settings?: Settings; settingsFile?: string } = {}) {
    this.settingsFile = opts.settingsFile ?? SETTINGS_FILE;
    this.currentSettings = opts.settings ?? loadSettings(this.settingsFile);
    // The scripted fake backend, for the browser test and CI only: it needs both variables, and the
    // page can never choose it.
    if (process.env.MASTHEAD_BACKEND === 'fake' && !fakeBackendSelected(process.env)) {
      throw new Error('MASTHEAD_BACKEND=fake is for tests only and also needs MASTHEAD_ALLOW_FAKE=1.');
    }
    this.fake = fakeBackendSelected(process.env) ? new FakeBackend({ stepMs: Number(process.env.MASTHEAD_FAKE_STEP_MS) || 20 }) : null;
    this.claude = this.fake ? { path: null, version: 'fake backend (tests only)' } : (opts.claude ?? findClaude());
    this.store = opts.store ?? new Store();
    this.scheduler = new Scheduler((tier) => this.currentSettings.tiers[tier].max);
    for (const stored of this.store.loadAll()) {
      const conv = Conversation.restore(this, stored);
      this.conversations.set(conv.meta.id, conv);
      // Images no transcript refers to any more (a conversation saved by an older run, a failed send).
      this.safely('images', () => void this.store.collectBlobs(conv.meta.id));
    }
  }

  // ---- ConversationHost ----

  backend(): Backend | undefined {
    if (this.fake) return this.fake;
    if (!this.claude.path) return undefined;
    this.claudeBackend ??= new ClaudeBackend({ path: this.claude.path });
    return this.claudeBackend;
  }

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

  askPermission(conv: Conversation, agent: Agent, ask: PermissionAsk): Promise<PermissionAnswer> {
    const isQuestion = ask.kind === 'question';
    const request: PermissionRequest = {
      id: randomUUID(),
      convId: conv.meta.id,
      agentId: agent.id,
      agentName: agent.name,
      kind: isQuestion ? 'question' : 'permission',
      toolName: ask.toolName,
      title: ask.title,
      description: ask.description,
      input: ask.input,
      canAlways: !isQuestion && ask.canAlways,
      questions: isQuestion ? ask.questions : undefined,
      ts: Date.now(),
    };
    return new Promise<PermissionAnswer>((resolvePermission) => {
      const settle = (answer: PermissionAnswer) => {
        if (!this.pending.delete(request.id)) return;
        ask.signal.removeEventListener('abort', onAbort);
        this.broadcast({ t: 'permission_resolved', requestId: request.id });
        resolvePermission(answer);
      };
      const onAbort = () => settle({ decision: 'deny', message: 'The request was cancelled.' });
      this.pending.set(request.id, { request, resolve: settle });
      ask.signal.addEventListener('abort', onAbort, { once: true });
      this.broadcast({ t: 'permission_request', request });
    });
  }

  cancelPermissions(agentId: string): void {
    for (const p of [...this.pending.values()]) {
      if (p.request.agentId === agentId) p.resolve({ decision: 'deny', message: 'The agent was stopped.' });
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
    for (const p of [...this.pending.values()]) p.resolve({ decision: 'deny', message: 'Masthead is shutting down.' });
    for (const conv of this.conversations.values()) conv.shutdown();
    this.flush();
  }

  // ---- browser tabs ----

  private metas() {
    return [...this.conversations.values()].map((c) => ({ ...c.meta, busy: c.busy() })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The image store, for the transport's /blob routes. */
  get blobs() {
    return this.store.blobs;
  }

  hasConversation(convId: string): boolean {
    return this.conversations.has(convId);
  }

  /** Stores an image for a conversation (tool results, first-message attachments). Never throws. */
  storeImage(convId: string, data: string, mediaType: string): { ref: BlobRef } | { error: string } {
    try {
      return { ref: this.store.blobs.put(convId, Buffer.from(data, 'base64'), mediaType) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  private state(client?: Client): AppState {
    return { ...(client?.blobToken ? { blobToken: client.blobToken } : {}), version: VERSION, settings: this.currentSettings, conversations: this.metas(), claude: this.claude, home: HOME, pending: [...this.pending.values()].map((p) => p.request), usage: [...this.usage.values()] };
  }

  /** Every tab, in the protocol version it speaks; see clients.ts. */
  private hub: Hub = new Hub({
    snapshot: (convId) => {
      const conv = this.conversations.get(convId);
      if (!conv) return null;
      const lastItemIds: Record<string, string> = {};
      for (const a of conv.infos()) {
        const last = this.store.readItems(convId, a.id, { limit: 1 }).items[0];
        if (last) lastItemIds[a.id] = last.id;
      }
      return { conv: conv.meta, agents: conv.infos(), pending: [...this.pending.values()].filter((p) => p.request.convId === convId).map((p) => p.request), lastItemIds };
    },
    fullItem: (convId, agentId, itemId) => {
      if (!this.conversations.get(convId)?.agents.has(agentId)) return null;
      return this.store.loadItems(convId, agentId).find((i) => i.id === itemId) ?? null;
    },
    state: (client) => this.state(client),
  });

  private broadcast(msg: ServerMsg): void {
    this.hub.publish(msg);
  }

  connect(client: Client): void {
    this.hub.add(client);
    // A version 2 page says hello and gets its own `state`; this one is what a 0.1.x page expects.
    client.send({ t: 'state', state: this.state(client) });
  }

  disconnect(client: Client): void {
    this.hub.remove(client);
  }

  /** Handles one message from a browser tab. Anything malformed is answered with an error, never thrown. */
  handle(client: Client, raw: unknown): void {
    try {
      const msg = raw as Record<string, unknown> | null;
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error('Malformed message.');
      // The one gate for what a tab may send (a remote device's role).
      this.hub.admit(client, msg.t);
      if (this.hub.intercept(client, msg)) return;
      if (msg.t === 'hello' && this.hub.isV2(client)) {
        client.send(this.hub.stateV2(client));
        return;
      }
      this.dispatch(client, raw as ClientMsg);
    } catch (e) {
      const ref = (raw as { ref?: unknown } | null)?.ref;
      this.hub.error(client, e, typeof ref === 'string' ? ref.slice(0, 80) : undefined);
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
        const paging = msg as { before?: unknown; limit?: unknown };
        if (typeof paging.limit === 'number') {
          // Newest page first; `cursor` asks for the next older page.
          const limit = Math.max(1, Math.min(500, Math.trunc(paging.limit)));
          const before = typeof paging.before === 'number' && paging.before >= 0 ? paging.before : null;
          const page = this.store.readItems(conv.meta.id, agent.id, { before, limit });
          client.send({ t: 'items', convId: conv.meta.id, agentId: agent.id, items: page.items, draft: agent.currentDraft(), cursor: page.cursor, more: page.more } as ServerMsg);
        } else {
          client.send({ t: 'items', convId: conv.meta.id, agentId: agent.id, items: this.store.loadItems(conv.meta.id, agent.id), draft: agent.currentDraft() });
        }
        return;
      }
      case 'send': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        const images = this.checkImages(msg.images);
        if (!text.trim() && images.length === 0) throw new Error('The message is empty.');
        if (text.length > MAX_TEXT) throw new Error('The message is too long.');
        let conv: Conversation;
        let firstRefs: BlobRef[] | undefined;
        if (msg.convId === null || msg.convId === undefined) {
          if (!this.claude.path && !this.fake) throw new Error(this.claude.error ?? 'Claude Code was not found.');
          const cwd = this.checkDir(typeof msg.cwd === 'string' && msg.cwd ? msg.cwd : this.currentSettings.defaultCwd);
          conv = Conversation.create(this, cwd);
          this.conversations.set(conv.meta.id, conv);
          if (cwd !== this.currentSettings.defaultCwd) this.updateSettings({ ...this.currentSettings, defaultCwd: cwd });
          client.send({ t: 'created', convId: conv.meta.id, ref: msg.ref });
          // The first message has no conversation to upload into beforehand: its images become files now.
          const refs: BlobRef[] = [];
          for (const img of images) {
            const stored = this.storeImage(conv.meta.id, img.data, img.mediaType);
            if ('ref' in stored) refs.push(stored.ref);
          }
          firstRefs = refs;
        } else {
          conv = this.conv(msg.convId);
        }
        // The stored refs go on the person's item (Conversation.userSend's fourth argument, once it takes one).
        (conv.userSend as (t: string, i: typeof images, a?: string, refs?: BlobRef[]) => void).call(conv, text, images, typeof msg.agentId === 'string' ? msg.agentId : undefined, firstRefs);
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
    // Running agents take up what can change without restarting them.
    for (const conv of this.conversations.values()) conv.settingsChanged();
    this.broadcast({ t: 'settings', settings: next });
  }

  private answerPermission(msg: Extract<ClientMsg, { t: 'permission' }>): void {
    const p = this.pending.get(String(msg.requestId));
    if (!p) return; // already answered, perhaps from another tab
    if (msg.decision === 'deny') {
      p.resolve({ decision: 'deny', message: (typeof msg.message === 'string' && msg.message.trim()) || 'The person declined this.' });
    } else if (p.request.kind === 'question') {
      const answers: Record<string, string> = {};
      for (const [k, v] of Object.entries(msg.answers ?? {})) if (typeof v === 'string') answers[k] = v;
      p.resolve({ decision: 'allow', answers });
    } else if (msg.decision === 'always' && p.request.canAlways) {
      p.resolve({ decision: 'always' });
    } else {
      p.resolve({ decision: 'allow' });
    }
  }

  private checkImages(images: unknown): ImageAttachment[] {
    if (!Array.isArray(images)) return [];
    if (images.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per message.`);
    let total = 0;
    return images.map((img) => {
      const i = img as ImageAttachment;
      if (!i || !IMAGE_TYPES.has(i.mediaType) || typeof i.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(i.data)) throw new Error('Unsupported image.');
      // Decoded size from the base64 length: 3 bytes per 4 characters, less the padding.
      const bytes = Math.floor((i.data.length * 3) / 4) - (i.data.endsWith('==') ? 2 : i.data.endsWith('=') ? 1 : 0);
      if (bytes > MAX_IMAGE_BYTES) throw new Error('An image is larger than 5 MB.');
      total += bytes;
      if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error('The images together are larger than 30 MB.');
      return { mediaType: i.mediaType, data: i.data };
    });
  }

  private checkDir(path: string): string {
    const full = resolve(expandHome(path, HOME));
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
    if (process.platform === 'win32' && path === DRIVES) return { t: 'dirs', path: DRIVES, parent: null, entries: windowsDrives(existsSync) };
    const full = resolve(expandHome(path || HOME, HOME));
    // Above a Windows drive root comes the list of drives, so another drive can be reached.
    const parent = dirname(full) === full ? (process.platform === 'win32' ? DRIVES : null) : dirname(full);
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

/** The folder picker's name for "the list of drives" on Windows (not a path any folder can have). */
export const DRIVES = 'drives:';

/** Expands a leading `~` to the home folder; on Windows `~\\` works as well as `~/`. */
export function expandHome(path: string, home: string, platform: NodeJS.Platform = process.platform): string {
  return path.replace(platform === 'win32' ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, home);
}

/** The drive roots that exist on Windows, e.g. ['C:\\', 'D:\\']. */
export function windowsDrives(exists: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (exists(root)) out.push(root);
  }
  return out;
}
