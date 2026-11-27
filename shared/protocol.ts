// Types shared by the server and the browser. Nothing in here may import Node or DOM APIs.

export const VERSION = '0.2.1-beta.1';

/** The four levels of the team. `lead` is the agent the person talks to. */
export type Tier = 'lead' | 'opus' | 'sonnet' | 'haiku';
export const TIERS: readonly Tier[] = ['lead', 'opus', 'sonnet', 'haiku'];

/**
 * A tier as data (0.2.0 team profiles). Ids are unique across all profiles: the built-in Claude profile
 * keeps `lead`/`opus`/`sonnet`/`haiku` (so 0.1.x conversations load unchanged); other profiles use
 * `<profileId>:<index>`. `Tier` above stays the Claude union as a compatibility shape for the page
 * until it reads profiles (web W7); then `Tier` becomes `TierId`.
 */
export type TierId = string;

/** Colour slots for tiers; the page owns the actual light and dark values. */
export const PALETTE = ['amber', 'violet', 'blue', 'teal', 'rose', 'green', 'slate', 'orange'] as const;
export type PaletteColour = (typeof PALETTE)[number];

export interface TierSpec {
  id: TierId;
  /** Shown to people and agents; made from the model id when not set. */
  label: string;
  backend: string;
  model: string;
  /** With automatic effort, the ceiling; without, the fixed level. */
  effort: Effort;
  /** Agents of this tier running at once, app-wide. Ignored for the first tier (the lead). */
  max: number;
  /** Skip the person's own MCP servers. */
  lean: boolean;
  colour: PaletteColour;
  /** Why agents of this tier cannot start (e.g. an agent program name that is not valid); kept as found. */
  unusable?: string;
}

export interface TeamProfile {
  id: string;
  label: string;
  /** One line for people on where it comes from or what it is for (at most 200 characters). */
  description?: string;
  builtIn: boolean;
  /** Index 0 is the lead; tier i starts tier i+1; the last starts nothing. 1 to MAX_TIERS tiers. */
  tiers: TierSpec[];
}

export const MAX_TIERS = 5;
export const CLAUDE_PROFILE = 'claude';

/** The profile a tier belongs to. */
export function profileOfTier(s: Pick<Settings, 'profiles'>, tier: TierId): TeamProfile | undefined {
  return s.profiles.find((p) => p.tiers.some((t) => t.id === tier));
}

export function findTier(s: Pick<Settings, 'profiles'>, tier: TierId): TierSpec | undefined {
  for (const p of s.profiles) for (const t of p.tiers) if (t.id === tier) return t;
  return undefined;
}

/** The tier an agent of `tier` may start, or null (the last tier, or an unknown one). */
export function childTierOf(s: Pick<Settings, 'profiles'>, tier: TierId): TierId | null {
  const p = profileOfTier(s, tier);
  if (!p) return null;
  const i = p.tiers.findIndex((t) => t.id === tier);
  return p.tiers[i + 1]?.id ?? null;
}

/** Whether `tier` is the first tier (the lead) of its profile. */
export function isLeadTier(s: Pick<Settings, 'profiles'>, tier: TierId): boolean {
  return profileOfTier(s, tier)?.tiers[0]?.id === tier;
}

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

function roman(n: number): string {
  const parts: Array<[number, string]> = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [value, letters] of parts) while (n >= value) (out += letters), (n -= value);
  return out;
}

/**
 * The name of the nth agent in a conversation (0 is the lead): alpha … zulu, then a second round with
 * a Roman numeral, alpha-ii … zulu-ii, then alpha-iii … People see these as "Alpha II".
 */
export function agentName(n: number): string {
  const round = Math.floor(n / AGENT_NAMES.length);
  const base = AGENT_NAMES[n % AGENT_NAMES.length]!;
  return round === 0 ? base : `${base}-${roman(round + 1)}`;
}

/** How a name is shown to people: "bravo" is written "Bravo", "alpha-ii" is written "Alpha II". */
export function displayName(name: string): string {
  const m = /^([a-z]+)-([ivxlcdm]+)$/.exec(name);
  const word = m ? m[1]! : name;
  const shown = word.charAt(0).toUpperCase() + word.slice(1);
  return m ? `${shown} ${m[2]!.toUpperCase()}` : shown;
}

/** Masthead deliberately offers no `max` level. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh'];

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
  /** Settings format: 2 since 0.2.0 (team profiles). Files without it are 0.1.x and are migrated. */
  version: 2;
  /** Team profiles; the built-in `claude` profile is always present. The source of truth for tiers. */
  profiles: TeamProfile[];
  /** The profile a new conversation uses unless the person picks another. */
  defaultProfile: string;
  /**
   * Compatibility view of the `claude` profile for the page until web W7 (and for patches the page
   * sends): kept equal to it by the server. Changing it changes the profile.
   */
  tiers: Record<Tier, TierSettings>;
  permissionMode: PermissionChoice;
  /**
   * Agents start at low effort and raise it only when the work needs it: the lead by itself, the
   * others with the approval of the agent that started them.
   */
  autoEffort: boolean;
  /** Compatibility view (claude profile): Sonnet and Haiku agents skip the person's external MCP servers. */
  leanSubagents: boolean;
  /** Compatibility view (claude profile): Opus agents skip the person's external MCP servers too. */
  leanOpus: boolean;
  /** Reports from agents are shown folded shut in a transcript until the person opens them. */
  collapseReports: boolean;
  /** Keep the computer from sleeping while any agent works. Applies at once. */
  keepAwake: boolean;
  /**
   * Tidy the team automatically: past about 15 finished helpers (or the lead's memory past about 70 %),
   * or when the person types /compact, the lead decides who stays, the rest are archived and everyone
   * who stays compacts its memory; the person is told afterwards. Off: the person confirms on a card.
   */
  autoCompact: boolean;
  /** The longest a sub-agent may stay live on one piece of work, in minutes. 0 means no limit. */
  maxRunMinutes: number;
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

export interface AgentUsage {
  /** Tokens in the agent's context window at its latest request. */
  context: number;
  contextMax: number;
  /** Output tokens produced so far. */
  output: number;
  costUsd: number;
  /**
   * costUsd is short: a session ended mid-turn (stopped, crashed, run-time limit), and the backend
   * reports cost only when a turn finishes, so that turn's cost was never received. Absent = complete.
   */
  costPartial?: boolean;
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
  /** The agent it asked a question of and is waiting to hear from, by name. */
  waitingFor?: string;
  /** Paused at a usage limit until about this time (ms since 1970); it carries on by itself then. */
  pausedUntil?: number;
  /** When its current state began (ms since 1970): set when status, activity, waitingFor or pausedUntil changes. */
  activitySince?: number;
  /** When it last produced output (an item, or streamed text), ms since 1970. */
  lastOutputAt?: number;
  /**
   * Archived by a team compaction (ms since 1970): a finished helper that left the team. It cannot be
   * woken; its chat stays readable (read_archive, the Archived helpers row); the person may restore it.
   */
  archived?: number;
}

interface ItemBase {
  id: string;
  ts: number;
}

/** One entry in an agent's transcript as the app shows it. */
export type Item =
  | (ItemBase & { kind: 'user'; text: string; /** 0.1.x: a count; 0.2.0: the stored images. */ images?: number | BlobRef[] })
  | (ItemBase & { kind: 'text'; text: string })
  | (ItemBase & { kind: 'thinking'; text: string })
  | (ItemBase & {
      kind: 'tool';
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      done: boolean;
      images?: BlobRef[];
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
  /** The team profile it runs on (0.2.0); missing in 0.1.x files, which means `claude`. */
  profileId?: string;
  /**
   * A copy of that profile's tiers, taken when the conversation starts and refreshed while the profile
   * exists, so the conversation keeps working if the profile is deleted or shrinks.
   */
  team?: TierSpec[];
  /** The lead has suggested compacting the team once; it does not suggest it again (autoCompact off). */
  compactSuggested?: boolean;
  /** The person's message (item id) the lead was sent again after a restart cut it off; never sent twice. */
  restartResent?: string;
  /** The lead was cut off mid-turn by a stop or crash; the next start asks it to carry on, once. */
  leadCut?: boolean;
  /** The person switched automatic tidying off for this conversation (autoCompact still applies elsewhere). */
  autoCompact?: false;
  /** When automatic tidying last fired: helpers finished so far (it waits for 10 more), and whether memory must drop first. */
  compactMark?: { finished: number; memoryArmed: boolean };
  /** A team compaction in progress or just ended (saved, so a restart carries on). */
  compact?: CompactState;
  /** True while any agent in it is working. Filled in when the list is sent; not stored. */
  busy?: boolean;
}

/** One helper the compaction keeps: named by the lead with why, or `forced` (still working, or above a kept one). */
export interface CompactKeep {
  name: string;
  why: string;
  forced?: boolean;
}

/**
 * A team compaction (see docs/plans/0.2.0/compact.md): `asked` (waiting for the lead's proposal) →
 * `proposed` (the person's card) → `archiving` → `compacting` (each kept agent compacts its memory)
 * → `done`, or `cancelled`.
 */
export interface CompactState {
  id: string;
  phase: 'asked' | 'proposed' | 'archiving' | 'compacting' | 'done' | 'cancelled';
  /** Started by Masthead (automatic tidying) or by the person's /compact; no card when automatic tidying is on. */
  auto: boolean;
  /** Why it started, for the lead and the summary ("the team has 16 finished helpers"). */
  reason?: string;
  /** The lead has had a turn since being asked; if it ends another without choosing, nothing is archived. */
  askedAnswered?: boolean;
  keep: CompactKeep[];
  /** Names of the helpers to archive (proposed) or archived (later phases). */
  archive: string[];
  note: string;
  /** Names of agents still to compact their memory. */
  pending: string[];
  /** Agents whose compaction failed or was skipped, with why. */
  failed: Array<{ name: string; why: string }>;
  startedAt: number;
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

/** An image stored on the server (per conversation, content-addressed). */
export interface BlobRef {
  blob: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  w: number;
  h: number;
  bytes: number;
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

/** A change to the settings: only the fields that changed. The server merges it over the current ones. */
export type SettingsPatch = Partial<Omit<Settings, 'tiers' | 'version'>> & { tiers?: Partial<Record<Tier, Partial<TierSettings>>> };

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
  /** Per socket: images load from `/blob/<convId>/<hash>?t=<blobToken>`. */
  blobToken?: string;
}

// ---- browser -> server ----
export type ClientMsg =
  | { t: 'hello' }
  | { t: 'open'; convId: string }
  | { t: 'items'; convId: string; agentId: string; /** Paging: without `limit` the whole transcript comes back. */ before?: number | null; limit?: number }
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
      /** Images already uploaded with POST /blob?conv=. */
      blobs?: BlobRef[];
      /** For a new conversation: the team profile to use (default: settings.defaultProfile). */
      profile?: string;
    }
  | { t: 'interrupt'; convId: string }
  | { t: 'stop_agent'; convId: string; agentId: string }
  | { t: 'stop_all'; convId: string }
  | {
      t: 'permission';
      requestId: string;
      decision: 'allow' | 'always' | 'deny';
      /** For questions: question text -> chosen answer. */
      answers?: Record<string, string>;
      message?: string;
    }
  | { t: 'settings'; settings: SettingsPatch }
  /** Put a built-in team profile back to its defaults (claude; codex from the installed CLI). */
  | { t: 'reset_profile'; id: string }
  /**
   * Delete a team profile. Refused with code `refused` and `inUse: { id, chats }` while conversations
   * use it, unless `force` (they then keep running on their copy of its tiers).
   */
  | { t: 'delete_profile'; id: string; force?: boolean }
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
  | { t: 'items'; convId: string; agentId: string; items: Item[]; draft: Draft | null; cursor?: number | null; more?: boolean }
  | { t: 'agent'; agent: AgentInfo }
  | { t: 'item'; convId: string; agentId: string; item: Item }
  | { t: 'draft'; convId: string; agentId: string; draft: Draft | null }
  | { t: 'permission_request'; request: PermissionRequest }
  | { t: 'permission_resolved'; requestId: string }
  | { t: 'settings'; settings: Settings }
  | { t: 'rate_limit'; notice: RateLimitNotice }
  | { t: 'dirs'; path: string; parent: string | null; entries: string[]; error?: string }
  | { t: 'error'; message: string; code?: 'too_large' | 'invalid' | 'not_found' | 'refused' | 'protocol'; /** The `ref` of the refused `send`, if it had one. */ ref?: string; /** A refused delete_profile: how many conversations use the profile. */ inUse?: { id: string; chats: number } };
