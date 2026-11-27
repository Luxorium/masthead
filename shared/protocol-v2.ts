// Protocol version 2 between the page and the server: the messages that are new or changed from
// version 1 (shared/protocol.ts). Kept in its own file while shared/protocol.ts is being reworked by
// another change; the two merge into one file before 0.2.0. Nothing in here may import Node or DOM APIs.
// Agreed with the page side (charlie, web.md section 2; core.md section 7).
import type { AgentInfo, ClientMsg, ConversationMeta, Draft, Item, PermissionRequest, ServerMsg } from './protocol.js';

export const PROTOCOL_VERSION = 2;

/** What a version 2 page can handle. */
export type Capability = 'drafts-delta' | 'items-paging' | 'blobs' | 'resync';

export type ErrorCode = 'protocol' | 'refused' | 'not_found' | 'too_large' | 'invalid';

/** Live `item` events clip tool input and output past this many characters; `item_full` fetches the rest. */
export const CLIP_CHARS = 16 * 1024;
/** Events kept per conversation for resync. */
export const RING_SIZE = 500;

/** For badges on every conversation: who is asking, without the request itself. */
export interface ApprovalSummary {
  id: string;
  convId: string;
  agentName: string;
  kind: PermissionRequest['kind'];
}

// ---- page -> server (in addition to version 1's) ----
export type ClientMsgV2 =
  | { t: 'hello'; protocol: number; caps?: Capability[] }
  /** Start receiving one conversation's events. `since`: the last `seq` the page has, to replay from. */
  | { t: 'subscribe'; convId: string; since?: number }
  | { t: 'unsubscribe'; convId: string }
  /** A gap in a draft's `dseq`: send its whole text once. */
  | { t: 'draft_sync'; convId: string; agentId: string }
  /** The whole of an item that arrived clipped. */
  | { t: 'item_full'; convId: string; agentId: string; itemId: string }
  /** Paged transcript: newest page first; `before` is the `cursor` of the previous page. */
  | { t: 'items'; convId: string; agentId: string; before?: number | null; limit?: number }
  /** Version 1's `send`, plus the team profile for a new conversation (default: the settings' default). */
  | (Extract<ClientMsg, { t: 'send' }> & { profile?: string })
  | ClientMsg;

/** A per-conversation event as sent to a subscriber: version 1's event plus its sequence number. */
export type Sequenced<T> = T & { seq: number };

// ---- server -> page (in addition to, or replacing, version 1's) ----
export type ServerMsgV2 =
  /** Version 1's `state` with `protocol: 2`; `pending` holds summaries, not full requests. */
  | { t: 'state'; protocol: 2; state: Record<string, unknown> & { pending: ApprovalSummary[]; blobToken?: string } }
  /** Snapshot on subscribe (or when `since` is too old to replay). */
  | { t: 'conversation'; conv: ConversationMeta; agents: AgentInfo[]; pending: PermissionRequest[]; drafts: Record<string, Draft & { dseq: number }>; seq: number }
  | Sequenced<{ t: 'agent'; agent: AgentInfo }>
  /** `truncated`: tool `input`/`result` were clipped; ask with `item_full`. */
  | Sequenced<{ t: 'item'; convId: string; agentId: string; item: Item; truncated?: boolean }>
  /** A draft grew by `append`, or (with `text`) is replaced whole. `dseq` counts within one draft. */
  | Sequenced<{ t: 'draft'; convId: string; agentId: string; dseq: number; kind: Draft['kind']; append?: string; text?: string }>
  /** The draft ended (its text arrives as an item). */
  | Sequenced<{ t: 'draft_end'; convId: string; agentId: string }>
  | Sequenced<{ t: 'permission_request'; request: PermissionRequest }>
  /** Every page, for badges. */
  | { t: 'approval'; summary: ApprovalSummary }
  /** Resync could not replay: the page reloads this conversation (a snapshot follows). */
  | { t: 'resync'; convId: string }
  | { t: 'item_full'; convId: string; agentId: string; item: Item }
  | { t: 'items'; convId: string; agentId: string; items: Item[]; draft: Draft | null; cursor?: number | null; more?: boolean }
  | { t: 'error'; code: ErrorCode; message: string; ref?: string }
  | ServerMsg;
