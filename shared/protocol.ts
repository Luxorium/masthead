// Types shared by the server and the browser. Nothing in here may import Node or DOM APIs.

export const VERSION = '0.1.1';

/** The four levels of the team. `lead` is the agent the person talks to. */
export type Tier = 'lead' | 'opus' | 'sonnet' | 'haiku';
export const TIERS: readonly Tier[] = ['lead', 'opus', 'sonnet', 'haiku'];

/** Which tier an agent of a given tier may start. Haiku starts nothing. */
export const CHILD_TIER: Record<Tier, Tier | null> = {
  lead: 'opus',
  opus: 'sonnet',
  sonnet: 'haiku',
  haiku: null,
};

export const TIER_LABEL: Record<Tier, string> = {
  lead: 'Fable 5.2',
  opus: 'Opus 5.5',
  sonnet: 'Sonnet 5.5',
  haiku: 'Haiku 5.5',
};

/** Masthead deliberately offers no `max` level. */
/** A readable name for a model id: "claude-opus-5-5" becomes "Opus 5.5". Unknown ids are shown as they are. */
export function modelLabel(model: string): string {
  const m = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?![\d])/.exec(model);
  if (!m) return model;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/**
 * Agents are named in the order they start, from the radio spelling alphabet. The lead is always
 * the first. The familiar English spellings are used so the names are easy to type.
 */
export const AGENT_NAMES: readonly string[] = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike',
  'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu',
];

/** The name of the nth agent in a conversation (0 is the lead): alpha … zulu, then alpha-2 … */
export function agentName(n: number): string {
  const round = Math.floor(n / AGENT_NAMES.length);
  const base = AGENT_NAMES[n % AGENT_NAMES.length]!;
  return round === 0 ? base : `${base}-${round + 1}`;
}

/** How a name is shown to people: "bravo" is written "Bravo". */
export function displayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh'];
export const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra' };

export function effortRank(e: Effort): number {
  return EFFORTS.indexOf(e);
}

/** The lower of two effort levels. */
export function capEffort(wanted: Effort, ceiling: Effort): Effort {
  return effortRank(wanted) <= effortRank(ceiling) ? wanted : ceiling;
}

export interface TierSettings {
  /** Model id passed to Claude Code. */
  model: string;
  /**
   * With automatic effort on, the highest level an agent of this tier may reach (it starts at low).
   * With it off, the level every agent of this tier runs at.
   */
  effort: Effort;
  /** How many agents of this tier may be running at once, across the whole app. Ignored for `lead`. */
  max: number;
}

/** `inherit` leaves the choice to the person's own Claude Code settings. */
export type PermissionChoice = 'inherit' | 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';
export const PERMISSION_CHOICES: readonly PermissionChoice[] = [
  'inherit',
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
];

export interface Settings {
  tiers: Record<Tier, TierSettings>;
  permissionMode: PermissionChoice;
  /**
   * Agents start at low effort and raise it only when the work needs it: the lead by itself, the
   * others with the approval of the agent that started them.
   */
  autoEffort: boolean;
  /** Sonnet and Haiku agents skip the person's external MCP servers, which keeps their context small. */
  leanSubagents: boolean;
  /** Opus agents skip the person's external MCP servers too. */
  leanOpus: boolean;
  /** Reports from agents are shown folded shut in a transcript until the person opens them. */
  collapseReports: boolean;
  /** Folder a new conversation starts in. */
  defaultCwd: string;
}

export const MAX_PER_TIER = 12;

export type AgentStatus =
  | 'queued' // waiting for a free slot in its tier
  | 'running' // a turn is in progress
  | 'waiting' // its turn ended and it is waiting for agents it started
  | 'idle' // lead only: nothing in progress
  | 'done'
  | 'failed'
  | 'stopped';

export const LIVE_STATUSES: readonly AgentStatus[] = ['queued', 'running', 'waiting'];

export interface AgentUsage {
  /** Tokens in the agent's context window at its latest request. */
  context: number;
  contextMax: number;
  /** Output tokens produced so far. */
  output: number;
  costUsd: number;
  turns: number;
}

export interface AgentInfo {
  id: string;
  convId: string;
  name: string;
  tier: Tier;
  parentId: string | null;
  /** A few words on its job, given by whoever started it. Empty for the lead. */
  title: string;
  /** The task it was given (first part). */
  task: string;
  status: AgentStatus;
  model: string;
  effort: Effort;
  createdAt: number;
  endedAt?: number;
  usage: AgentUsage;
  /** One line on what it is doing right now, e.g. the tool it is running. */
  activity?: string;
  error?: string;
  /** The person asked for this agent to be shut down safely and it has not ended yet. */
  closing?: boolean;
}

interface ItemBase {
  id: string;
  ts: number;
}

/** One entry in an agent's transcript as the app shows it. */
export type Item =
  | (ItemBase & { kind: 'user'; text: string; images?: number })
  | (ItemBase & { kind: 'text'; text: string })
  | (ItemBase & { kind: 'thinking'; text: string })
  | (ItemBase & {
      kind: 'tool';
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      done: boolean;
    })
  | (ItemBase & {
      kind: 'inbound';
      /** task: what it was started with. report: an agent it started finished. message: a note from another agent. */
      via: 'task' | 'report' | 'message';
      from: string;
      text: string;
      status?: AgentStatus;
    })
  | (ItemBase & { kind: 'notice'; level: 'info' | 'error'; text: string });

/** An item before the transcript gives it an id and a time. */
export type NewItem = Item extends infer T ? (T extends Item ? Omit<T, 'id' | 'ts'> & { id?: string } : never) : never;

export interface Draft {
  kind: 'text' | 'thinking';
  text: string;
}

export interface ConversationMeta {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  leadId: string;
  /** True while any agent in it is working. Filled in when the list is sent; not stored. */
  busy?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}
export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface PermissionRequest {
  id: string;
  convId: string;
  agentId: string;
  agentName: string;
  kind: 'permission' | 'question';
  toolName: string;
  title?: string;
  description?: string;
  input: unknown;
  /** True when Claude Code offered rules that would stop it asking again. */
  canAlways: boolean;
  questions?: Question[];
  ts: number;
}

export interface ImageAttachment {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Base64 without the data: prefix. */
  data: string;
}

export interface RateLimitNotice {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  type?: string;
  utilization?: number;
  resetsAt?: number;
}

export interface AppState {
  version: string;
  settings: Settings;
  conversations: ConversationMeta[];
  claude: { path: string | null; version: string | null; error?: string };
  home: string;
  /** Every approval request and question still open, in any conversation. */
  pending: PermissionRequest[];
  /** The latest usage notice of each limit type Claude Code has reported since Masthead started. */
  usage: RateLimitNotice[];
}

// ---- browser -> server ----
export type ClientMsg =
  | { t: 'hello' }
  | { t: 'open'; convId: string }
  | { t: 'items'; convId: string; agentId: string }
  | {
      t: 'send';
      /** null starts a new conversation. */
      convId: string | null;
      cwd?: string;
      text: string;
      images?: ImageAttachment[];
      /** Send to this agent instead of the lead. */
      agentId?: string;
      /** Echoed back in `created`, or in `error` if the message is refused, so the browser can match its request. */
      ref?: string;
    }
  | { t: 'interrupt'; convId: string }
  | { t: 'stop_agent'; convId: string; agentId: string }
  /** Ask the agent that started this one to have it finish safely. `stop_agent` is the forceful one. */
  | { t: 'close_agent'; convId: string; agentId: string }
  | { t: 'stop_all'; convId: string }
  | {
      t: 'permission';
      requestId: string;
      decision: 'allow' | 'always' | 'deny';
      /** For questions: question text -> chosen answer. */
      answers?: Record<string, string>;
      message?: string;
    }
  | { t: 'settings'; settings: Settings }
  | { t: 'rename'; convId: string; title: string }
  | { t: 'delete'; convId: string }
  | { t: 'dirs'; path: string };

// ---- server -> browser ----
export type ServerMsg =
  | { t: 'state'; state: AppState }
  | { t: 'conversations'; conversations: ConversationMeta[] }
  | { t: 'conversation'; conv: ConversationMeta; agents: AgentInfo[]; pending: PermissionRequest[] }
  | { t: 'created'; convId: string; ref?: string }
  | { t: 'deleted'; convId: string }
  | { t: 'items'; convId: string; agentId: string; items: Item[]; draft: Draft | null }
  | { t: 'agent'; agent: AgentInfo }
  | { t: 'item'; convId: string; agentId: string; item: Item }
  | { t: 'draft'; convId: string; agentId: string; draft: Draft | null }
  | { t: 'permission_request'; request: PermissionRequest }
  | { t: 'permission_resolved'; requestId: string }
  | { t: 'settings'; settings: Settings }
  | { t: 'rate_limit'; notice: RateLimitNotice }
  | { t: 'dirs'; path: string; parent: string | null; entries: string[]; error?: string }
  | { t: 'error'; message: string; /** The `ref` of the refused `send`, if it had one. */ ref?: string };
