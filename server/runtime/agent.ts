import { randomUUID } from 'node:crypto';
import {
  query,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  capEffort,
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
import { agentEnv } from '../backends/claude/env.js';
import { toolLine } from '../../shared/toolline.js';
import { systemAppend } from '../core/prompts.js';
import { SlotCancelled, type Scheduler } from '../core/scheduler.js';

/** What an agent needs from the conversation that owns it. */
export interface AgentHost {
  readonly cwd: string;
  readonly scheduler: Scheduler;
  settings(): Settings;
  claudePath(): string | null;
  parentName(agent: Agent): string | null;
  tools(agent: Agent): McpSdkServerConfigWithInstance;
  agentChanged(agent: Agent): void;
  itemChanged(agent: Agent, item: Item): void;
  draftChanged(agent: Agent, draft: Draft | null): void;
  rateLimit(notice: RateLimitNotice): void;
  askPermission(agent: Agent, toolName: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]): Promise<PermissionResult>;
  /** A turn finished and no further input is queued for the agent. */
  turnEnded(agent: Agent, outcome: TurnOutcome): void;
  /** The Claude Code process went away without being asked to. */
  processLost(agent: Agent, message: string, usageLimit?: UsageLimit): void;
  /**
   * The agent's background commands have all ended, its last turn is over and Claude Code did not
   * start a new turn within a short grace time. A host that kept the agent waiting for that work
   * should now end it as usual.
   */
  backgroundIdle?(agent: Agent): void;
  /** Starts a Claude Code session. Only tests set this; otherwise the Agent SDK's `query` is used. */
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

type Content = string | Array<Record<string, unknown>>;

/** An async queue used as the input stream of a Claude Code session. */
class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

const TOOL_RESULT_LIMIT = 12_000;
const DRAFT_INTERVAL_MS = 70;
/** Built-in tools that would bypass Masthead's own team, or that it has no screen for. */
const DISALLOWED = [
  'Agent', 'Task', 'Workflow', 'SendMessage', 'ListAgents', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'ScheduleWakeup',
  // Ways to start work later or elsewhere, outside the team: scheduling, remote runs, other projects, phone pushes.
  'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'SendToProject', 'SendToProjectContext', 'PushNotification',
];
/** What Claude Code writes when the session to resume no longer exists (seen in Claude Code 2.1.331). */
const MISSING_SESSION = /No conversation found with session ID/;
const STDERR_KEEP = 4_000;
/** A run's outcome keeps at most this many turn texts and this many characters, newest first. */
const RUN_TEXT_TURNS = 8;
const RUN_TEXT_CHARS = 60_000;
/**
 * How long to wait, after the last background command ends, for the turn Claude Code starts by
 * itself to tell the agent about it. In a real run (Claude Code 2.1.331) system/init followed the
 * empty background_tasks_changed within 0.1 s.
 */
export const BACKGROUND_GRACE_MS = 3_000;

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters not shown)`;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((b: Record<string, unknown>) => {
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'image') return '[image]';
      if (b.type === 'tool_reference') return `[tool loaded: ${String(b.tool_name)}]`;
      return `[${String(b.type)}]`;
    })
    .join('\n');
}

/** One line describing a tool call, for the team list. */
export function describeTool(name: string, input: unknown): string {
  const line = toolLine(name, input, true);
  const text = line.target ? `${line.verb} ${line.target}` : line.verb;
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

/**
 * One member of the team: a Claude Code session and the app's view of it.
 *
 * The session is a long-lived process fed through an input stream, so messages can reach the agent
 * while it works. Each message Masthead sends carries an id; a turn's result names the ids it
 * consumed, and the agent counts as finished with its turn only once nothing it was sent is still
 * unanswered. A finished or stopped agent has no process; sending to it starts a new one that resumes
 * the same session.
 */
export class Agent {
  sessionId: string | null;
  /** Whether it still owes its parent a report when it next finishes. */
  owesReport: boolean;
  /** What it said in its most recent run of turns (see `runTexts`). */
  lastText = '';

  private q: Query | null = null;
  private input: Channel<SDKUserMessage> | null = null;
  private starting = false;
  /** Messages accepted before a process exists. */
  private backlog: SDKUserMessage[] = [];
  /** Ids of messages sent to the session that no finished turn has consumed yet. */
  private unanswered = new Set<string>();
  /** The first message of a brand-new session; kept until the session exists. */
  private seed: Content | null;
  private closing = false;
  /** Settles when the current process has fully exited; a resume waits for it. */
  private exited: Promise<void> | null = null;
  private interrupted = false;
  private costBefore = 0;
  private openTools = new Map<string, Item & { kind: 'tool' }>();
  private draft: Draft | null = null;
  private draftTimer: NodeJS.Timeout | null = null;
  private turnText = '';
  private turnError: string | undefined;
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
  private sent: SDKUserMessage[] = [];
  /** The session the current process was asked to resume, if any. */
  private resumedFrom: string | null = null;
  /** Whether the current process has reported its session (system/init). */
  private sawInit = false;
  /** Set when the current process said the session to resume no longer exists. */
  private sessionMissing = false;
  /** Whether a fresh session was already tried after a missing one; there is never a second try. */
  private freshRetried = false;
  /** Whether this Claude Code names the messages a turn consumed (newer versions do). */
  private namesConsumed = false;
  private stderrTail = '';
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
  /** The latest rate_limit_event of this process said a limit is reached (status 'rejected'). */
  private rejected: UsageLimit | null = null;
  /** The `error` field of this turn's assistant message, e.g. 'rate_limit'. */
  private turnApiError: string | undefined;
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
  get status(): AgentStatus {
    return this.info.status;
  }
  get live(): boolean {
    return this.info.status === 'queued' || this.info.status === 'running' || this.info.status === 'waiting';
  }
  get hasProcess(): boolean {
    return this.q !== null;
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
    if (this.stale && this.input && !this.closing && between) {
      // Between turns: let the old process exit and resume the same session with the new settings.
      // ensureProcess keeps the slot (the scheduler sees the same agent) and waits for the exit.
      this.stale = false;
      this.closing = true;
      this.input.close();
      this.backlog.push(...msgs);
      this.ensureProcess();
      return;
    }
    if (this.input && !this.closing) {
      // Every message goes the same way, so none can sit in the backlog of a live process.
      for (const m of msgs) {
        this.input.push(m);
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
    return [
      ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
      { type: 'text', text },
    ];
  }

  private userMessage(content: Content): SDKUserMessage {
    const uuid = randomUUID();
    this.unanswered.add(uuid);
    return {
      type: 'user',
      uuid,
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage;
  }

  private ensureProcess(): void {
    if (this.starting || (this.input && !this.closing)) return;
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
          if (!this.starting && !this.q) this.host.scheduler.release(this.tier, this.id);
          return;
        }
        try {
          this.launch();
        } catch (e) {
          this.starting = false;
          this.input = null;
          this.q = null;
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

  private launch(): void {
    const path = this.host.claudePath();
    if (!path) {
      this.starting = false;
      this.unanswered.clear();
      this.backlog = [];
      this.host.scheduler.release(this.tier, this.id);
      this.host.processLost(this, 'Claude Code was not found on this machine.');
      return;
    }
    const settings = this.host.settings();
    // The lead follows the model in the settings; other agents keep the one they were started with.
    if (this.tier === 'lead') this.info.model = settings.tiers.lead.model;
    const ceiling = settings.tiers[this.tier].effort;
    this.info.effort = settings.autoEffort ? capEffort(this.info.effort, ceiling) : ceiling;
    const input = new Channel<SDKUserMessage>();
    const first = !this.sessionId && this.seed !== null ? [this.userMessage(this.seed)] : [];
    this.sent = [...first, ...this.backlog];
    for (const m of this.sent) input.push(m);
    this.backlog = [];

    // Lean agents load only Masthead's own tools, not the person's connectors. Never the lead.
    const lean =
      (settings.leanSubagents && (this.tier === 'sonnet' || this.tier === 'haiku')) || (settings.leanOpus && this.tier === 'opus');
    const options: Options = {
      model: this.info.model,
      effort: this.info.effort,
      cwd: this.host.cwd,
      env: agentEnv(),
      pathToClaudeCodeExecutable: path,
      mcpServers: { masthead: this.host.tools(this) },
      allowedTools: ['mcp__masthead'],
      disallowedTools: this.tier === 'lead' ? DISALLOWED : [...DISALLOWED, 'AskUserQuestion'],
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      strictMcpConfig: lean,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: systemAppend({ tier: this.tier, name: this.name, parentName: this.host.parentName(this), settings, effort: this.info.effort }),
      },
      canUseTool: (toolName, toolInput, opts) => this.host.askPermission(this, toolName, toolInput, opts),
      stderr: (data) => {
        this.stderrTail = (this.stderrTail + data).slice(-STDERR_KEEP);
      },
    };
    if (this.sessionId) options.resume = this.sessionId;
    this.resumedFrom = this.sessionId;
    this.launchedAutoEffort = settings.autoEffort;
    this.rejected = null;
    this.limited = false;
    this.lastLimit = null;
    this.turnApiError = undefined;
    this.stale = false;
    this.inTurn = false;
    this.clearBackground();
    this.sawInit = false;
    this.sessionMissing = false;
    this.stderrTail = '';
    if (settings.permissionMode !== 'inherit') {
      options.permissionMode = settings.permissionMode;
      if (settings.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
    }

    this.closing = false;
    this.interrupted = false;
    this.turnText = '';
    this.turnError = undefined;
    this.input = input;
    let q: Query;
    try {
      q = (this.host.query ?? query)({ prompt: input, options });
    } catch (e) {
      this.input = null;
      this.starting = false;
      this.unanswered.clear();
      this.host.scheduler.release(this.tier, this.id);
      this.host.processLost(this, (e as Error).message);
      return;
    }
    this.q = q;
    this.starting = false;
    this.setStatus('running');
    const exited = this.consume(q, input).finally(() => {
      if (this.exited === exited) this.exited = null;
    });
    this.exited = exited;
  }

  private async consume(q: Query, input: Channel<SDKUserMessage>): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const m of q) this.handle(m);
    } catch (e) {
      failure = (e as Error)?.message || String(e);
    }
    input.close();
    this.q = null;
    this.input = null;
    this.costBefore = this.info.usage.costUsd;
    this.setDraft(null, true);
    this.closeOpenTools();
    this.inTurn = false;
    const hadBackground = this.hasBackgroundWork;
    this.clearBackground();
    if (this.closing) return; // we asked it to end
    if (this.resumeWasMissing(failure)) {
      this.startFresh();
      return;
    }
    const usageLimit = this.usageLimitFor(failure ?? '');
    if (usageLimit && hadBackground) usageLimit.backgroundStopped = true;
    if (usageLimit && !this.limited) this.holdUnanswered();
    this.limited = false;
    this.unanswered.clear();
    this.clearRunTexts();
    this.host.processLost(this, failure ?? 'The Claude Code process ended unexpectedly.', usageLimit);
  }

  /**
   * True when the process just ended because the session it was asked to resume no longer exists
   * (its file was deleted or moved). Claude Code reports this only as text, so the rule is narrow:
   * a resume that ended before the session started (no system/init) and whose error output names
   * the missing session. Any other failure is reported as before, so a session is never thrown
   * away because of a network or sign-in problem.
   */
  private resumeWasMissing(failure: string | null): boolean {
    if (!this.resumedFrom || this.sawInit || this.freshRetried) return false;
    return this.sessionMissing || MISSING_SESSION.test(failure ?? '') || MISSING_SESSION.test(this.stderrTail);
  }

  /** Starts a new session in place of a missing one and sends it what the old one never answered. Tried once. */
  private startFresh(): void {
    this.freshRetried = true;
    const pending = this.sent.filter((m) => this.unanswered.has(m.uuid as string));
    this.sessionId = null;
    this.seed = null;
    this.host.agentChanged(this);
    this.addItem({ kind: 'notice', level: 'info', text: 'The earlier session could not be found, so its context is lost. This agent starts fresh.' });
    const note = this.userMessage('(Masthead: your earlier session could not be found, so its context is lost and you are starting fresh. Ask for anything you need to know again.)');
    this.backlog = [note, ...pending, ...this.backlog];
    try {
      this.launch();
    } catch (e) {
      this.input = null;
      this.q = null;
      this.unanswered.clear();
      this.clearRunTexts();
      this.host.processLost(this, (e as Error)?.message || String(e));
    }
  }

  private handle(m: SDKMessage): void {
    switch (m.type) {
      case 'system': {
        const sub = (m as { subtype?: string }).subtype;
        if (sub === 'init') {
          const init = m as { session_id: string; model: string };
          this.sawInit = true;
          this.freshRetried = false;
          this.turnStarted();
          if (this.sessionId !== init.session_id) {
            this.sessionId = init.session_id;
            this.seed = null;
            this.host.agentChanged(this);
          }
          // Claude Code also starts turns by itself, for instance when a background command finishes.
          // Not while the conversation has paused the agent at the usage limit: that state is its own.
          if ((this.info.status === 'idle' || this.info.status === 'waiting') && this.info.pausedUntil === undefined) this.setStatus('running');
        } else if (sub === 'status') {
          const st = (m as { status?: string | null }).status;
          if (st === 'compacting') this.setActivity('Compacting its context');
        } else if (sub === 'background_tasks_changed') {
          this.backgroundChanged((m as { tasks?: Array<{ task_id: string; ambient?: boolean }> }).tasks ?? []);
        } else if (sub === 'compact_boundary') {
          this.addItem({ kind: 'notice', level: 'info', text: 'Earlier context was summarized to free up space.' });
        }
        return;
      }
      case 'stream_event':
        this.turnStarted();
        this.handleStream(m.event as unknown as Record<string, any>);
        return;
      case 'assistant': {
        this.setDraft(null, true);
        this.turnStarted();
        if (typeof (m as { user_message_uuid?: unknown }).user_message_uuid === 'string') this.namesConsumed = true;
        const err = (m as { error?: string }).error;
        const blocks = (m.message.content ?? []) as unknown as Array<Record<string, any>>;
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            this.turnText = b.text;
            this.addItem(err ? { kind: 'notice', level: 'error', text: b.text } : { kind: 'text', text: b.text });
          } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
            this.addItem({ kind: 'thinking', text: b.thinking });
          } else if (b.type === 'tool_use') {
            const item = this.addItem({ id: `tool-${b.id}`, kind: 'tool', name: b.name, input: b.input, done: false }) as Item & { kind: 'tool' };
            this.openTools.set(b.id, item);
            this.setActivity(describeTool(b.name, b.input));
          }
        }
        if (err) {
          this.turnApiError = err;
          this.turnError = `${err}${this.turnText ? `: ${this.turnText}` : ''}`;
        }
        return;
      }
      case 'user': {
        const content = m.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content as unknown as Array<Record<string, any>>) {
          if (b.type !== 'tool_result') continue;
          const item = this.openTools.get(b.tool_use_id);
          if (!item) continue;
          this.openTools.delete(b.tool_use_id);
          this.host.itemChanged(this, { ...item, result: clip(toolResultText(b.content), TOOL_RESULT_LIMIT), isError: b.is_error === true, done: true });
          // The tool is finished; do not go on showing it as what the agent is doing.
          if (this.openTools.size === 0) this.setActivity(undefined);
        }
        return;
      }
      case 'rate_limit_event': {
        const info = m.rate_limit_info;
        // Claude Code also sends each usage window with its own figures. That field is not in the SDK's
        // types, so it is read defensively; when it is absent the event's own figures are used.
        const windows = (info as { unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown; status?: unknown }> }).unifiedWindows;
        let sent = false;
        if (windows && typeof windows === 'object') {
          for (const [type, w] of Object.entries(windows)) {
            if (!w || typeof w !== 'object') continue;
            const status = w.status === 'allowed' || w.status === 'allowed_warning' || w.status === 'rejected' ? w.status : type === info.rateLimitType ? info.status : 'allowed';
            this.host.rateLimit({
              status,
              type,
              utilization: typeof w.utilization === 'number' ? w.utilization : type === info.rateLimitType ? info.utilization : undefined,
              resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : type === info.rateLimitType ? info.resetsAt : undefined,
            });
            sent = true;
          }
        }
        if (!sent) this.host.rateLimit({ status: info.status, type: info.rateLimitType, utilization: info.utilization, resetsAt: info.resetsAt });
        // Remember whether a limit is reached now. resetsAt arrives in seconds (seen: 1796144400).
        const hit = windows && typeof windows === 'object' ? Object.values(windows).find((w) => w && typeof w === 'object' && w.status === 'rejected') : undefined;
        if (info.status === 'rejected' || hit) {
          const at = typeof hit?.resetsAt === 'number' ? hit.resetsAt : info.resetsAt;
          this.rejected = { resetsAt: typeof at === 'number' ? at * 1000 : undefined };
        } else this.rejected = null;
        return;
      }
      case 'result': {
        const r = m as unknown as Record<string, any>;
        if (this.resumedFrom && !this.sawInit && !this.freshRetried) {
          // A resume that fails at start-up may write an error result before exiting; if it says the
          // session is gone, leave it to consume() to start fresh instead of ending the agent here.
          const said = [...(Array.isArray(r.errors) ? r.errors : []), typeof r.result === 'string' ? r.result : ''].join('\n');
          if (MISSING_SESSION.test(said)) {
            this.sessionMissing = true;
            return;
          }
        }
        this.handleResult(r);
        return;
      }
      default:
        return;
    }
  }

  private handleStream(e: Record<string, any>): void {
    if (e.type === 'message_start') {
      const u = e.message?.usage;
      if (u) {
        this.info.usage.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        this.host.agentChanged(this);
      }
    } else if (e.type === 'message_delta') {
      const out = e.usage?.output_tokens;
      if (typeof out === 'number') {
        this.info.usage.output += out;
        this.info.usage.context += out;
        this.host.agentChanged(this);
      }
    } else if (e.type === 'content_block_start') {
      const t = e.content_block?.type;
      if (t === 'text' || t === 'thinking') {
        this.setActivity(undefined);
        this.setDraft({ kind: t, text: '' }, true);
      }
    } else if (e.type === 'content_block_delta' && this.draft) {
      const d = e.delta;
      const add = d?.type === 'text_delta' ? d.text : d?.type === 'thinking_delta' ? d.thinking : '';
      if (add) this.setDraft({ kind: this.draft.kind, text: this.draft.text + add }, false);
    }
  }

  private handleResult(m: Record<string, any>): void {
    // Which of our messages this turn answered. The rule, from sdk.d.ts (SDKResultSuccess/Error):
    // - `user_message_uuids` lists every message the turn consumed; older versions send only the
    //   single `user_message_uuid`. Either way, only those are answered.
    // - A result that names neither is a turn Claude Code started by itself (a background command
    //   finished), or an error turn with no single triggering send. Messages still queued get turns
    //   and results of their own, so nothing is cleared, as long as this Claude Code is known to
    //   name consumed messages (it did so earlier in this process).
    // - A Claude Code that has never named one in this process may be too old to: then everything is
    //   cleared, as 0.1.0 did, so the agent can never stay busy for ever. A process that dies clears
    //   everything in consume() anyway.
    const consumed: string[] = Array.isArray(m.user_message_uuids)
      ? m.user_message_uuids
      : typeof m.user_message_uuid === 'string'
        ? [m.user_message_uuid]
        : [];
    if (consumed.length > 0) this.namesConsumed = true;
    if (consumed.length > 0 || this.namesConsumed) for (const id of consumed) this.unanswered.delete(id);
    else this.unanswered.clear();

    this.inTurn = false;
    this.info.usage.turns += 1;
    if (typeof m.total_cost_usd === 'number') this.info.usage.costUsd = this.costBefore + m.total_cost_usd;
    this.closeOpenTools();
    this.setDraft(null, true);

    let error = this.turnError;
    const wasInterrupted = this.interrupted;
    if (m.subtype !== 'success' && !wasInterrupted) {
      const details = Array.isArray(m.errors) ? m.errors.filter((x: unknown) => typeof x === 'string' && !x.startsWith('[ede_diagnostic]')).join('; ') : '';
      error = details || error || String(m.subtype).replace(/_/g, ' ');
    } else if (m.is_error === true && !wasInterrupted && !error) {
      error = typeof m.result === 'string' && m.result ? m.result : 'The turn ended with an error.';
    }
    const usageLimit = error && !wasInterrupted ? this.usageLimitFor(error) : undefined;
    this.turnApiError = undefined;
    if (this.limited) {
      // A result that was already on its way when the process was closed at the limit. Its messages
      // are held already; report it the same way (the conversation treats repeats as one pause).
      this.turnText = '';
      this.turnError = undefined;
      this.interrupted = false;
      this.unanswered.clear();
      this.host.agentChanged(this);
      this.host.turnEnded(this, { text: this.runText(), error, interrupted: false, usageLimit: usageLimit ?? this.lastLimit ?? {} });
      return;
    }
    const turnText = typeof m.result === 'string' && m.result ? m.result : this.turnText;
    this.addRunText(turnText);
    const text = this.runText();
    this.lastText = text || this.lastText;
    this.turnText = '';
    this.turnError = undefined;
    this.interrupted = false;
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
      if (this.q && !this.closing) {
        this.closing = true;
        try {
          this.q.close();
        } catch {
          // already gone
        }
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
  private usageLimitFor(error: string): UsageLimit | undefined {
    if (!this.rejected) return undefined;
    if (this.turnApiError === 'rate_limit' || /rate[ _]limit|usage limit|limit reached|hit your limit/i.test(error)) return { ...this.rejected };
    return undefined;
  }

  /** Moves the messages this process was sent and no turn consumed into `held`. */
  private holdUnanswered(): void {
    for (const m of this.sent) if (this.unanswered.has(m.uuid as string)) this.held.push(m.message.content as Content);
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
    this.inTurn = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private backgroundChanged(tasks: Array<{ task_id: string; ambient?: boolean }>): void {
    const had = this.background.size > 0;
    this.background = new Set(tasks.filter((t) => !t.ambient).map((t) => t.task_id));
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
    if (this.idleTimer || this.hasBackgroundWork || !this.q || this.closing) return;
    const q = this.q;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.q !== q || this.closing || this.inTurn || this.busy || this.hasBackgroundWork) return;
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
    if (!this.q || this.info.status !== 'running') return;
    this.interrupted = true;
    try {
      await this.q.interrupt();
    } catch {
      this.interrupted = false;
    }
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
    if (!kill) this.input?.close();
    else {
      try {
        this.q?.close();
      } catch {
        // already gone
      }
    }
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
    try {
      this.q?.close();
    } catch {
      // already gone
    }
    this.host.scheduler.release(this.tier, this.id);
  }

  /** Changes how hard the agent thinks from its next request on. */
  setEffort(level: Effort): void {
    if (this.info.effort === level) return;
    this.info.effort = level;
    this.host.agentChanged(this);
    this.q?.applyFlagSettings({ effortLevel: level }).catch(() => {
      // The level still applies the next time the session starts.
    });
  }

  /**
   * Applies changed settings to a running process. Effort takes effect from the next request; the
   * lead's model changes through setModel. A change to automatic effort changes the agent's tools,
   * which are built at launch, so the process is relaunched (same session) before its next turn.
   * An agent without a process needs nothing: launch() reads the settings.
   */
  applySettings(settings: Settings): void {
    if (!this.q || this.closing) return;
    const ceiling = settings.tiers[this.tier].effort;
    const effort = settings.autoEffort ? capEffort(this.info.effort, ceiling) : ceiling;
    if (effort !== this.info.effort) this.setEffort(effort);
    if (this.tier === 'lead' && settings.tiers.lead.model !== this.info.model) {
      const q = this.q;
      this.info.model = settings.tiers.lead.model;
      this.host.agentChanged(this);
      q.setModel(this.info.model).catch(() => {
        if (this.q === q) this.stale = true;
      });
    }
    if (this.launchedAutoEffort !== null && settings.autoEffort !== this.launchedAutoEffort) this.stale = true;
  }

  /** Reads the real size of the context window from Claude Code, when a process is up. */
  async refreshContext(): Promise<void> {
    const q = this.q;
    if (!q) return;
    try {
      const u = await q.getContextUsage();
      if (this.q !== q) return;
      this.info.usage.context = u.totalTokens;
      this.info.usage.contextMax = u.maxTokens;
      this.host.agentChanged(this);
    } catch {
      // not available; the estimate from the stream stays
    }
  }
}
