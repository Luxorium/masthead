import { randomUUID } from 'node:crypto';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import {
  capEffort,
  findTier,
  type AgentInfo,
  type AgentStatus,
  type Draft,
  type Effort,
  type ImageAttachment,
  type Item,
  type NewItem,
  type RateLimitNotice,
  type Settings,
} from '../../shared/protocol.js';
import { ClaudeBackend } from '../backends/claude/session.js';
import type { Backend, Content, PermissionAnswer, PermissionAsk, Session, SessionEvents, ToolDef, TurnResult, UsageUpdate } from '../backends/types.js';
import { toolLine } from '../../shared/toolline.js';
import { systemAppend } from '../core/prompts.js';
import { SlotCancelled, type Scheduler } from '../core/scheduler.js';

export type { Content } from '../backends/types.js';

/** What an agent needs from the conversation that owns it. */
export interface AgentHost {
  readonly cwd: string;
  readonly scheduler: Scheduler;
  settings(): Settings;
  claudePath(): string | null;
  parentName(agent: Agent): string | null;
  /** The team tools for this agent, bound to it. */
  tools(agent: Agent): ToolDef[];
  agentChanged(agent: Agent): void;
  itemChanged(agent: Agent, item: Item): void;
  draftChanged(agent: Agent, draft: Draft | null): void;
  rateLimit(notice: RateLimitNotice): void;
  askPermission(agent: Agent, ask: PermissionAsk): Promise<PermissionAnswer>;
  /** A turn finished and no further input is queued for the agent. */
  turnEnded(agent: Agent, outcome: TurnOutcome): void;
  /** The backend process went away without being asked to. */
  processLost(agent: Agent, message: string, usageLimit?: UsageLimit): void;
  /**
   * The agent's background commands have all ended, its last turn is over and the backend did not
   * start a new turn within a short grace time. A host that kept the agent waiting for that work
   * should now end it as usual.
   */
  backgroundIdle?(agent: Agent): void;
  /** Stores an image from a tool result; optional until the blob store is wired. */
  storeImage?(agent: Agent, data: string, mediaType: string): { ref: unknown } | { error: string };
  /** The backend to run this agent on. Undefined: the agent fails with a neutral not-found error (tests use `query`). */
  backend?(agent: Agent): Backend | undefined;
  /** Starts a Claude Code session in the default backend. Only tests set this. */
  query?: typeof query;
}

/** The usage limit stopped the agent. `resetsAt` is when it lifts, in ms since the epoch, if known. */
export interface UsageLimit {
  resetsAt?: number;
  /** Background commands were running and were stopped with the process. */
  backgroundStopped?: true;
}

export interface TurnOutcome {
  /** What the agent said since it last took up work: the final text of every turn in that run, oldest first. */
  text: string;
  error?: string;
  interrupted: boolean;
  /**
   * Set when the turn failed because the usage limit was reached. The messages it never answered are
   * kept by the agent and sent again, first, with the next deliver().
   */
  usageLimit?: UsageLimit;
}

/** A message the runtime sent or will send: its id comes back in a turn's consumed ids. */
interface Msg {
  id: string;
  content: Content;
}

const TOOL_RESULT_LIMIT = 12_000;
const DRAFT_INTERVAL_MS = 70;
/** A run's outcome keeps at most this many turn texts and this many characters, newest first. */
const RUN_TEXT_TURNS = 8;
const RUN_TEXT_CHARS = 60_000;
/**
 * How long to wait, after the last background command ends, for the turn the backend starts by
 * itself to tell the agent about it. In a real run (Claude Code 2.1.331) system/init followed the
 * empty background_tasks_changed within 0.1 s.
 */
export const BACKGROUND_GRACE_MS = 3_000;

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters not shown)`;
}

/** One line describing a tool call, for the team list. */
export function describeTool(name: string, input: unknown): string {
  const line = toolLine(name, input, true);
  const text = line.target ? `${line.verb} ${line.target}` : line.verb;
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

/**
 * One member of the team: the runtime around one backend session (backends/types.ts), and the app's
 * view of it. Backend-neutral: everything specific to Claude Code is in backends/claude/.
 *
 * The session is long-lived and fed messages while the agent works. Each message carries an id; a
 * turn's result names the ids it consumed, and the agent counts as finished with its turn only once
 * nothing it was sent is still unanswered. A finished or stopped agent has no session; sending to it
 * opens a new one that resumes the same backend session.
 */
export class Agent {
  sessionId: string | null;
  /** Whether it still owes its parent a report when it next finishes. */
  owesReport: boolean;
  /** What it said in its most recent run of turns (see `runTexts`). */
  lastText = '';

  private session: Session | null = null;
  private starting = false;
  /** Messages accepted before a session exists. */
  private backlog: Msg[] = [];
  /** Ids of messages sent to the session that no finished turn has consumed yet. */
  private unanswered = new Set<string>();
  /** The first message of a brand-new session; kept until the session exists. */
  private seed: Content | null;
  private closing = false;
  /** Settles when the current process has fully exited; a resume waits for it. */
  private exited: Promise<void> | null = null;
  private costBefore = 0;
  private openTools = new Map<string, Item & { kind: 'tool' }>();
  private draft: Draft | null = null;
  private draftTimer: NodeJS.Timeout | null = null;
  /**
   * Final texts of the turns that ended while more input was still unanswered. A message that lands
   * as a turn ends makes Claude Code run one more turn; its text (often only "Noted") must not
   * replace the work of the turn before it. So the outcome of a run is every turn's final text since
   * the agent last took up work, oldest first, and this list empties when the run's outcome is sent.
   */
  private runTexts: string[] = [];
  /**
   * Bumped by end() and dispose(). A start that was waiting for a slot or for the old process to exit
   * checks it, so an agent stopped meanwhile is never launched (`closing` cannot tell: it stays true
   * for a finished agent that is legitimately being resumed).
   */
  private generation = 0;
  /** Everything put into the current process's input, so it can be sent again to a fresh session. */
  private sent: Msg[] = [];
  /** The session the current process was asked to resume, if any. */
  private resumedFrom: string | null = null;
  /** Whether a fresh session was already tried after a missing one; there is never a second try. */
  private freshRetried = false;
  /**
   * Background commands (and other non-ambient tasks) the current process reports as running, from
   * its latest system/background_tasks_changed. That message carries the full set each time; the
   * set is per process, so it empties whenever a process starts or ends.
   */
  private background = new Set<string>();
  private idleTimer: NodeJS.Timeout | null = null;
  /** Between the first sign of a turn (init, stream, assistant) and its result. */
  private inTurn = false;
  /** The autoEffort setting the current process's tools were built with. */
  private launchedAutoEffort: boolean | null = null;
  /** Settings changed in a way the running process cannot take; relaunch it before its next turn. */
  private stale = false;
  /** The latest rate-limit notice of each window this process reported. */
  private limits = new Map<string, RateLimitNotice>();
  /**
   * Messages a usage-limit turn or loss never answered, kept as content so they do not count as
   * busy, and sent again (under new ids) before the next message. end() and dispose() drop them.
   */
  private held: Content[] = [];
  /** This process hit the usage limit; its later results only repeat that and are not reported. */
  private limited = false;
  /** The usage limit this process last reported. */
  private lastLimit: UsageLimit | null = null;
  /** Whether older turn texts of the current run were dropped (see addRunText). */
  private runTextsCut = false;

  constructor(
    readonly info: AgentInfo,
    private host: AgentHost,
    opts: { sessionId?: string | null; owesReport?: boolean; seed?: Content | null } = {},
  ) {
    this.sessionId = opts.sessionId ?? null;
    this.owesReport = opts.owesReport ?? false;
    this.seed = opts.seed ?? null;
    this.costBefore = info.usage.costUsd;
  }

  get id(): string {
    return this.info.id;
  }
  get name(): string {
    return this.info.name;
  }
  get tier() {
    return this.info.tier;
  }
  /** The agent nobody started (with team profiles its tier id is not always 'lead'). */
  get isLead(): boolean {
    return this.info.parentId === null;
  }
  get status(): AgentStatus {
    return this.info.status;
  }
  get live(): boolean {
    return this.info.status === 'queued' || this.info.status === 'running' || this.info.status === 'waiting';
  }
  get hasProcess(): boolean {
    return this.session !== null;
  }
  /** The task of an agent whose session has not started yet. */
  get pendingSeed(): string | null {
    return !this.sessionId && typeof this.seed === 'string' ? this.seed : null;
  }
  /** True while Claude Code runs commands it put in the background for this agent. */
  get hasBackgroundWork(): boolean {
    return this.background.size > 0;
  }
  /** True while something it was sent has not been answered by a finished turn. */
  get busy(): boolean {
    return this.unanswered.size > 0 || this.starting;
  }

  setStatus(status: AgentStatus, error?: string): void {
    const changed = this.info.status !== status || this.info.error !== error;
    this.info.status = status;
    this.info.error = error;
    if (status !== 'running') this.info.activity = undefined;
    if (status === 'done' || status === 'failed' || status === 'stopped') this.info.endedAt = Date.now();
    else this.info.endedAt = undefined;
    if (changed) this.host.agentChanged(this);
  }

  addItem(item: NewItem): Item {
    const full = { id: item.id ?? randomUUID(), ts: Date.now(), ...item } as Item;
    this.host.itemChanged(this, full);
    return full;
  }

  /** Starts a new agent on its task. */
  start(): void {
    this.ensureProcess();
  }

  /** Sends a message into the session, starting or resuming it if needed. */
  deliver(content: Content): void {
    this.limited = false;
    const between = this.unanswered.size === 0 && !this.inTurn && !this.hasBackgroundWork;
    // Held messages go first. They exist only when the process that got them is gone (see `held`).
    const msgs = [...this.held.splice(0).map((c) => this.userMessage(c)), this.userMessage(content)];
    if (this.stale && this.session && !this.closing && between) {
      // Between turns: let the old process exit and resume the same session with the new settings.
      // ensureProcess keeps the slot (the scheduler sees the same agent) and waits for the exit.
      this.stale = false;
      this.closing = true;
      this.session.close('graceful');
      this.backlog.push(...msgs);
      this.ensureProcess();
      return;
    }
    if (this.session && !this.closing) {
      // Every message goes the same way, so none can sit in the backlog of a live process.
      for (const m of msgs) {
        this.session.send(m.id, m.content);
        this.sent.push(m);
      }
      if (this.info.status !== 'running') this.setStatus('running');
    } else {
      this.backlog.push(...msgs);
      this.ensureProcess();
    }
  }

  /** Forgets the messages kept from a usage-limit stop, as when the person stops the agent. */
  dropHeld(): void {
    this.held = [];
  }

  static imageContent(text: string, images: ImageAttachment[] | undefined): Content {
    if (!images?.length) return text;
    return [...images.map((img) => ({ type: 'image' as const, mediaType: img.mediaType, data: img.data })), { type: 'text' as const, text }];
  }

  private userMessage(content: Content): Msg {
    const id = randomUUID();
    this.unanswered.add(id);
    return { id, content };
  }

  private ensureProcess(): void {
    if (this.starting || (this.session && !this.closing)) return;
    this.starting = true;
    const generation = this.generation;
    let granted = false;
    const owner = this.info.parentId ?? this.info.convId;
    const slot = this.host.scheduler.acquire(this.tier, this.id, owner).then(() => {
      granted = true;
    });
    // Only show "queued" when the slot is not free right away.
    queueMicrotask(() => {
      if (!granted && this.starting && generation === this.generation) this.setStatus('queued');
    });
    slot
      .then(() => this.exited ?? undefined)
      .then(
      () => {
        if (generation !== this.generation) {
          // Ended while waiting: the slot was granted (often in the same pass that freed it) after
          // end() had nothing left to cancel. Give it back unless a newer start now holds it.
          if (!this.starting && !this.session) this.host.scheduler.release(this.tier, this.id);
          return;
        }
        try {
          this.launch();
        } catch (e) {
          this.starting = false;
          this.session = null;
          this.unanswered.clear();
          this.host.processLost(this, (e as Error)?.message || String(e));
        }
      },
      (e) => {
        if (generation !== this.generation) return;
        this.starting = false;
        if (!(e instanceof SlotCancelled)) this.host.processLost(this, String(e));
      },
      );
  }

  private backendFor(): Backend | null {
    const chosen = this.host.backend?.(this);
    if (chosen) return chosen;
    // Tests drive Claude Code's adapter with a stand-in for the SDK's query().
    if (this.host.query) return new ClaudeBackend({ path: this.host.claudePath(), query: this.host.query });
    return null;
  }

  private launch(): void {
    const backend = this.backendFor();
    if (!backend) {
      this.starting = false;
      this.unanswered.clear();
      this.backlog = [];
      this.host.scheduler.release(this.tier, this.id);
      this.host.processLost(this, 'No agent backend is available: the program this tier runs on was not found on this machine.');
      return;
    }
    const settings = this.host.settings();
    // The lead follows the model in the settings; other agents keep the one they were started with.
    const tier = this.tierSettings(settings);
    if (this.isLead) this.info.model = tier.model;
    const ceiling = tier.effort;
    this.info.effort = settings.autoEffort ? capEffort(this.info.effort, ceiling) : ceiling;
    const first = !this.sessionId && this.seed !== null ? [this.userMessage(this.seed)] : [];
    this.sent = [...first, ...this.backlog];
    this.backlog = [];

    // Lean agents load only Masthead's own tools, not the person's connectors. Never the lead.
    const lean = !this.isLead && tier.lean;
    this.resumedFrom = this.sessionId;
    this.launchedAutoEffort = settings.autoEffort;
    this.limits.clear();
    this.limited = false;
    this.lastLimit = null;
    this.stale = false;
    this.inTurn = false;
    this.clearBackground();
    this.closing = false;

    let session: Session;
    try {
      session = backend.open(
        {
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          model: this.info.model,
          effort: this.info.effort,
          cwd: this.host.cwd,
          env: {},
          instructions: systemAppend({ tier: this.tier, name: this.name, parentName: this.host.parentName(this), settings, effort: this.info.effort, caps: { efforts: backend.caps.efforts, background: backend.caps.background, midTurnDelivery: backend.caps.midTurnDelivery } }),
          tools: this.toolsForSession(),
          canAskPerson: this.isLead,
          permissionMode: settings.permissionMode,
          lean,
        },
        this.events(),
      );
    } catch (e) {
      this.starting = false;
      this.unanswered.clear();
      this.host.scheduler.release(this.tier, this.id);
      this.host.processLost(this, (e as Error).message);
      return;
    }
    this.session = session;
    for (const m of this.sent) session.send(m.id, m.content);
    this.starting = false;
    this.setStatus('running');
    const exited = session.ended.then(() => {
      // A session we closed ends here; one that died has already been cleaned up in `exited`.
      if (this.session === session) this.sessionGone();
    });
    this.exited = exited.finally(() => {
      if (this.exited === exited) this.exited = null;
    });
  }

  /** The neutral events of this agent's sessions. */
  private events(): SessionEvents {
    return {
      sessionStarted: (id) => this.onSessionStarted(id),
      turnStarted: () => this.turnStarted(),
      text: (final, isError) => this.addItem(isError ? { kind: 'notice', level: 'error', text: final } : { kind: 'text', text: final }),
      thinking: (text) => this.addItem({ kind: 'thinking', text }),
      draft: (d) => this.onDraft(d),
      toolStarted: (t) => {
        // Backends name Masthead's team tools differently (Claude: mcp__masthead__x; Codex: x); the page
        // and describeTool know the first form, so a bare team tool name is shown in it.
        const name = this.teamTools.has(t.name) ? `mcp__masthead__${t.name}` : t.name;
        const item = this.addItem({ id: `tool-${t.id}`, kind: 'tool', name, input: t.input, done: false }) as Item & { kind: 'tool' };
        this.openTools.set(t.id, item);
        this.setActivity(describeTool(name, t.input));
      },
      toolFinished: (t) => {
        const item = this.openTools.get(t.id);
        if (!item) return;
        this.openTools.delete(t.id);
        let result = t.result;
        const refs: unknown[] = [];
        if (t.images?.length && this.host.storeImage) {
          for (const img of t.images) {
            const r = this.host.storeImage(this, img.data, img.mediaType);
            if ('ref' in r) refs.push(r.ref);
            else result = result.replace('[image]', `[image] (not stored: ${r.error})`);
          }
        }
        this.host.itemChanged(this, { ...item, result: clip(result, TOOL_RESULT_LIMIT), isError: t.isError, done: true, ...(refs.length ? { images: refs } : {}) } as Item);
        // The tool is finished; do not go on showing it as what the agent is doing.
        if (this.openTools.size === 0) this.setActivity(undefined);
      },
      turnEnded: (r) => this.handleResult(r),
      rateLimit: (n) => {
        this.host.rateLimit(n);
        this.limits.set(n.type ?? '', n);
      },
      background: (ids) => this.backgroundChanged(ids),
      usage: (u) => this.onUsage(u),
      exited: (r) => this.onExited(r),
      askPermission: (ask) => this.host.askPermission(this, ask),
      compacted: () => this.addItem({ kind: 'notice', level: 'info', text: 'Earlier context was summarized to free up space.' }),
      activity: (text) => this.setActivity(text),
    };
  }

  /** Names of the team tools given to the current session. */
  private teamTools = new Set<string>();
  private toolsForSession(): ToolDef[] {
    const tools = this.host.tools(this);
    this.teamTools = new Set(tools.map((t) => t.name));
    return tools;
  }

  private onSessionStarted(id: string): void {
    this.freshRetried = false;
    if (this.sessionId !== id) {
      this.sessionId = id;
      this.seed = null;
      this.host.agentChanged(this);
    }
  }

  /** The agent's tier in the settings' profiles, or the 0.1.x `tiers` view when profiles do not list it. */
  private tierSettings(settings: Settings): { model: string; effort: Effort; lean: boolean } {
    const t = findTier(settings, this.tier);
    if (t) return t;
    const old = settings.tiers[this.tier as keyof Settings['tiers']];
    // A tier no profile lists any more (its profile was deleted): keep what the agent has.
    if (!old) return { model: this.info.model, effort: this.info.effort, lean: false };
    const lean = (settings.leanSubagents && (this.tier === 'sonnet' || this.tier === 'haiku')) || (settings.leanOpus && this.tier === 'opus');
    return { model: old.model, effort: old.effort, lean };
  }

  private onDraft(d: { kind: 'text' | 'thinking'; append: string } | null): void {
    if (d === null) this.setDraft(null, true);
    else if (d.append === '') {
      // A new text or thinking block.
      this.setActivity(undefined);
      this.setDraft({ kind: d.kind, text: '' }, true);
    } else if (this.draft && this.draft.kind === d.kind) this.setDraft({ kind: d.kind, text: this.draft.text + d.append }, false);
    else this.setDraft({ kind: d.kind, text: d.append }, true);
  }

  private onUsage(u: UsageUpdate): void {
    if (typeof u.output === 'number') this.info.usage.output += u.output;
    if (typeof u.context === 'number') this.info.usage.context = u.context;
    if (typeof u.costUsd === 'number') this.info.usage.costUsd = this.costBefore + u.costUsd;
    this.host.agentChanged(this);
  }

  /** Clean-up when the current session has ended, whichever way. */
  private sessionGone(): void {
    this.session = null;
    this.costBefore = this.info.usage.costUsd;
    this.setDraft(null, true);
    this.closeOpenTools();
    this.inTurn = false;
    this.clearBackground();
  }

  /** The session ended without being asked to. */
  private onExited(r: { failure?: string; sessionMissing?: boolean; apiError?: string }): void {
    const hadBackground = this.hasBackgroundWork;
    this.sessionGone();
    if (this.closing) return; // we asked it to end
    if (r.sessionMissing && this.resumedFrom && !this.freshRetried) {
      this.startFresh();
      return;
    }
    const failure = r.failure ?? null;
    const usageLimit = this.usageLimitFor(failure ?? '', r.apiError);
    if (usageLimit && hadBackground) usageLimit.backgroundStopped = true;
    if (usageLimit && !this.limited) this.holdUnanswered();
    this.limited = false;
    this.unanswered.clear();
    this.clearRunTexts();
    this.host.processLost(this, failure ?? 'The agent process ended unexpectedly.', usageLimit);
  }

  /** Starts a new session in place of a missing one and sends it what the old one never answered. Tried once. */
  private startFresh(): void {
    this.freshRetried = true;
    const pending = this.sent.filter((m) => this.unanswered.has(m.id));
    this.sessionId = null;
    this.seed = null;
    this.host.agentChanged(this);
    this.addItem({ kind: 'notice', level: 'info', text: 'The earlier session could not be found, so its context is lost. This agent starts fresh.' });
    const note = this.userMessage('(Masthead: your earlier session could not be found, so its context is lost and you are starting fresh. Ask for anything you need to know again.)');
    this.backlog = [note, ...pending, ...this.backlog];
    try {
      this.launch();
    } catch (e) {
      this.session = null;
      this.unanswered.clear();
      this.clearRunTexts();
      this.host.processLost(this, (e as Error)?.message || String(e));
    }
  }

  private handleResult(r: TurnResult): void {
    // The backend names the ids a turn consumed: [] for a turn it started by itself; null when it
    // cannot tell (an older Claude Code), and then everything counts as answered so the agent can
    // never stay busy for ever. A process that dies clears everything anyway.
    if (r.consumed) for (const id of r.consumed) this.unanswered.delete(id);
    else this.unanswered.clear();

    this.inTurn = false;
    this.info.usage.turns += 1;
    this.closeOpenTools();
    this.setDraft(null, true);

    const error = r.error;
    const wasInterrupted = r.interrupted;
    const usageLimit = error && !wasInterrupted ? this.usageLimitFor(error, r.apiError) : undefined;
    if (this.limited) {
      // A result that was already on its way when the process was closed at the limit. Its messages
      // are held already; report it the same way (the conversation treats repeats as one pause).
      this.unanswered.clear();
      this.host.agentChanged(this);
      this.host.turnEnded(this, { text: this.runText(), error, interrupted: false, usageLimit: usageLimit ?? this.lastLimit ?? {} });
      return;
    }
    this.addRunText(r.text);
    const text = this.runText();
    this.lastText = text || this.lastText;
    this.host.agentChanged(this);

    if (usageLimit) {
      // Report at once even if more input is queued, and close the process: then nothing stays queued
      // inside it and no turn can start by itself during the pause. Messages no turn consumed are
      // held and sent again on the next deliver(), which resumes the session. The message this turn
      // consumed is not re-sent: it is already in the session, with the error.
      // All of this happens before turnEnded: anything the host delivers from inside it must go to
      // the backlog and a new process, never into this one, which is being closed.
      this.holdUnanswered();
      this.unanswered.clear();
      this.limited = true;
      if (this.hasBackgroundWork) usageLimit.backgroundStopped = true;
      this.lastLimit = usageLimit;
      if (this.session && !this.closing) {
        this.closing = true;
        this.session.close('now');
      }
      this.host.turnEnded(this, { text, error, interrupted: false, usageLimit });
      return;
    }
    if (this.unanswered.size > 0) {
      // Another turn follows for input that arrived meanwhile.
      if (error) this.addItem({ kind: 'notice', level: 'error', text: error });
      return;
    }
    // With background work still running the run is not over: Claude Code starts a turn by itself
    // when it ends, and that turn's outcome carries this turn's text too.
    if (!this.hasBackgroundWork) this.clearRunTexts();
    // Read the real context size while the process is still up (the host may end it right after).
    void this.refreshContext();
    this.host.turnEnded(this, { text, error, interrupted: wasInterrupted });
  }

  /**
   * Whether an error means the usage limit was reached. Conservative: the process must have had a
   * rate_limit_event with status 'rejected' as its latest, and the error must be marked as a rate
   * limit (the assistant message's `error` is 'rate_limit') or say so. A network or tool error has
   * no rejected event behind it, so it never counts.
   */
  private usageLimitFor(error: string, apiError: string | undefined): UsageLimit | undefined {
    const hit = [...this.limits.values()].find((n) => n.status === 'rejected');
    if (!hit) return undefined;
    // resetsAt arrives in seconds (seen: 1796144400).
    if (apiError === 'rate_limit' || /rate[ _]limit|usage limit|limit reached|hit your limit/i.test(error)) {
      return { resetsAt: typeof hit.resetsAt === 'number' ? hit.resetsAt * 1000 : undefined };
    }
    return undefined;
  }

  /** Moves the messages this process was sent and no turn consumed into `held`. */
  private holdUnanswered(): void {
    for (const m of this.sent) if (this.unanswered.has(m.id)) this.held.push(m.content);
  }

  /** Adds a turn's final text to the run, keeping at most RUN_TEXT_TURNS texts and RUN_TEXT_CHARS characters. */
  private addRunText(text: string): void {
    if (!text.trim() || this.runTexts[this.runTexts.length - 1] === text) return;
    this.runTexts.push(text);
    let total = this.runTexts.reduce((n, t) => n + t.length, 0);
    while (this.runTexts.length > 1 && (this.runTexts.length > RUN_TEXT_TURNS || total > RUN_TEXT_CHARS)) {
      total -= this.runTexts.shift()!.length;
      this.runTextsCut = true;
    }
  }

  private runText(): string {
    const text = this.runTexts.join('\n\n');
    return this.runTextsCut && text ? `(earlier text not shown)\n\n${text}` : text;
  }

  private clearRunTexts(): void {
    this.runTexts = [];
    this.runTextsCut = false;
  }

  private turnStarted(): void {
    // The backend also starts turns by itself, for instance when a background command finishes.
    // Not while the conversation has paused the agent at the usage limit: that state is its own.
    if ((this.info.status === 'idle' || this.info.status === 'waiting') && this.info.pausedUntil === undefined) this.setStatus('running');
    this.inTurn = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private backgroundChanged(ids: string[]): void {
    const had = this.background.size > 0;
    this.background = new Set(ids);
    const has = this.background.size > 0;
    if (had !== has) this.host.agentChanged(this);
    if (had && !has) this.checkIdleSoon();
  }

  private clearBackground(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.background.clear();
  }

  /**
   * After background work ends, Claude Code normally starts a turn by itself to report it, and that
   * turn's result ends the run. If no turn starts within the grace time, tell the host, so an agent
   * kept waiting for the work never waits for ever.
   */
  private checkIdleSoon(): void {
    if (this.idleTimer || this.hasBackgroundWork || !this.session || this.closing) return;
    const session = this.session;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.session !== session || this.closing || this.inTurn || this.busy || this.hasBackgroundWork) return;
      this.host.backgroundIdle?.(this);
    }, BACKGROUND_GRACE_MS);
    this.idleTimer.unref?.();
  }

  private setActivity(activity: string | undefined): void {
    if (this.info.activity === activity) return;
    this.info.activity = activity;
    this.host.agentChanged(this);
  }

  private setDraft(draft: Draft | null, now: boolean): void {
    if (draft === null && this.draft === null && !this.draftTimer) return;
    this.draft = draft;
    if (now) {
      if (this.draftTimer) clearTimeout(this.draftTimer);
      this.draftTimer = null;
      this.host.draftChanged(this, this.draft);
    } else if (!this.draftTimer) {
      this.draftTimer = setTimeout(() => {
        this.draftTimer = null;
        this.host.draftChanged(this, this.draft);
      }, DRAFT_INTERVAL_MS);
    }
  }

  currentDraft(): Draft | null {
    return this.draft;
  }

  private closeOpenTools(): void {
    for (const item of this.openTools.values()) this.host.itemChanged(this, { ...item, done: true });
    this.openTools.clear();
  }

  /** Stops the current turn but keeps the session, as the Stop button does for the lead. */
  async interrupt(): Promise<void> {
    if (!this.session || this.info.status !== 'running') return;
    await this.session.interrupt();
  }

  /**
   * Ends the agent's process and gives its slot back. `done` lets the session close cleanly;
   * `stopped` and `failed` end it at once.
   */
  end(status: 'done' | 'failed' | 'stopped', error?: string): void {
    this.host.scheduler.cancel(this.tier, this.id);
    this.generation++;
    this.starting = false;
    this.closing = true;
    this.backlog = [];
    this.unanswered.clear();
    this.clearRunTexts();
    this.dropHeld();
    this.limited = false;
    // A clean end lets Claude Code finish on its own; with background commands still running it might
    // wait for them, so then the process is closed at once.
    const kill = status !== 'done' || this.hasBackgroundWork;
    this.clearBackground();
    this.session?.close(kill ? 'now' : 'graceful');
    this.host.scheduler.release(this.tier, this.id);
    this.setStatus(status, error);
  }

  /** Ends the process, if there is one, without changing what the agent's status says. */
  dispose(): void {
    this.host.scheduler.cancel(this.tier, this.id);
    this.generation++;
    this.starting = false;
    this.closing = true;
    this.backlog = [];
    this.unanswered.clear();
    this.clearRunTexts();
    this.dropHeld();
    this.limited = false;
    this.clearBackground();
    this.session?.close('now');
    this.host.scheduler.release(this.tier, this.id);
  }

  /** Changes how hard the agent thinks from its next request on. */
  setEffort(level: Effort): void {
    if (this.info.effort === level) return;
    this.info.effort = level;
    this.host.agentChanged(this);
    const session = this.session;
    if (session) {
      Promise.resolve()
        .then(() => session.setEffort(level))
        .catch(() => {
          // It did not reach the session: relaunch it (same session) before the next turn.
          if (this.session === session) this.stale = true;
        });
    }
  }

  /**
   * Applies changed settings to a running process. Effort takes effect from the next request; the
   * lead's model changes through setModel. A change to automatic effort changes the agent's tools,
   * which are built at launch, so the process is relaunched (same session) before its next turn.
   * An agent without a process needs nothing: launch() reads the settings.
   */
  applySettings(settings: Settings): void {
    if (!this.session || this.closing) return;
    const tier = this.tierSettings(settings);
    const ceiling = tier.effort;
    const effort = settings.autoEffort ? capEffort(this.info.effort, ceiling) : ceiling;
    if (effort !== this.info.effort) this.setEffort(effort);
    if (this.isLead && tier.model !== this.info.model) {
      const session = this.session;
      this.info.model = tier.model;
      this.host.agentChanged(this);
      if (!session.setModel) this.stale = true;
      else {
        Promise.resolve()
          .then(() => session.setModel!(this.info.model))
          .catch(() => {
            if (this.session === session) this.stale = true;
          });
      }
    }
    if (this.launchedAutoEffort !== null && settings.autoEffort !== this.launchedAutoEffort) this.stale = true;
  }

  /** Reads the real size of the context window from Claude Code, when a process is up. */
  async refreshContext(): Promise<void> {
    const session = this.session;
    if (!session?.contextUsage) return;
    try {
      const u = await session.contextUsage();
      if (this.session !== session) return;
      this.info.usage.context = u.used;
      this.info.usage.contextMax = u.max;
      this.host.agentChanged(this);
    } catch {
      // not available; the estimate from the stream stays
    }
  }
}
