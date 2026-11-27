import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentInfo, ConversationMeta, Item } from '../../shared/protocol.js';
import { CONVERSATIONS_DIR } from '../paths.js';
import { writeFileAtomic } from './atomic.js';
import { BlobStore, blobsOf } from './blobs.js';
import { FORMAT, migrateConversation } from './migrate.js';
import { readPage, type Page } from './transcript.js';

/** What is kept on disk for one agent besides its transcript. */
export interface StoredAgent {
  info: AgentInfo;
  /** The Claude Code session to resume when the agent is woken again. */
  sessionId: string | null;
  /** Whether it still owes its parent a report. */
  owesReport: boolean;
  /** The task of an agent that never got to start, so it is not lost if it is woken later. */
  seed?: string;
}

export interface StoredConversation {
  /** File format; absent in 0.1.x files (format 1). Written as FORMAT. */
  format?: number;
  meta: ConversationMeta;
  agents: StoredAgent[];
  /** Ids of agents the person stopped, which other agents may not wake. Missing in files before 0.1.4. */
  stoppedByPerson?: string[];
  /** Messages sent between agents so far, counted against the conversation's limit. Missing before 0.1.4. */
  agentMessages?: number;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function assertId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`bad id: ${id}`);
  return id;
}

/**
 * Conversations on disk: one folder each, holding `conversation.json` (the conversation and its agents)
 * and `items/<agent>.jsonl` (each agent's transcript, one item per line).
 *
 * A transcript file is append-only. Changing an item appends a new line with the same id, and the last
 * line for an id wins when the file is read back.
 */
export class Store {
  readonly blobs: BlobStore;
  /** Conversations loaded from an older format: their file is backed up once before it is rewritten. */
  private needsBackup = new Set<string>();

  constructor(private root: string = CONVERSATIONS_DIR) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.blobs = new BlobStore(this.root);
    // A whole-store marker, so a later version can tell what it is opening without reading every file.
    // In the data folder beside `conversations/`; a test store in a temp folder keeps it inside.
    const marker = basename(this.root) === 'conversations' ? join(this.root, '..', 'format') : join(this.root, '.format');
    try {
      if (readFileSync(marker, 'utf8').trim() !== String(FORMAT)) writeFileAtomic(marker, `${FORMAT}\n`);
    } catch {
      try {
        writeFileAtomic(marker, `${FORMAT}\n`);
      } catch {
        // a read-only data folder still loads
      }
    }
  }

  private dir(convId: string): string {
    return join(this.root, assertId(convId));
  }

  private itemsFile(convId: string, agentId: string): string {
    return join(this.dir(convId), 'items', `${assertId(agentId)}.jsonl`);
  }

  loadAll(): StoredConversation[] {
    const out: StoredConversation[] = [];
    for (const name of readdirSync(this.root)) {
      if (!SAFE_ID.test(name)) continue;
      const file = join(this.root, name, 'conversation.json');
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as StoredConversation;
        if (raw?.meta?.id !== name || !Array.isArray(raw.agents)) continue;
        const m = migrateConversation(raw);
        if (!m) continue; // written by a newer Masthead: left alone
        if (m.from < FORMAT) this.needsBackup.add(name);
        out.push(m.value);
      } catch {
        // An unreadable conversation is skipped rather than stopping the app from starting.
      }
    }
    return out;
  }

  saveConversation(conv: StoredConversation): void {
    mkdirSync(join(this.dir(conv.meta.id), 'items'), { recursive: true, mode: 0o700 });
    const file = join(this.dir(conv.meta.id), 'conversation.json');
    if (this.needsBackup.has(conv.meta.id)) {
      // The way back to 0.1.x: its own file, kept beside the new one, written before the first rewrite.
      const bak = `${file}.v1.bak`;
      if (!existsSync(bak) && existsSync(file)) copyFileSync(file, bak);
      this.needsBackup.delete(conv.meta.id);
    }
    writeFileAtomic(file, JSON.stringify({ ...conv, format: FORMAT }));
  }

  appendItem(convId: string, agentId: string, item: Item): void {
    const file = this.itemsFile(convId, agentId);
    try {
      appendFileSync(file, JSON.stringify(item) + '\n', { mode: 0o600 });
    } catch {
      mkdirSync(join(this.dir(convId), 'items'), { recursive: true, mode: 0o700 });
      appendFileSync(file, JSON.stringify(item) + '\n', { mode: 0o600 });
    }
  }

  loadItems(convId: string, agentId: string): Item[] {
    const file = this.itemsFile(convId, agentId);
    if (!existsSync(file)) return [];
    const byId = new Map<string, Item>();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const item = JSON.parse(line) as Item;
        // Re-inserting keeps the position of the first appearance, which is transcript order.
        byId.set(item.id, item);
      } catch {
        // A torn last line from a crash is ignored.
      }
    }
    return [...byId.values()];
  }

  /** One page of a transcript, newest first; see readPage. */
  readItems(convId: string, agentId: string, opts: { before?: number | null; limit: number }): Page<Item> {
    return readPage<Item>(this.itemsFile(convId, agentId), opts);
  }

  /** Every blob any item of the conversation refers to, for garbage collection. */
  referencedBlobs(convId: string): Set<string> {
    const refs = new Set<string>();
    let names: string[] = [];
    try {
      names = readdirSync(join(this.dir(convId), 'items')).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return refs;
    }
    for (const n of names) for (const item of this.loadItems(convId, n.slice(0, -6))) for (const h of blobsOf(item)) refs.add(h);
    return refs;
  }

  /** Removes the conversation's images that no item refers to. */
  collectBlobs(convId: string): number {
    return this.blobs.collect(convId, this.referencedBlobs(convId));
  }

  /** Deletes the conversation's folder: transcripts and images with it. */
  deleteConversation(convId: string): void {
    // Retries cover Windows, where a file still open elsewhere makes the removal fail for a moment.
    rmSync(this.dir(convId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
