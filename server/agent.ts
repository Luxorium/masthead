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
} from '../shared/protocol.js';
import { agentEnv } from './config.js';
import { toolLine } from '../shared/toolline.js';
import { systemAppend } from './prompts.js';
import { SlotCancelled, type Scheduler } from './scheduler.js';

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
  processLost(agent: Agent, message: string): void;
}

export interface TurnOutcome {
  /** The agent's final message of the turn. */
  text: string;
  error?: string;
  interrupted: boolean;
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
const DISALLOWED = ['Agent', 'Task', 'Workflow', 'SendMessage', 'ListAgents', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'ScheduleWakeup'];

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
  /** The final text of its most recent turn. */
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
    const msg = this.userMessage(content);
    if (this.input && !this.closing) {
      this.input.push(msg);
      if (this.info.status !== 'running') this.setStatus('running');
    } else {
      this.backlog.push(msg);
      this.ensureProcess();
    }
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
    let granted = false;
    const owner = this.info.parentId ?? this.info.convId;
    const slot = this.host.scheduler.acquire(this.tier, this.id, owner).then(() => {
      granted = true;
    });
    // Only show "queued" when the slot is not free right away.
    queueMicrotask(() => {
      if (!granted && this.starting) this.setStatus('queued');
    });
    slot
      .then(() => this.exited ?? undefined)
      .then(
      () => {
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
    if (!this.sessionId && this.seed !== null) input.push(this.userMessage(this.seed));
    for (const m of this.backlog) input.push(m);
    this.backlog = [];

    const lean = settings.leanSubagents && (this.tier === 'sonnet' || this.tier === 'haiku');
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
        append: systemAppend({ tier: this.tier, name: this.name, parentName: this.host.parentName(this), settings }),
      },
      canUseTool: (toolName, toolInput, opts) => this.host.askPermission(this, toolName, toolInput, opts),
      stderr: () => {},
    };
    if (this.sessionId) options.resume = this.sessionId;
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
      q = query({ prompt: input, options });
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
    if (this.closing) return; // we asked it to end
    this.unanswered.clear();
    this.host.processLost(this, failure ?? 'The Claude Code process ended unexpectedly.');
  }

  private handle(m: SDKMessage): void {
    switch (m.type) {
      case 'system': {
        const sub = (m as { subtype?: string }).subtype;
        if (sub === 'init') {
          const init = m as { session_id: string; model: string };
          if (this.sessionId !== init.session_id) {
            this.sessionId = init.session_id;
            this.seed = null;
            this.host.agentChanged(this);
          }
          // Claude Code also starts turns by itself, for instance when a background command finishes.
          if (this.info.status === 'idle' || this.info.status === 'waiting') this.setStatus('running');
        } else if (sub === 'status') {
          const st = (m as { status?: string | null }).status;
          if (st === 'compacting') this.setActivity('Compacting its context');
        } else if (sub === 'compact_boundary') {
          this.addItem({ kind: 'notice', level: 'info', text: 'Earlier context was summarized to free up space.' });
        }
        return;
      }
      case 'stream_event':
        this.handleStream(m.event as unknown as Record<string, any>);
        return;
      case 'assistant': {
        this.setDraft(null, true);
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
        if (err) this.turnError = `${err}${this.turnText ? `: ${this.turnText}` : ''}`;
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
        }
        return;
      }
      case 'rate_limit_event': {
        const info = m.rate_limit_info;
        this.host.rateLimit({ status: info.status, type: info.rateLimitType, utilization: info.utilization, resetsAt: info.resetsAt });
        return;
      }
      case 'result':
        this.handleResult(m as unknown as Record<string, any>);
        return;
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
      if (t === 'text' || t === 'thinking') this.setDraft({ kind: t, text: '' }, true);
    } else if (e.type === 'content_block_delta' && this.draft) {
      const d = e.delta;
      const add = d?.type === 'text_delta' ? d.text : d?.type === 'thinking_delta' ? d.thinking : '';
      if (add) this.setDraft({ kind: this.draft.kind, text: this.draft.text + add }, false);
    }
  }

  private handleResult(m: Record<string, any>): void {
    const consumed: string[] | undefined = m.user_message_uuids;
    if (Array.isArray(consumed)) for (const id of consumed) this.unanswered.delete(id);
    else this.unanswered.clear(); // an older Claude Code that does not name what a turn consumed

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
    const text = typeof m.result === 'string' && m.result ? m.result : this.turnText;
    this.lastText = text || this.lastText;
    this.turnText = '';
    this.turnError = undefined;
    this.interrupted = false;
    this.host.agentChanged(this);

    if (this.unanswered.size > 0) {
      // Another turn follows for input that arrived meanwhile.
      if (error) this.addItem({ kind: 'notice', level: 'error', text: error });
      return;
    }
    this.host.turnEnded(this, { text, error, interrupted: wasInterrupted });
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
    this.starting = false;
    this.closing = true;
    this.backlog = [];
    this.unanswered.clear();
    if (status === 'done') this.input?.close();
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
    this.starting = false;
    this.closing = true;
    this.backlog = [];
    this.unanswered.clear();
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
