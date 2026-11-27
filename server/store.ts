import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo, ConversationMeta, Item } from '../shared/protocol.js';
import { CONVERSATIONS_DIR, writeFileAtomic } from './config.js';

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
  meta: ConversationMeta;
  agents: StoredAgent[];
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
  constructor(private root: string = CONVERSATIONS_DIR) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
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
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredConversation;
        if (parsed?.meta?.id === name && Array.isArray(parsed.agents)) out.push(parsed);
      } catch {
        // An unreadable conversation is skipped rather than stopping the app from starting.
      }
    }
    return out;
  }

  saveConversation(conv: StoredConversation): void {
    mkdirSync(join(this.dir(conv.meta.id), 'items'), { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.dir(conv.meta.id), 'conversation.json'), JSON.stringify(conv));
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

  deleteConversation(convId: string): void {
    rmSync(this.dir(convId), { recursive: true, force: true });
  }
}
