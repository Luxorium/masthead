/**
 * The Codex backend: the person's own signed-in Codex CLI, driven through `codex app-server`
 * (JSON-RPC over stdio; protocol types vendored in ./protocol, generated from codex-cli 0.172.0).
 *
 * One app-server process per CodexBackend (that is, per Masthead server), shared by every agent of every
 * conversation; each agent is one thread on it. One process serves many active threads at once (tested),
 * the model catalogue that switches Codex's own sub-agents off is per process, and the process count stays
 * at one however large the team. If it dies, every open session gets `exited` and the next open() starts a
 * new one. Its environment is the one given to the first open() after a start (threads cannot have their
 * own); Masthead gives every session the same environment anyway.
 *
 * What Codex lacks next to Claude Code, as caps say:
 * - effort changes apply from the agent's next turn (`turn/start` carries the effort), not mid-turn;
 * - background commands are not tracked: Codex runs them as ordinary commands (`nohup … &`) and never
 *   wakes the agent when they end, so `background()` is never reported and nothing waits for them. The
 *   agent is told nothing extra; if it needs the result it must look again itself;
 * - no cost in dollars: the ChatGPT plan reports usage percent through rate limits.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EFFORTS, VERSION, type Effort, type Question, type RateLimitNotice } from '../../../shared/protocol.js';
import type { Backend, BackendCaps, BackendInfo, Content, ImagePart, ModelInfo, PermissionAnswer, PermissionAsk, Session, SessionEvents, SessionSpec } from '../types.js';
import {
  catalogArgs,
  findCodex,
  MIN_VERSION,
  nativeToolsFor,
  parseLogin,
  parseVersion,
  prepareCatalog,
  runCli as realRunCli,
  spawnAppServer as realSpawn,
  TESTED,
  versionAtLeast,
  type CatalogModel,
  type RunCli,
  type SpawnAppServer,
} from './cli.js';
import { RpcError, RpcPeer } from './rpc.js';
import type { InitializeParams } from './protocol/InitializeParams.js';
import type { ModelListResponse } from './protocol/v2/ModelListResponse.js';
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams.js';
import type { ThreadResumeParams } from './protocol/v2/ThreadResumeParams.js';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse.js';
import type { TurnStartParams } from './protocol/v2/TurnStartParams.js';
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy.js';
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse.js';
import type { TurnSteerParams } from './protocol/v2/TurnSteerParams.js';
import type { UserInput } from './protocol/v2/UserInput.js';
import type { ThreadItem } from './protocol/v2/ThreadItem.js';
import type { Turn } from './protocol/v2/Turn.js';
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot.js';
import type { DynamicToolCallResponse } from './protocol/v2/DynamicToolCallResponse.js';
import type { CommandExecutionRequestApprovalResponse } from './protocol/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalResponse } from './protocol/v2/FileChangeRequestApprovalResponse.js';
import type { PermissionsRequestApprovalResponse } from './protocol/v2/PermissionsRequestApprovalResponse.js';
import type { ToolRequestUserInputResponse } from './protocol/v2/ToolRequestUserInputResponse.js';

export { MIN_VERSION } from './cli.js';

export const CODEX_CAPS: BackendCaps = {
  efforts: [...EFFORTS],
  liveEffort: false,
  liveModel: true,
  resume: true,
  images: true,
  interrupt: true,
  background: false,
  permissions: 'callback',
  approvalsAlways: true,
  questions: true,
  consumedIds: true,
  midTurnDelivery: true,
  contextUsage: true,
  lean: true,
  compact: true,
  // One app-server serves every session: an agent's env (its scratch TMPDIR) cannot be its own.
  sessionEnv: false,
};

/** Codex levels Masthead never sends: `max` (no max in Masthead) and `ultra` ("automatic task delegation"). */
const NEVER = new Set(['max', 'ultra']);
const TOOL_RESULT_LIMIT = 12_000;

export interface CodexOptions {
  /** The codex executable; found on PATH when left out. */
  path?: string;
  env?: Record<string, string | undefined>;
  /** Where the rebuilt model catalogue is written. Default: a private folder under the system temp dir. */
  dataDir?: string;
  /** Tests replace how commands and the app-server are run. */
  runCli?: RunCli;
  spawnAppServer?: SpawnAppServer;
}

interface Server {
  peer: RpcPeer;
  kill(): void;
  catalog: CatalogModel[];
  catalogFile: string;
  /** Models already checked with debug prompt-input: model -> native agent tools found ([] = clean). */
  checked: Map<string, Promise<string[]>>;
  /** The person's own config sandbox per cwd (for inherit), learned once per process with an ephemeral probe thread. */
  ownSandbox: Map<string, Promise<SandboxPolicy | null>>;
}

export class CodexBackend implements Backend {
  readonly id = 'codex';
  readonly label = 'Codex';
  readonly caps: BackendCaps = { ...CODEX_CAPS, efforts: [...CODEX_CAPS.efforts] };
  /** Set by detect() for a version outside the tested range: usable, but say so. */
  warning: string | undefined;
  private server: Promise<Server> | null = null;
  private current: Server | null = null;
  private sessions = new Map<string, CodexSession>(); // threadId -> session
  private all = new Set<CodexSession>();
  private run: RunCli;
  private spawnServer: SpawnAppServer;
  private env: Record<string, string | undefined>;
  private dataDir: string;
  private disposed = false;

  constructor(private opts: CodexOptions = {}) {
    this.run = opts.runCli ?? realRunCli;
    this.spawnServer = opts.spawnAppServer ?? realSpawn;
    this.env = opts.env ?? process.env;
    this.dataDir = opts.dataDir ?? join(tmpdir(), `masthead-codex-${process.getuid?.() ?? 'user'}`);
  }

  private path(): string | null {
    return this.opts.path ?? findCodex(this.env);
  }

  async detect(): Promise<BackendInfo> {
    const base = { id: this.id, label: this.label, minVersion: MIN_VERSION };
    const path = this.path();
    if (!path) return { ...base, available: false, path: null, version: null, signedIn: null, error: 'Codex was not found. Install it and sign in with `codex login`, then restart Masthead.' };
    const v = await this.run(path, ['--version'], this.env);
    const version = parseVersion(v.stdout);
    if (v.code !== 0 || !version) return { ...base, available: false, path, version: null, signedIn: null, error: `Could not run ${path} --version.` };
    if (!versionAtLeast(version, MIN_VERSION)) return { ...base, available: false, path, version, signedIn: null, error: `Codex ${version} is too old; Masthead needs ${MIN_VERSION} or later.` };
    this.warning = TESTED.test(version) ? undefined : `Codex ${version} has not been tested with Masthead (tested: 0.172.x).`;
    const signedIn = parseLogin(await this.run(path, ['login', 'status'], this.env));
    if (signedIn === false) return { ...base, available: false, path, version, signedIn, error: 'Codex is not signed in. Run `codex login`.' };
    try {
      const prepared = await prepareCatalog(this.run, path, this.env, this.dataDir);
      const model = prepared.models.find((m) => m.visibility !== 'hide' && m.visibility !== 'hidden') ?? prepared.models[0]!;
      const found = await nativeToolsFor(this.run, path, this.env, prepared.file, model.slug);
      if (found.length > 0) return { ...base, available: false, path, version, signedIn, error: `Codex's own sub-agent tools could not be switched off (${found.join(', ')}), so a Codex team could break the team rules.` };
    } catch (e) {
      return { ...base, available: false, path, version, signedIn, error: (e as Error).message };
    }
    return { ...base, available: true, path, version, signedIn, ...(this.warning ? { warning: this.warning } : {}) };
  }

  async models(): Promise<ModelInfo[]> {
    const server = await this.ensureServer(this.env);
    const out: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const r: ModelListResponse = await server.peer.request('model/list', { includeHidden: false, cursor });
      for (const m of r.data) {
        if (m.hidden) continue;
        const efforts = EFFORTS.filter((e) => m.supportedReasoningEfforts.some((o) => o.reasoningEffort === e) && !NEVER.has(e));
        const nativeEffort: Partial<Record<Effort, string>> = {};
        for (const e of efforts) nativeEffort[e] = e;
        const cat = server.catalog.find((c) => c.slug === m.model || c.slug === m.id);
        out.push({ id: m.id, label: m.displayName || m.id, efforts, nativeEffort, ...(cat?.context_window ? { contextWindow: cat.context_window } : {}), ...(m.description ? { description: m.description } : {}), ...(typeof cat?.priority === 'number' ? { order: cat.priority } : {}), ...(m.isDefault ? { default: true } : {}) });
      }
      cursor = r.nextCursor ?? null;
    } while (cursor);
    return out;
  }

  open(spec: SessionSpec, events: SessionEvents): Session {
    const s = new CodexSession(this, spec, events);
    this.all.add(s);
    void s.boot();
    return s;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const s of this.all) s.silence();
    this.all.clear();
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    if (server) (await server.catch(() => null))?.kill();
  }

  // ---- used by sessions ----

  /** Starts the shared app-server (with a freshly rebuilt catalogue) if it is not running. */
  ensureServer(env: Record<string, string | undefined>): Promise<Server> {
    if (this.disposed) return Promise.reject(new Error('The Codex backend was shut down.'));
    if (!this.server) {
      const p = this.startServer(env);
      this.server = p;
      p.catch(() => {
        if (this.server === p) this.server = null;
      });
    }
    return this.server;
  }

  private async startServer(env: Record<string, string | undefined>): Promise<Server> {
    const path = this.path();
    if (!path) throw new Error('Codex was not found on this machine.');
    const prepared = await prepareCatalog(this.run, path, env, this.dataDir);
    const proc = this.spawnServer(path, ['app-server', ...catalogArgs(prepared.file)], env);
    const peer = new RpcPeer(proc.stdin, proc.stdout);
    const server: Server = { peer, kill: () => proc.kill(), catalog: prepared.models, catalogFile: prepared.file, checked: new Map(), ownSandbox: new Map() };
    this.current = server;
    let alive = true;
    proc.onExit((detail) => {
      alive = false;
      peer.close('Codex app-server ended.');
      if (this.current === server) {
        this.current = null;
        this.server = null;
      }
      this.serverLost(detail);
    });
    peer.onNotification = (method, params) => this.notification(method, params);
    peer.onRequest = (method, params, id) => this.request(method, params, id);
    const init: InitializeParams = {
      clientInfo: { name: 'masthead', title: 'Masthead', version: VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    await peer.request('initialize', init);
    peer.notify('initialized');
    if (!alive) throw new Error('Codex app-server ended while starting.');
    return server;
  }

  /** debug prompt-input once per model and catalogue: no Codex team runs with native agent tools. */
  checkModel(server: Server, model: string): Promise<string[]> {
    let p = server.checked.get(model);
    if (!p) {
      const path = this.path();
      p = path ? nativeToolsFor(this.run, path, this.env, server.catalogFile, model) : Promise.reject(new Error('Codex was not found.'));
      server.checked.set(model, p);
      p.catch(() => server.checked.delete(model));
    }
    return p;
  }

  bind(threadId: string, s: CodexSession): void {
    this.sessions.set(threadId, s);
  }
  unbind(s: CodexSession): void {
    this.all.delete(s);
    for (const [k, v] of this.sessions) if (v === s) this.sessions.delete(k);
  }

  private serverLost(detail: string): void {
    const lost = [...this.all];
    this.sessions.clear();
    for (const s of lost) s.lost(detail || 'Codex app-server ended unexpectedly.');
  }

  private notification(method: string, params: any): void {
    if (method === 'account/rateLimits/updated') {
      for (const s of this.all) s.rateLimits(params?.rateLimits);
      return;
    }
    const threadId: string | undefined = params?.threadId ?? params?.thread?.id;
    if (!threadId) return;
    const s = this.sessions.get(threadId);
    if (s) s.notification(method, params);
    else for (const x of this.all) x.foreignThread(threadId, method, params);
  }

  private async request(method: string, params: any, id: number | string): Promise<unknown> {
    const s = params?.threadId ? this.sessions.get(params.threadId) : undefined;
    if (!s) {
      if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
      throw new RpcError(-32601, `no Masthead session for ${method}`);
    }
    return s.serverRequest(method, params, id);
  }
}

interface Pending {
  id: string | null; // null: a note from the adapter itself, not a runtime message
  input: UserInput[];
}

/** One agent: one Codex thread. */
export class CodexSession implements Session {
  threadId: string | null = null;
  private effort: Effort;
  private model: string;
  private closed = false;
  private quiet = false;
  private ready = false;
  /** Waiting for a thread: the first messages. */
  private early: Pending[] = [];
  /** For the next turn. */
  private queue: Pending[] = [];
  private turnId: string | null = null;
  private starting = false;
  /** Messages sent while turn/start was on its way: steered once the turn id is known. */
  private forCurrent: Pending[] = [];
  private consumed: string[] = [];
  private finalText = '';
  private lastText = '';
  private interruptPending = false;
  private drafting: string | null = null; // item id of the draft being shown
  private fileChanges = new Map<string, unknown>();
  private asks = new Map<string, AbortController>();
  private usage: { used: number; max: number } | null = null;
  private policed = false;
  private childTurns = new Map<string, string>(); // native sub-agent thread -> its turn
  private tempFiles: string[] = [];
  private outputSeen = 0;
  private endedResolve!: () => void;
  readonly ended: Promise<void> = new Promise((r) => (this.endedResolve = r));


  constructor(
    private backend: CodexBackend,
    private spec: SessionSpec,
    private ev: SessionEvents,
  ) {
    this.effort = spec.effort;
    this.model = spec.model;
  }

  // ---- start ----

  async boot(): Promise<void> {
    let server: Server;
    try {
      server = await this.backend.ensureServer(this.spec.env);
      const found = await this.backend.checkModel(server, this.model);
      if (found.length > 0) throw new Error(`Codex's own sub-agent tools are still offered to ${this.model} (${found.join(', ')}); a Codex team cannot run.`);
    } catch (e) {
      return this.fail((e as Error).message);
    }
    if (this.closed) return;
    const common = { model: this.model, cwd: this.spec.cwd, developerInstructions: this.spec.instructions, config: (await this.config(server)) as ThreadStartParams['config'], ...this.permissions() };
    try {
      let thread: ThreadStartResponse['thread'];
      if (this.spec.resume) {
        const params: ThreadResumeParams = { threadId: this.spec.resume, ...common, excludeTurns: true };
        const r = await server.peer.request('thread/resume', params);
        thread = r.thread;
        if (this.closed) return;
        // A thread keeps the sandbox it last had (a turn's override included), and resume cannot change
        // it (codex 0.172). So the sandbox this mode gives a new thread is learned and, where it differs,
        // sent with every turn: a chat never runs wider than its mode says.
        const reported: SandboxPolicy | null = r.sandbox ?? null;
        const wanted = await this.wantedSandbox(server, common);
        if (this.closed) return;
        if (!wanted) {
          if (reported?.type === 'dangerFullAccess' || !reported) {
            void server.peer.request('thread/unsubscribe', { threadId: thread.id }).catch(() => {});
            return this.fail('This chat\'s Codex thread may still have full access, and Masthead cannot tell which sandbox the permission mode "inherit" should give it, so it was not resumed. Pick another permission mode in Settings, or start a new chat.');
          }
          this.threadSandbox = reported;
        } else {
          this.threadSandbox = wanted;
          if (!sameSandbox(wanted, reported)) this.sandboxOverridden = true;
        }
      } else {
        const params: ThreadStartParams = {
          ...common,
          dynamicTools: this.spec.tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, inputSchema: t.input as any })),
        };
        const r = (await server.peer.request('thread/start', params)) as ThreadStartResponse;
        thread = r.thread;
        this.threadSandbox = r.sandbox ?? null;
      }
      if (this.closed) return;
      this.threadId = thread.id;
      this.backend.bind(thread.id, this);
      this.ready = true;
      this.ev.sessionStarted(thread.id);
    } catch (e) {
      const msg = (e as Error).message;
      return this.fail(msg, this.spec.resume !== undefined && /no rollout found|not found|no such thread|unknown thread/i.test(msg));
    }
    const first = this.early.splice(0);
    if (first.length > 0) this.startTurn(first);
  }

  /**
   * Per-thread config. Codex's own extras Masthead has no screen for are off for every agent (goals,
   * generated images, its multi-agent feature as a second lock behind the catalogue). A lean agent also
   * skips the person's MCP servers and ChatGPT apps.
   */
  private async config(server: Server): Promise<Record<string, unknown>> {
    const c: Record<string, unknown> = { 'features.goals': false, 'features.image_generation': false, 'features.multi_agent': false, 'features.multi_agent_v2': false };
    if (!this.spec.lean) return c;
    c['features.apps'] = false;
    try {
      const r: any = await server.peer.request('config/read', { cwd: this.spec.cwd });
      const servers = r?.config?.mcp_servers;
      if (servers && typeof servers === 'object') for (const name of Object.keys(servers)) c[`mcp_servers.${name}.enabled`] = false;
    } catch {
      // Without the list the person's servers stay on; the agent still works.
    }
    return c;
  }

  /**
   * Approvals always reach Masthead (approvalsReviewer "user"), except with bypass, where nothing asks.
   * inherit keeps the person's own policy and sandbox.
   */
  private permissions(mode = this.spec.permissionMode): Partial<ThreadStartParams> {
    switch (mode) {
      case 'bypassPermissions':
        return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
      case 'default':
        return { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user' };
      case 'acceptEdits':
      case 'auto':
        return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' };
      default:
        return { approvalsReviewer: 'user' };
    }
  }

  /**
   * A compaction asked for with compact(). Codex 0.172 runs it as a turn of its own (turn/started, a
   * contextCompaction item, turn/completed; seen live, without a thread/compacted notification), so that
   * turn is recognised by being the first to start after the request and reported only as `compacted`.
   */
  private compacting: { turnId: string | null; resolve: () => void; reject: (e: Error) => void } | null = null;

  private endCompaction(error?: string): void {
    const c = this.compacting;
    if (!c) return;
    this.compacting = null;
    if (error) c.reject(new Error(error));
    else {
      this.ev.compacted?.();
      c.resolve();
    }
  }

  compact(): Promise<void> {
    if (this.closed || !this.threadId) return Promise.reject(new Error('The session is not open.'));
    if (this.turnId || this.starting || this.compacting) return Promise.reject(new Error('The session is busy.'));
    return new Promise<void>((resolve, reject) => {
      this.compacting = { turnId: null, resolve, reject };
      this.request('thread/compact/start', { threadId: this.threadId }).catch((e: Error) => this.endCompaction(e.message || 'Compaction could not start.'));
    });
  }

  private fail(failure: string, sessionMissing = false): void {
    this.endCompaction(failure);
    if (this.closed || this.quiet) return;
    this.closed = true;
    this.backend.unbind(this);
    this.ev.exited(sessionMissing ? { failure, sessionMissing: true } : { failure });
    this.endedResolve();
  }

  // ---- Session ----

  send(id: string, content: Content): void {
    if (this.closed) return;
    const m: Pending = { id, input: this.toInput(content) };
    if (!this.ready) this.early.push(m);
    else if (this.compacting) this.queue.push(m); // sent when the compaction ends
    else if (this.starting) this.forCurrent.push(m);
    else if (this.turnId) void this.steer(m);
    else this.startTurn([m]);
  }

  async interrupt(): Promise<void> {
    if (this.closed) return;
    if (this.turnId) await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    else if (this.starting) this.interruptPending = true;
  }

  setEffort(effort: Effort): void {
    this.effort = effort; // sent with the next turn/start
  }

  setModel(model: string): void {
    this.model = model; // sent with the next turn/start
  }

  /**
   * Sent with the next turn/start (it overrides the thread's policy from then on): the approval policy
   * changes; the sandbox stays the session's own (what the thread started with, or after a resume what
   * its mode wants), except that bypass opens it fully. inherit relaunches, and so does leaving bypass
   * when there is no narrower sandbox of the session's own to go back to (unknown, or full access).
   */
  setPermissionMode(mode: string): void {
    if (mode === 'inherit') throw new Error('needs a relaunch');
    const p = this.permissions(mode);
    // Back from full access needs the thread's own sandbox: unknown, or full access itself, means relaunch.
    if (p.sandbox !== 'danger-full-access' && (this.threadSandbox?.type === 'dangerFullAccess' || (this.sandboxOverridden && !this.threadSandbox))) throw new Error('needs a relaunch');
    this.spec = { ...this.spec, permissionMode: mode };
    this.approvals = { approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer ?? null };
  }

  /**
   * The sandbox a brand-new thread gets in this mode. Bypass: full access; default/acceptEdits/auto: the
   * workspace-write one their sandbox param gives (seen on codex 0.172: no roots, network off). inherit:
   * the person's own config, from an ephemeral probe thread (no turn, no usage, in no thread list; it
   * stays loaded in the app-server until it ends, so it is done once per process and cwd). null: unknown.
   */
  private wantedSandbox(server: Server, common: Partial<ThreadStartParams>): Promise<SandboxPolicy | null> {
    const sandbox = this.permissions().sandbox;
    if (sandbox === 'danger-full-access') return Promise.resolve({ type: 'dangerFullAccess' });
    if (sandbox === 'workspace-write') return Promise.resolve({ type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
    const cwd = this.spec.cwd;
    let own = server.ownSandbox.get(cwd);
    if (!own) {
      own = (async () => {
        try {
          const probe = (await server.peer.request('thread/start', { cwd, config: common.config, ephemeral: true } satisfies ThreadStartParams)) as ThreadStartResponse;
          void server.peer.request('thread/unsubscribe', { threadId: probe.thread.id }).catch(() => {});
          return probe.sandbox ?? null;
        } catch {
          return null; // an older Codex without ephemeral threads
        }
      })();
      server.ownSandbox.set(cwd, own);
    }
    return own;
  }

  /** The thread's sandbox: as reported at start, or after a resume the one its mode wants. For turn/start overrides. */
  private threadSandbox: SandboxPolicy | null = null;
  /** An approval policy changed since launch (setPermissionMode). */
  private approvals: Pick<TurnStartParams, 'approvalPolicy' | 'approvalsReviewer'> | null = null;

  /**
   * What turn/start overrides: a changed approval policy, and the sandbox when it must differ from the
   * thread's: fully open under bypass, or a workspace-write sandbox that also lets the agent write in
   * its folders outside cwd (SessionSpec.dirs, its scratch folder). Nothing when nothing changed.
   * A read-only thread (the person's own setting) is never widened, so it cannot write in its scratch
   * folder, though its prompt (built before the sandbox is known) still names it.
   */
  private turnOverrides(): Partial<TurnStartParams> {
    // sandboxOverridden: a sandbox has been (or must be) sent; it sticks, so it is sent on every turn.
    const out: Partial<TurnStartParams> = { ...(this.approvals ?? {}) };
    const sb = this.threadSandbox;
    if (this.approvals && this.spec.permissionMode === 'bypassPermissions') {
      out.sandboxPolicy = { type: 'dangerFullAccess' };
      this.sandboxOverridden = true;
    } else if (sb?.type === 'workspaceWrite') {
      const extra = (this.spec.dirs ?? []).filter((d) => !sb.writableRoots.includes(d));
      if (extra.length || this.sandboxOverridden) out.sandboxPolicy = { ...sb, writableRoots: [...sb.writableRoots, ...extra] };
    } else if (sb && this.sandboxOverridden) {
      // An override sticks on the thread: put back (or keep putting) the sandbox it should have.
      out.sandboxPolicy = sb;
    }
    return out;
  }

  /** A sandbox override has been sent (full access under bypass): every later turn sends the sandbox again. */
  private sandboxOverridden = false;

  close(how: 'graceful' | 'now'): void {
    if (this.closed) return;
    const turn = this.turnId;
    this.endCompaction('The session was closed.');
    this.closed = true;
    this.quiet = true;
    for (const a of this.asks.values()) a.abort();
    this.asks.clear();
    const threadId = this.threadId;
    this.backend.unbind(this);
    if (threadId) {
      const stop = how === 'now' && turn ? this.request('turn/interrupt', { threadId, turnId: turn }).catch(() => {}) : Promise.resolve();
      void stop.then(() => this.request('thread/unsubscribe', { threadId }).catch(() => {})).finally(() => this.endedResolve());
    } else this.endedResolve();
    this.cleanTemp();
  }

  async contextUsage(): Promise<{ used: number; max: number }> {
    return this.usage ?? { used: 0, max: 0 };
  }

  // ---- from the backend ----

  /** The backend is shutting down: no more events. */
  silence(): void {
    this.endCompaction('Codex was shut down.');
    this.quiet = true;
    this.closed = true;
    this.cleanTemp();
    this.endedResolve();
  }

  lost(detail: string): void {
    this.endCompaction(detail || 'Codex app-server ended.');
    if (this.closed || this.quiet) return;
    this.closed = true;
    this.cleanTemp();
    this.ev.exited({ failure: detail });
    this.endedResolve();
  }

  rateLimits(snap: RateLimitSnapshot | undefined): void {
    if (this.quiet || !snap) return;
    for (const [which, w] of [['primary', snap.primary], ['secondary', snap.secondary]] as const) {
      if (!w) continue;
      const reached = snap.rateLimitReachedType != null || w.usedPercent >= 100;
      const status: RateLimitNotice['status'] = reached && w.usedPercent >= 100 ? 'rejected' : reached || w.usedPercent >= 80 ? 'allowed_warning' : 'allowed';
      const span = w.windowDurationMins ? `${w.windowDurationMins}m` : which;
      this.ev.rateLimit({ status, type: `${snap.limitId ?? 'codex'}:${span}`, utilization: w.usedPercent / 100, ...(w.resetsAt != null ? { resetsAt: w.resetsAt } : {}) });
    }
  }

  /** A notification for a thread that is not ours: maybe a native sub-agent this agent started. */
  foreignThread(threadId: string, method: string, params: any): void {
    if (!this.childTurns.has(threadId)) return;
    if (method === 'turn/started' && params?.turn?.id) {
      this.childTurns.set(threadId, params.turn.id);
      void this.request('turn/interrupt', { threadId, turnId: params.turn.id }).catch(() => {});
    }
  }

  notification(method: string, p: any): void {
    if (this.quiet) return;
    if (this.compacting) {
      // Everything of the compaction's own turn stays inside the adapter, except usage.
      if (method === 'turn/started' && !this.compacting.turnId && !this.turnId && !this.starting) return void (this.compacting.turnId = p.turn?.id ?? null);
      const turnOf = p.turnId ?? (method.startsWith('turn/') ? p.turn?.id : undefined);
      if (this.compacting.turnId && turnOf === this.compacting.turnId) {
        if (method === 'turn/completed') {
          const t = p.turn as Turn;
          this.endCompaction(t.status === 'completed' ? undefined : t.error?.message || `Compaction ${t.status}.`);
          return this.next();
        }
        if (method !== 'thread/tokenUsage/updated') return;
      }
      if (method === 'thread/compacted') return; // reported once, by endCompaction
    }
    switch (method) {
      case 'turn/started':
        if (this.starting || p.turn?.id === this.turnId || !this.turnId) {
          if (!this.turnId) this.turnId = p.turn.id;
          this.ev.turnStarted();
        }
        return;
      case 'turn/completed':
        return this.turnCompleted(p.turn as Turn);
      case 'item/started':
        return this.itemStarted(p.item as ThreadItem);
      case 'item/completed':
        return this.itemCompleted(p.item as ThreadItem);
      case 'item/agentMessage/delta':
        return this.delta('text', p.itemId, p.delta);
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        return this.delta('thinking', p.itemId, p.delta);
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage;
        const used = u?.last?.totalTokens ?? 0;
        const max = u?.modelContextWindow ?? this.usage?.max ?? 0;
        this.usage = { used, max };
        const total = u?.total?.outputTokens ?? this.outputSeen;
        const output = Math.max(0, total - this.outputSeen);
        this.outputSeen = Math.max(this.outputSeen, total);
        this.ev.usage({ context: used, ...(output ? { output } : {}) });
        return;
      }
      case 'thread/compacted':
        this.ev.compacted?.();
        return;
      case 'serverRequest/resolved': {
        const key = String(p.requestId);
        this.asks.get(key)?.abort();
        this.asks.delete(key);
        return;
      }
      default:
        return;
    }
  }

  async serverRequest(method: string, p: any, rpcId: number | string = randomUUID()): Promise<unknown> {
    p = { ...p, __requestId: rpcId };
    switch (method) {
      case 'item/tool/call':
        return this.toolCall(p);
      case 'item/commandExecution/requestApproval': {
        const decisions: unknown[] = Array.isArray(p.availableDecisions) ? p.availableDecisions : ['accept', 'acceptForSession', 'decline'];
        const has = (d: string) => decisions.some((x) => x === d || (x && typeof x === 'object' && d in (x as object)));
        const always = has('acceptForSession') ? 'acceptForSession' : decisions.find((x) => x && typeof x === 'object' && 'acceptWithExecpolicyAmendment' in (x as object));
        const a = await this.ask(p, { kind: 'command', toolName: 'shell', input: { command: p.command, cwd: p.cwd }, description: p.reason ?? undefined, canAlways: !!always });
        const decision: CommandExecutionRequestApprovalResponse['decision'] = a.decision === 'deny' ? 'decline' : a.decision === 'always' && always ? (always as any) : 'accept';
        return { decision } satisfies CommandExecutionRequestApprovalResponse;
      }
      case 'item/fileChange/requestApproval': {
        const a = await this.ask(p, { kind: 'file', toolName: 'apply_patch', input: { changes: this.fileChanges.get(p.itemId) ?? null, grantRoot: p.grantRoot ?? null }, description: p.reason ?? undefined, canAlways: true });
        return { decision: a.decision === 'deny' ? 'decline' : a.decision === 'always' ? 'acceptForSession' : 'accept' } satisfies FileChangeRequestApprovalResponse;
      }
      case 'item/permissions/requestApproval': {
        const a = await this.ask(p, { kind: 'tool', toolName: 'permissions', input: p.permissions, description: p.reason ?? undefined, canAlways: true });
        const granted = a.decision === 'deny' ? {} : { ...(p.permissions?.network ? { network: p.permissions.network } : {}), ...(p.permissions?.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}) };
        return { permissions: granted, scope: a.decision === 'always' ? 'session' : 'turn' } satisfies PermissionsRequestApprovalResponse;
      }
      case 'item/tool/requestUserInput': {
        const qs: Array<{ id: string; header: string; question: string; options: Array<{ label: string; description?: string }> | null }> = p.questions ?? [];
        if (!this.spec.canAskPerson) return { answers: {} } satisfies ToolRequestUserInputResponse;
        const questions: Question[] = qs.map((q) => ({ question: q.question, header: q.header, options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })), multiSelect: false }));
        const a = await this.ask(p, { kind: 'question', toolName: 'request_user_input', input: { questions: qs }, canAlways: false, questions });
        const answers: ToolRequestUserInputResponse['answers'] = {};
        if (a.decision !== 'deny') for (const q of qs) {
          const ans = a.answers?.[q.question];
          if (ans !== undefined) answers[q.id] = { answers: [ans] };
        }
        return { answers } satisfies ToolRequestUserInputResponse;
      }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      default:
        throw new RpcError(-32601, `Masthead does not handle ${method}`);
    }
  }

  // ---- turns ----

  private startTurn(msgs: Pending[]): void {
    if (this.closed || !this.threadId) return;
    this.starting = true;
    this.consumed = msgs.flatMap((m) => (m.id ? [m.id] : []));
    this.finalText = '';
    this.lastText = '';
    this.policed = false;
    const params: TurnStartParams = {
      threadId: this.threadId,
      input: msgs.flatMap((m) => m.input),
      model: this.model,
      effort: this.effort,
      ...this.turnOverrides(),
      ...(msgs[0]?.id ? { clientUserMessageId: msgs[0].id } : {}),
    };
    this.request<TurnStartResponse>('turn/start', params).then(
      (r) => {
        if (this.closed) return;
        this.turnId = r.turn.id;
        this.starting = false;
        if (this.interruptPending) {
          this.interruptPending = false;
          void this.interrupt();
        }
        for (const m of this.forCurrent.splice(0)) void this.steer(m);
      },
      (e: Error) => {
        this.starting = false;
        if (this.closed) return;
        const ids = this.consumed;
        this.consumed = [];
        this.ev.turnEnded({ consumed: ids, text: '', error: e.message, interrupted: false });
        this.next();
      },
    );
  }

  private async steer(m: Pending): Promise<void> {
    const turnId = this.turnId;
    if (!turnId || !this.threadId) return void this.queue.push(m);
    const params: TurnSteerParams = { threadId: this.threadId, expectedTurnId: turnId, input: m.input, ...(m.id ? { clientUserMessageId: m.id } : {}) };
    if (m.id) this.consumed.push(m.id); // counted now, so a turn that ends meanwhile cannot drop it
    try {
      await this.request('turn/steer', params);
    } catch {
      // The turn ended first, or it cannot be steered: the message opens the next turn instead.
      if (m.id) this.consumed = this.consumed.filter((x) => x !== m.id);
      if (this.turnId === turnId || this.turnId === null) {
        if (this.turnId === null && !this.starting) this.startTurn([m]);
        else this.queue.push(m);
      } else this.queue.push(m);
    }
  }

  private turnCompleted(turn: Turn): void {
    if (this.turnId && turn.id !== this.turnId) return;
    this.draftEnd();
    const consumed = this.consumed;
    this.consumed = [];
    this.turnId = null;
    this.starting = false;
    const text = this.finalText || this.lastText;
    if (turn.status === 'interrupted') this.ev.turnEnded({ consumed, text, interrupted: true });
    else if (turn.status === 'failed') {
      const info = turn.error?.codexErrorInfo as unknown;
      const key = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
      const apiError = key === 'usageLimitExceeded' || key === 'rateLimitExceeded' ? 'rate_limit' : key;
      this.ev.turnEnded({ consumed, text, error: turn.error?.message || 'The turn failed.', ...(apiError ? { apiError } : {}), interrupted: false });
    } else this.ev.turnEnded({ consumed, text, interrupted: false });
    this.next();
  }

  private next(): void {
    if (this.closed || this.queue.length === 0) return;
    this.startTurn(this.queue.splice(0));
  }

  // ---- items ----

  private delta(kind: 'text' | 'thinking', itemId: string, append: string): void {
    if (typeof append !== 'string' || !append) return;
    if (this.drafting !== itemId) {
      if (this.drafting) this.ev.draft(null);
      this.drafting = itemId;
      this.ev.draft({ kind, append: '' });
    }
    this.ev.draft({ kind, append });
  }

  private draftEnd(): void {
    if (this.drafting) {
      this.drafting = null;
      this.ev.draft(null);
    }
  }

  private itemStarted(item: ThreadItem): void {
    const it = item as any;
    switch (it.type) {
      case 'commandExecution':
        return this.ev.toolStarted({ id: it.id, name: 'shell', input: { command: it.command, cwd: it.cwd } });
      case 'fileChange':
        this.fileChanges.set(it.id, it.changes);
        return this.ev.toolStarted({ id: it.id, name: 'apply_patch', input: { changes: it.changes } });
      case 'mcpToolCall':
        return this.ev.toolStarted({ id: it.id, name: `mcp__${it.server}__${it.tool}`, input: it.arguments });
      case 'dynamicToolCall':
        return this.ev.toolStarted({ id: it.id, name: it.namespace ? `${it.namespace}.${it.tool}` : it.tool, input: it.arguments });
      case 'webSearch':
        return this.ev.toolStarted({ id: it.id, name: 'web_search', input: { query: it.query } });
      case 'imageView':
        return this.ev.toolStarted({ id: it.id, name: 'view_image', input: { path: it.path } });
      case 'collabAgentToolCall':
      case 'subAgentActivity':
        return this.police(it);
      default:
        return;
    }
  }

  private itemCompleted(item: ThreadItem): void {
    const it = item as any;
    switch (it.type) {
      case 'agentMessage': {
        if (this.drafting === it.id) this.draftEnd();
        const text = typeof it.text === 'string' ? it.text : '';
        if (!text.trim()) return;
        this.lastText = text;
        if (it.phase === 'final_answer') this.finalText = text;
        this.ev.text(text);
        return;
      }
      case 'reasoning': {
        if (this.drafting === it.id) this.draftEnd();
        const text = [...(it.summary ?? []), ...(it.summary?.length ? [] : (it.content ?? []))].join('\n').trim();
        if (text) this.ev.thinking(text);
        return;
      }
      case 'commandExecution':
        return this.ev.toolFinished({ id: it.id, result: clip(it.aggregatedOutput ?? (it.status === 'declined' ? 'Declined.' : '')), isError: it.status !== 'completed' || (it.exitCode ?? 0) !== 0 });
      case 'fileChange': {
        this.fileChanges.delete(it.id);
        const lines = (it.changes ?? []).map((c: { path: string; kind: unknown }) => `${typeof c.kind === 'string' ? c.kind : (c.kind as { type?: string })?.type ?? 'update'} ${c.path}`);
        return this.ev.toolFinished({ id: it.id, result: lines.join('\n') || String(it.status), isError: it.status !== 'completed' });
      }
      case 'mcpToolCall': {
        const parts = mcpContent(it.result?.content);
        return this.ev.toolFinished({ id: it.id, result: clip(it.error?.message ?? parts.text), isError: !!it.error || it.status === 'failed', ...(parts.images.length ? { images: parts.images } : {}) });
      }
      case 'dynamicToolCall': {
        const parts = dynamicContent(it.contentItems);
        return this.ev.toolFinished({ id: it.id, result: clip(parts.text), isError: it.success === false, ...(parts.images.length ? { images: parts.images } : {}) });
      }
      case 'webSearch':
      case 'imageView':
        return this.ev.toolFinished({ id: it.id, result: '', isError: false });
      default:
        return;
    }
  }

  /**
   * The fallback behind the catalogue switch: should Codex ever start one of its own sub-agents, stop it
   * and the turn, and tell the agent to use Masthead's spawn_agent. (Codex sends no approval request for
   * these, so they cannot be declined.)
   */
  private police(it: any): void {
    if (it.type === 'subAgentActivity' && it.kind !== 'started') return;
    if (it.agentThreadId) this.childTurns.set(it.agentThreadId, '');
    for (const t of it.receiverThreadIds ?? []) this.childTurns.set(t, '');
    if (this.policed) return;
    this.policed = true;
    this.ev.activity?.("Stopped one of Codex's own sub-agents");
    this.queue.push({ id: null, input: [textInput("(Masthead: Codex's own sub-agent tools are not available in this team. Use spawn_agent and send_message instead.)")] });
    void this.interrupt();
  }

  private async toolCall(p: { tool: string; namespace: string | null; arguments: unknown }): Promise<DynamicToolCallResponse> {
    const tool = this.spec.tools.find((t) => t.name === p.tool);
    if (!tool) return { contentItems: [{ type: 'inputText', text: `Error: no tool named ${p.tool}` }], success: false };
    try {
      const text = await tool.run(p.arguments ?? {});
      return { contentItems: [{ type: 'inputText', text }], success: !text.startsWith('Error:') };
    } catch (e) {
      return { contentItems: [{ type: 'inputText', text: `Error: ${(e as Error).message}` }], success: false };
    }
  }

  private ask(p: { itemId?: string }, a: Omit<PermissionAsk, 'signal'>): Promise<PermissionAnswer> {
    const ctl = new AbortController();
    const key = String((p as { __requestId?: unknown }).__requestId ?? randomUUID());
    this.asks.set(key, ctl);
    return this.ev.askPermission({ ...a, signal: ctl.signal }).finally(() => this.asks.delete(key));
  }

  // ---- helpers ----

  private request<T = any>(method: string, params: unknown): Promise<T> {
    return this.backend.ensureServer(this.spec.env).then((s) => s.peer.request<T>(method, params));
  }

  private toInput(content: Content): UserInput[] {
    if (typeof content === 'string') return [textInput(content)];
    const out: UserInput[] = [];
    for (const part of content) {
      if (part.type === 'text') out.push(textInput(part.text));
      else {
        const ext = part.mediaType.split('/')[1] ?? 'png';
        const dir = join(tmpdir(), `masthead-codex-${process.getuid?.() ?? 'user'}`, 'images');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = join(dir, `${randomUUID()}.${ext}`);
        writeFileSync(file, Buffer.from(part.data, 'base64'), { mode: 0o600 });
        this.tempFiles.push(file);
        out.push({ type: 'localImage', path: file });
      }
    }
    return out;
  }

  private cleanTemp(): void {
    // Images stay until the session closes: Codex reads them when the turn runs.
    for (const f of this.tempFiles.splice(0)) void import('node:fs').then((fs) => fs.rm(f, { force: true }, () => {}));
  }
}

function textInput(text: string): UserInput {
  return { type: 'text', text, text_elements: [] };
}

function clip(text: string): string {
  return text.length <= TOOL_RESULT_LIMIT ? text : `${text.slice(0, TOOL_RESULT_LIMIT)}\n… (${text.length - TOOL_RESULT_LIMIT} more characters not shown)`;
}

function dataUrlImage(url: string): ImagePart | null {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(url);
  return m ? { type: 'image', mediaType: m[1] as ImagePart['mediaType'], data: m[2]! } : null;
}

function dynamicContent(items: unknown): { text: string; images: ImagePart[] } {
  const texts: string[] = [];
  const images: ImagePart[] = [];
  for (const c of Array.isArray(items) ? items : []) {
    if (c?.type === 'inputText') texts.push(String(c.text ?? ''));
    else if (c?.type === 'inputImage') {
      const img = dataUrlImage(String(c.imageUrl ?? ''));
      if (img) images.push(img);
      texts.push('[image]');
    }
  }
  return { text: texts.join('\n'), images };
}

function mcpContent(items: unknown): { text: string; images: ImagePart[] } {
  const texts: string[] = [];
  const images: ImagePart[] = [];
  for (const c of Array.isArray(items) ? items : []) {
    if (c?.type === 'text') texts.push(String(c.text ?? ''));
    else if (c?.type === 'image' && typeof c.data === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(c.mimeType)) {
      images.push({ type: 'image', mediaType: c.mimeType, data: c.data });
      texts.push('[image]');
    } else texts.push(`[${String(c?.type)}]`);
  }
  return { text: texts.join('\n'), images };
}

/** Whether two sandbox policies are the same (writable roots in any order). */
export function sameSandbox(a: SandboxPolicy | null, b: SandboxPolicy | null): boolean {
  if (!a || !b) return a === b;
  const norm = (p: SandboxPolicy) => JSON.stringify(p.type === 'workspaceWrite' ? { ...p, writableRoots: [...p.writableRoots].sort() } : p, Object.keys(p).sort());
  return a.type === b.type && norm(a) === norm(b);
}
