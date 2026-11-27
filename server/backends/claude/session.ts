import { randomUUID } from 'node:crypto';
/**
 * The Claude Code adapter: one Agent SDK `query()` per session, driven in streaming-input mode, with
 * its messages translated into the neutral events of ../types.ts. It decides nothing about when an
 * agent's work is over; it only reports. Behaviour carried over unchanged from 0.1.4's server/agent.ts.
 */
import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions as SdkSpawnOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { killTree, realTreeDeps, spawnTree, type TreeDeps } from '../proctree.js';
import { EFFORTS, type Effort, type Question } from '../../../shared/protocol.js';
import type { Backend, BackendCaps, BackendInfo, Content, ModelInfo, PermissionAsk, Session, SessionEvents, SessionSpec } from '../types.js';
import { agentEnv } from './env.js';
import { MCP_NAME, mcpServer } from './mcp.js';

/** An async queue used as the input stream of a Claude Code session. */
export class Channel<T> implements AsyncIterable<T> {
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

/** Built-in tools that would bypass Masthead's own team, or that it has no screen for. */
export const DISALLOWED = [
  'Agent', 'Task', 'Workflow', 'SendMessage', 'ListAgents', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'ScheduleWakeup',
  // Ways to start work later or elsewhere, outside the team: scheduling, remote runs, other projects, phone pushes.
  'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'SendToProject', 'SendToProjectContext', 'PushNotification',
];
/** What Claude Code writes when the session to resume no longer exists (seen in Claude Code 2.1.331). */
export const MISSING_SESSION = /No conversation found with session ID/;
const STDERR_KEEP = 4_000;

export const CLAUDE_CAPS: BackendCaps = {
  efforts: [...EFFORTS],
  liveEffort: true,
  liveModel: true,
  resume: true,
  images: true,
  interrupt: true,
  background: true,
  permissions: 'callback',
  approvalsAlways: true,
  questions: true,
  consumedIds: true,
  midTurnDelivery: true,
  contextUsage: true,
  lean: true,
  compact: true,
  sessionEnv: true,
};

export function toolResultText(content: unknown): string {
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

/** Neutral content -> the Anthropic message content Claude Code reads. */
function sdkContent(content: Content): unknown {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }));
}

export interface ClaudeBackendOptions {
  /** The Claude Code binary; null when it was not found. */
  path: string | null;
  /** As found at start-up (findClaude), for detect(). */
  version?: string | null;
  error?: string;
  /** Looks for Claude Code again (path search and --version); detect() calls it each time when set. */
  find?: () => { path: string | null; version: string | null; error?: string };
  /** How the Claude Code process is started and stopped; tests replace it. */
  treeDeps?: TreeDeps;
  /** Starts a session; tests replace it. Defaults to the Agent SDK's `query`. */
  query?: typeof sdkQuery;
}

export class ClaudeBackend implements Backend {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';
  readonly caps = CLAUDE_CAPS;

  constructor(private opts: ClaudeBackendOptions) {}

  /** Looks for Claude Code again when a finder was given (a real start); otherwise reports what it was given. */
  async detect(): Promise<BackendInfo> {
    if (this.opts.find) {
      const found = this.opts.find();
      this.opts.path = found.path;
      this.opts.version = found.version;
      this.opts.error = found.error;
    }
    return {
      id: this.id,
      label: this.label,
      // A binary that would not run (`--version` failed) is not usable either.
      available: this.opts.path !== null && !this.opts.error,
      path: this.opts.path,
      version: this.opts.version ?? null,
      signedIn: null,
      ...(this.opts.error ? { error: this.opts.error } : {}),
    };
  }

  async models(): Promise<ModelInfo[]> {
    // Filled from Query.supportedModels() in the catalogue step; the tiers still name models directly.
    return [];
  }

  open(spec: SessionSpec, events: SessionEvents): Session {
    return new ClaudeSession(this.opts, spec, events);
  }
}

export class ClaudeSession implements Session {
  readonly ended: Promise<void>;
  private q: Query | null = null;
  private input = new Channel<SDKUserMessage>();
  private closeRequested = false;
  private interrupted = false;
  private sawInit = false;
  private missingSaid = false;
  /** Whether this Claude Code names the messages a turn consumed (newer versions do). */
  private namesConsumed = false;
  private stderrTail = '';
  private turnText = '';
  private turnError: string | undefined;
  private turnApiError: string | undefined;
  private context = 0;
  /** A compaction asked for with compact(): the id of its `/compact` message, and how to settle it. */
  private compacting: { id: string; resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(
    private opts: ClaudeBackendOptions,
    private spec: SessionSpec,
    private ev: SessionEvents,
  ) {
    let q: Query;
    try {
      q = (opts.query ?? sdkQuery)({ prompt: this.input, options: this.options() });
    } catch (e) {
      const failure = (e as Error)?.message || String(e);
      this.ended = Promise.resolve();
      queueMicrotask(() => this.ev.exited({ failure }));
      return;
    }
    this.q = q;
    this.ended = this.consume(q);
  }

  private options(): Options {
    const s = this.spec;
    const options: Options = {
      model: s.model,
      effort: s.effort,
      cwd: s.cwd,
      env: { ...agentEnv(), ...s.env },
      pathToClaudeCodeExecutable: this.opts.path ?? undefined,
      mcpServers: { [MCP_NAME]: mcpServer(s.tools) },
      // Only an in-process server is passed, which this option does not affect; set it so the SDK does
      // not warn about the deprecated default (sdk.d.ts, mcpServersDelivery).
      mcpServersDelivery: 'argv',
      allowedTools: [`mcp__${MCP_NAME}`],
      disallowedTools: s.canAskPerson ? DISALLOWED : [...DISALLOWED, 'AskUserQuestion'],
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      // Lean agents load only Masthead's own tools, not the person's connectors.
      strictMcpConfig: s.lean,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: s.instructions },
      canUseTool: (toolName, toolInput, o) => this.canUseTool(toolName, toolInput, o),
      stderr: (data) => this.onStderr(data),
      // Masthead starts Claude Code itself, so a stop ends the commands it started too (proctree.ts).
      spawnClaudeCodeProcess: (o) => this.spawnProcess(o),
    };
    if (s.resume) options.resume = s.resume;
    if (s.dirs?.length) options.additionalDirectories = s.dirs;
    if (s.permissionMode !== 'inherit') {
      options.permissionMode = s.permissionMode as Options['permissionMode'];
      if (s.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
    }
    return options;
  }

  private onStderr(data: string): void {
    this.stderrTail = (this.stderrTail + data).slice(-STDERR_KEEP);
  }

  /** Starts Claude Code in its own process tree; the SDK's kill ends the whole tree. */
  private spawnProcess(o: SdkSpawnOptions): SpawnedProcess {
    const deps = this.opts.treeDeps ?? realTreeDeps;
    const child = spawnTree(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] }, deps);
    // A custom spawner gets no stderr handling from the SDK: read it here (the missing-session check needs it).
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => this.onStderr(d));
    // The SDK aborts this after its graceful-close window (stdin EOF, ~2 s): then end the tree.
    o.signal?.addEventListener('abort', () => killTree(child, deps), { once: true });
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: () => {
        killTree(child, deps);
        return true;
      },
      on: ((event: 'exit' | 'error', listener: (...a: any[]) => void) => void child.on(event, listener)) as SpawnedProcess['on'],
      once: ((event: 'exit' | 'error', listener: (...a: any[]) => void) => void child.once(event, listener)) as SpawnedProcess['once'],
      off: ((event: 'exit' | 'error', listener: (...a: any[]) => void) => void child.off(event, listener)) as SpawnedProcess['off'],
    };
  }

  private async canUseTool(toolName: string, input: Record<string, unknown>, o: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    // Masthead's own tools are checked by the conversation, not by the person.
    if (toolName.startsWith(`mcp__${MCP_NAME}__`)) return { behavior: 'allow', updatedInput: input };
    const isQuestion = toolName === 'AskUserQuestion';
    const ask: PermissionAsk = {
      kind: isQuestion ? 'question' : toolName === 'Bash' ? 'command' : toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit' ? 'file' : 'tool',
      toolName,
      input,
      title: o.title,
      description: o.description ?? o.decisionReason,
      canAlways: !isQuestion && (o.suggestions?.length ?? 0) > 0,
      questions: isQuestion && Array.isArray(input.questions) ? (input.questions as Question[]) : undefined,
      signal: o.signal,
    };
    const a = await this.ev.askPermission(ask);
    if (a.decision === 'deny') return { behavior: 'deny', message: a.message || 'The person declined this.' };
    if (isQuestion && a.answers) return { behavior: 'allow', updatedInput: { ...input, answers: a.answers } };
    if (a.decision === 'always' && o.suggestions?.length) return { behavior: 'allow', updatedInput: input, updatedPermissions: o.suggestions };
    return { behavior: 'allow', updatedInput: input };
  }

  send(id: string, content: Content): void {
    this.input.push({ type: 'user', uuid: id, message: { role: 'user', content: sdkContent(content) }, parent_tool_use_id: null } as unknown as SDKUserMessage);
  }

  async interrupt(): Promise<void> {
    if (!this.q) return;
    this.interrupted = true;
    try {
      await this.q.interrupt();
    } catch {
      this.interrupted = false;
    }
  }

  setEffort(effort: Effort): Promise<void> {
    return this.q ? this.q.applyFlagSettings({ effortLevel: effort }) : Promise.resolve();
  }

  /** Through the SDK's setPermissionMode. inherit has no mode to send, and bypass needs the launch flag: both relaunch. */
  async setPermissionMode(mode: string): Promise<void> {
    if (!this.q) throw new Error('no process');
    if (mode === 'inherit' || (mode === 'bypassPermissions' && this.spec.permissionMode !== 'bypassPermissions')) throw new Error('needs a relaunch');
    const r = await this.q.setPermissionMode(mode as NonNullable<Options['permissionMode']>);
    if (r?.mode && r.mode !== mode) throw new Error(`the mode is ${String(r.mode)}`);
  }

  setModel(model: string): Promise<void> {
    return this.q ? this.q.setModel(model) : Promise.reject(new Error('no process'));
  }

  close(how: 'graceful' | 'now'): void {
    this.closeRequested = true;
    if (how === 'graceful') this.input.close();
    else {
      try {
        this.q?.close();
      } catch {
        // already gone
      }
    }
  }

  /**
   * Compacts the session's memory: Claude Code runs its `/compact` command when it arrives as a user
   * message (seen with 2.1.331: status, init, compact_boundary, then a result naming the message, with
   * local_command 'compact'). That result settles this instead of ending a turn.
   */
  compact(): Promise<void> {
    if (!this.q) return Promise.reject(new Error('Claude Code is not running.'));
    if (this.compacting) return Promise.reject(new Error('Already compacting.'));
    return new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      this.compacting = { id, resolve, reject };
      this.send(id, '/compact');
    });
  }

  async contextUsage(): Promise<{ used: number; max: number }> {
    if (!this.q) throw new Error('no process');
    const u = await this.q.getContextUsage();
    return { used: u.totalTokens, max: u.maxTokens };
  }

  private async consume(q: Query): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const m of q) this.handle(m);
    } catch (e) {
      failure = (e as Error)?.message || String(e);
    }
    this.input.close();
    this.q = null;
    this.compacting?.reject(new Error(failure ?? 'Claude Code ended during compaction.'));
    this.compacting = null;
    if (this.closeRequested) return; // we asked it to end
    // A resume whose session no longer exists: Claude Code reports it only as text, so the rule is
    // narrow: a resume that ended before the session started, whose output names the missing session.
    const sessionMissing =
      !!this.spec.resume && !this.sawInit && (this.missingSaid || MISSING_SESSION.test(failure ?? '') || MISSING_SESSION.test(this.stderrTail));
    this.ev.exited({ failure: failure ?? undefined, ...(sessionMissing ? { sessionMissing } : {}), ...(this.turnApiError ? { apiError: this.turnApiError } : {}) });
  }

  private handle(m: SDKMessage): void {
    switch (m.type) {
      case 'system': {
        const sub = (m as { subtype?: string }).subtype;
        if (sub === 'init') {
          this.sawInit = true;
          // A Claude Code that lists the interrupt receipt (uuids of queued messages) names the messages
          // each turn consumes, so a result naming none consumed none: a turn it started by itself, such
          // as the first one of a resumed session whose background command the restart killed. Known from
          // the first init, before any result, so such a turn cannot count what was sent as answered.
          const caps = (m as { capabilities?: unknown }).capabilities;
          if (Array.isArray(caps) && caps.includes('interrupt_receipt_v1')) this.namesConsumed = true;
          // Every turn starts with init, also those Claude Code starts by itself; a compaction is no turn.
          if (!this.compacting) this.ev.turnStarted();
          this.ev.sessionStarted((m as { session_id: string }).session_id);
        } else if (sub === 'status') {
          const st = (m as { status?: string | null }).status;
          if (st === 'compacting') this.ev.activity?.('Compacting its context');
        } else if (sub === 'background_tasks_changed') {
          const tasks = (m as { tasks?: Array<{ task_id: string; ambient?: boolean }> }).tasks ?? [];
          this.ev.background(tasks.filter((t) => !t.ambient).map((t) => t.task_id));
        } else if (sub === 'compact_boundary') {
          this.ev.compacted?.();
        }
        return;
      }
      case 'stream_event':
        this.ev.turnStarted();
        this.stream(m.event as unknown as Record<string, any>);
        return;
      case 'assistant': {
        this.ev.draft(null);
        this.ev.turnStarted();
        if (typeof (m as { user_message_uuid?: unknown }).user_message_uuid === 'string') this.namesConsumed = true;
        const err = (m as { error?: string }).error;
        const blocks = (m.message.content ?? []) as unknown as Array<Record<string, any>>;
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            this.turnText = b.text;
            this.ev.text(b.text, !!err);
          } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
            this.ev.thinking(b.thinking);
          } else if (b.type === 'tool_use') {
            this.ev.toolStarted({ id: b.id, name: b.name, input: b.input });
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
          const images = Array.isArray(b.content)
            ? (b.content as Array<Record<string, any>>)
                .filter((c) => c.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string')
                .map((c) => ({ type: 'image' as const, mediaType: c.source.media_type, data: c.source.data }))
            : [];
          this.ev.toolFinished({ id: b.tool_use_id, result: toolResultText(b.content), isError: b.is_error === true, ...(images.length ? { images } : {}) });
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
            this.ev.rateLimit({
              status,
              type,
              utilization: typeof w.utilization === 'number' ? w.utilization : type === info.rateLimitType ? info.utilization : undefined,
              resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : type === info.rateLimitType ? info.resetsAt : undefined,
            });
            sent = true;
          }
        }
        if (!sent) this.ev.rateLimit({ status: info.status, type: info.rateLimitType, utilization: info.utilization, resetsAt: info.resetsAt });
        return;
      }
      case 'result': {
        const r = m as unknown as Record<string, any>;
        if (this.spec.resume && !this.sawInit) {
          // A resume that fails at start-up may write an error result before exiting; if it says the
          // session is gone, report it when the process ends instead of as a turn.
          const said = [...(Array.isArray(r.errors) ? r.errors : []), typeof r.result === 'string' ? r.result : ''].join('\n');
          if (MISSING_SESSION.test(said)) {
            this.missingSaid = true;
            return;
          }
        }
        this.result(r);
        return;
      }
      default:
        return;
    }
  }

  private stream(e: Record<string, any>): void {
    if (e.type === 'message_start') {
      const u = e.message?.usage;
      if (u) {
        this.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        this.ev.usage({ context: this.context });
      }
    } else if (e.type === 'message_delta') {
      const out = e.usage?.output_tokens;
      if (typeof out === 'number') {
        this.context += out;
        this.ev.usage({ context: this.context, output: out });
      }
    } else if (e.type === 'content_block_start') {
      const t = e.content_block?.type;
      if (t === 'text' || t === 'thinking') this.ev.draft({ kind: t, append: '' });
    } else if (e.type === 'content_block_delta') {
      const d = e.delta;
      if (d?.type === 'text_delta' && d.text) this.ev.draft({ kind: 'text', append: d.text });
      else if (d?.type === 'thinking_delta' && d.thinking) this.ev.draft({ kind: 'thinking', append: d.thinking });
    }
  }

  private result(m: Record<string, any>): void {
    const c = this.compacting;
    if (c && (m.local_command === 'compact' || (Array.isArray(m.user_message_uuids) && m.user_message_uuids.includes(c.id)) || m.user_message_uuid === c.id)) {
      this.compacting = null;
      if (typeof m.total_cost_usd === 'number') this.ev.usage({ costUsd: m.total_cost_usd });
      const failed = m.subtype !== 'success' || m.is_error === true;
      if (failed) c.reject(new Error((Array.isArray(m.errors) && m.errors.join('; ')) || (typeof m.result === 'string' && m.result) || 'The compaction failed.'));
      else c.resolve();
      return;
    }
    // Which of our messages this turn answered (sdk.d.ts, SDKResultSuccess/Error): `user_message_uuids`,
    // or on older versions the single `user_message_uuid`. A result that names neither is a turn Claude
    // Code started by itself, or an error turn with no single triggering send: [] when this Claude Code
    // is known to name consumed messages (it did so earlier in this process), otherwise null (it may be
    // too old to; the runtime then counts everything as answered).
    const named: string[] = Array.isArray(m.user_message_uuids)
      ? m.user_message_uuids
      : typeof m.user_message_uuid === 'string'
        ? [m.user_message_uuid]
        : [];
    if (named.length > 0) this.namesConsumed = true;
    const consumed = named.length > 0 || this.namesConsumed ? named : null;
    if (typeof m.total_cost_usd === 'number') this.ev.usage({ costUsd: m.total_cost_usd });
    let error = this.turnError;
    const interrupted = this.interrupted;
    if (m.subtype !== 'success' && !interrupted) {
      const details = Array.isArray(m.errors) ? m.errors.filter((x: unknown) => typeof x === 'string' && !x.startsWith('[ede_diagnostic]')).join('; ') : '';
      error = details || error || String(m.subtype).replace(/_/g, ' ');
    } else if (m.is_error === true && !interrupted && !error) {
      error = typeof m.result === 'string' && m.result ? m.result : 'The turn ended with an error.';
    }
    const text = typeof m.result === 'string' && m.result ? m.result : this.turnText;
    const apiError = this.turnApiError;
    this.turnText = '';
    this.turnError = undefined;
    this.turnApiError = undefined;
    this.interrupted = false;
    this.ev.turnEnded({ consumed, text, ...(error ? { error } : {}), ...(apiError ? { apiError } : {}), interrupted });
  }
}
