/**
 * The seam between Masthead's runtime and an agent backend (Claude Code, Codex, the fake for tests).
 * Agreed in docs/plans/0.2.0/core.md §2.4 and backends.md §3. A backend knows nothing about teams:
 * it opens sessions, takes messages and reports what happened as neutral events. It never builds
 * protocol Items or page text, and it decides nothing about when an agent's work is over.
 */
import type { AgentUsage, Effort, ImageAttachment, Question, RateLimitNotice } from '../../shared/protocol.js';

export type BackendId = 'claude-code' | 'codex' | 'fake' | (string & {});

/** What detection found. Never holds credentials. */
export interface BackendInfo {
  id: BackendId;
  label: string;
  available: boolean;
  path: string | null;
  version: string | null;
  /** null when it could not be told. */
  signedIn: boolean | null;
  minVersion?: string;
  /** Shown on the page when the backend cannot be used (missing, too old, signed out). */
  error?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Masthead levels this model supports. */
  efforts: Effort[];
  /** How each Masthead level maps to the backend's own setting. */
  nativeEffort: Partial<Record<Effort, string>>;
  contextWindow?: number;
  default?: boolean;
}

export interface BackendCaps {
  /** Levels with any effect; [] = no effort control. */
  efforts: Effort[];
  /** An effort change reaches a running session. */
  liveEffort: boolean;
  /** Session.setModel exists. */
  liveModel: boolean;
  resume: boolean;
  images: boolean;
  interrupt: boolean;
  /** Reports background commands. */
  background: boolean;
  permissions: 'callback' | 'mode-only' | 'none';
  /** "Always allow" rules can be offered. */
  approvalsAlways: boolean;
  /** The agent can ask the person a question. */
  questions: boolean;
  /** false: turn results do not name the messages they consumed (the runtime's fallback rule). */
  consumedIds: boolean;
  /** false: the runtime queues sends until turnEnded and sends them as one batch. */
  midTurnDelivery: boolean;
  contextUsage: boolean;
  /** Can skip the person's own MCP servers. */
  lean: boolean;
}

/** A JSON Schema object describing a tool's input. */
export type JSONSchema = Record<string, unknown>;

/** One team tool, bound to the agent whose session it is given to: run() closes over that agent. */
export interface ToolDef {
  name: string;
  description: string;
  input: JSONSchema;
  run(input: unknown): Promise<string>;
}

export interface SessionSpec {
  resume?: string;
  model: string;
  effort: Effort;
  cwd: string;
  /** Masthead's system text for this agent. */
  instructions: string;
  tools: ToolDef[];
  /** false for every non-lead. */
  canAskPerson: boolean;
  permissionMode: string;
  lean: boolean;
  /** Without credentials added or removed. */
  env: Record<string, string | undefined>;
}

export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image';
  mediaType: ImageAttachment['mediaType'];
  /** Base64 without the data: prefix. */
  data: string;
}
/** Images only if caps.images. */
export type Content = string | Array<TextPart | ImagePart>;

export interface Session {
  /** Queues a message; `id` is the runtime's and comes back in turnEnded.consumed. */
  send(id: string, content: Content): void;
  interrupt(): Promise<void>;
  setEffort(effort: Effort): void;
  setModel?(model: string): void;
  /** graceful: end the input and let the backend finish; now: end the process at once. */
  close(how: 'graceful' | 'now'): void;
  contextUsage?(): Promise<{ used: number; max: number }>;
}

export interface TurnResult {
  /** Ids of our messages this turn consumed; null when the backend cannot tell. [] = none (a self-started turn). */
  consumed: string[] | null;
  /** The turn's final text. */
  text: string;
  error?: string;
  /** How the backend classed an API error, e.g. 'rate_limit'. The runtime decides what a usage limit is. */
  apiError?: 'rate_limit' | (string & {});
  interrupted: boolean;
}

/** Neutral events: an adapter reports what happened; it never builds protocol Items or UI text. */
export interface SessionEvents {
  sessionStarted(id: string): void;
  /** A turn began (Claude: system/init or the first stream event). */
  turnStarted(): void;
  /** A final text block. `isError` when the backend marks it as an error message. */
  text(final: string, isError?: boolean): void;
  thinking(text: string): void;
  draft(d: { kind: 'text' | 'thinking'; append: string } | null): void;
  toolStarted(t: { id: string; name: string; input: unknown }): void;
  toolFinished(t: { id: string; result: string; isError: boolean; images?: ImagePart[] }): void;
  turnEnded(r: TurnResult): void;
  /** resetsAt in seconds since the epoch, as the backends report it. */
  rateLimit(n: RateLimitNotice): void;
  /** The full set of running background tasks (replace semantics). */
  background(activeIds: string[]): void;
  usage(u: Partial<AgentUsage>): void;
  /** The process ended without being asked to, or a start failed. */
  exited(r: { failure?: string; sessionMissing?: boolean }): void;
  askPermission(ask: PermissionAsk): Promise<PermissionAnswer>;
  /** Optional: earlier context was summarized. */
  compacted?(): void;
  /** Optional: a backend-specific state worth showing, e.g. compacting. */
  activity?(text: string | undefined): void;
}

export interface PermissionAsk {
  kind: 'command' | 'file' | 'tool' | 'question';
  toolName: string;
  input: unknown;
  title?: string;
  description?: string;
  canAlways: boolean;
  questions?: Question[];
  signal: AbortSignal;
}

export interface PermissionAnswer {
  decision: 'allow' | 'always' | 'deny';
  answers?: Record<string, string>;
  message?: string;
}

export interface Backend {
  readonly id: BackendId;
  readonly label: string;
  readonly caps: BackendCaps;
  detect(): Promise<BackendInfo>;
  models(): Promise<ModelInfo[]>;
  /** Must not throw for an ordinary failure: report events.exited({ failure }) instead. */
  open(spec: SessionSpec, events: SessionEvents): Session;
}
