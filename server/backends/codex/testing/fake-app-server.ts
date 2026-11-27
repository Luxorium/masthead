/**
 * A scripted stand-in for the Codex CLI, for tests only: `runCli` answers --version, login status and the
 * debug commands; `spawnAppServer` gives an in-process JSON-RPC peer that speaks the app-server messages
 * the adapter uses, with the shapes recorded from codex-cli 0.172.0 (docs/plans/0.2.0/codex.md).
 *
 * What a turn does follows from the text it gets, like the fake backend's script:
 * - "Reply with exactly the word X"             → final answer X (and the thread remembers X)
 * - "What word did you reply with before?"      → the remembered word
 * - "Call the tool T with input {json}"         → an item/tool/call request, then the tool's text
 * - "Count slowly …"                            → a slow turn (deltas); steered text is answered too
 * - "Run the shell command `c`"                 → a command approval request; declined → "denied"
 * - "EDIT FILE"                                 → a file-change approval request
 * - "ASK PERSON"                                → item/tool/requestUserInput
 * - "WANT PERMISSION"                           → item/permissions/requestApproval
 * - "MCP IMAGE"                                 → an mcpToolCall whose result holds an image
 * - "THINK"                                     → reasoning deltas and a reasoning item
 * - "USAGE LIMIT"                               → a failed turn with usageLimitExceeded, and a rejected rate limit
 * - "NATIVE AGENT"                              → Codex starts one of its own sub-agents
 * - "COMPACT"                                   → thread/compacted
 * - "CRASH"                                     → the process exits mid-turn
 * - "WITHDRAW"                                  → an approval request that Codex withdraws (serverRequest/resolved)
 * thread/compact/start runs as a turn of its own, as codex-cli 0.172.0 does (turn/started, a
 * contextCompaction item, turn/completed); a thread whose last word is BADCOMPACT fails it.
 */
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import type { AppServerProcess, CliResult, RunCli, SpawnAppServer } from '../cli.js';

export const FAKE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

export interface FakeCodexOptions {
  version?: string;
  signedIn?: boolean | null;
  /** The debug prompt-input check still shows collaboration tools (the catalogue switch failed). */
  catalogIgnored?: boolean;
  /** ms between steps of a slow turn. */
  stepMs?: number;
}

export const FAKE_CATALOG = {
  models: [
    { slug: 'fake-astra', priority: 2, display_name: 'Fake Astra', context_window: 272000, visibility: 'list', multi_agent_version: 'v2' },
    { slug: 'fake-luna', priority: 8, display_name: 'Fake Luna', context_window: 128000, visibility: 'list', multi_agent_version: 'v2' },
    { slug: 'fake-hidden', display_name: 'Hidden', visibility: 'hide', multi_agent_version: 'v1' },
  ],
};

export const FAKE_MODEL_LIST = [
  { id: 'fake-astra', model: 'fake-astra', displayName: 'Fake Astra', description: 'Our most capable model.', hidden: false, isDefault: true, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((reasoningEffort) => ({ reasoningEffort, description: '' })) },
  { id: 'fake-luna', model: 'fake-luna', displayName: 'Fake Luna', hidden: false, isDefault: false, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'].map((reasoningEffort) => ({ reasoningEffort, description: '' })) },
  { id: 'fake-hidden', model: 'fake-hidden', displayName: 'Hidden', hidden: true, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [] },
];

/** Everything the fake saw, for assertions. */
export class FakeCodex {
  readonly cli: string[][] = [];
  readonly servers: FakeAppServer[] = [];
  readonly runCli: RunCli;
  readonly spawnAppServer: SpawnAppServer;

  constructor(readonly opts: FakeCodexOptions = {}) {
    this.runCli = async (_path, args) => {
      this.cli.push(args);
      return this.answer(args);
    };
    this.spawnAppServer = (_path, args) => {
      const s = new FakeAppServer(args, this.opts);
      this.servers.push(s);
      return s.process;
    };
  }

  get server(): FakeAppServer {
    return this.servers[this.servers.length - 1]!;
  }

  private answer(args: string[]): CliResult {
    const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === '--version') return ok(`codex-cli ${this.opts.version ?? '0.172.0'}\n`);
    if (args[0] === 'login') {
      const s = this.opts.signedIn === undefined ? true : this.opts.signedIn;
      return s === true ? ok('Logged in using ChatGPT\n') : s === false ? { code: 1, stdout: 'Not logged in\n', stderr: '' } : { code: 2, stdout: '', stderr: '???' };
    }
    if (args[0] === 'debug' && args[1] === 'models') return ok(JSON.stringify(FAKE_CATALOG));
    if (args[0] === 'debug' && args[1] === 'prompt-input') {
      const i = args.findIndex((a) => a.startsWith('model_catalog_json='));
      let multi = true;
      if (i >= 0 && !this.opts.catalogIgnored) {
        const file = JSON.parse(args[i]!.slice('model_catalog_json='.length)) as string;
        const cat = JSON.parse(readFileSync(file, 'utf8')) as typeof FAKE_CATALOG;
        multi = cat.models.some((m) => m.multi_agent_version);
      }
      const tools = [
        { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'exec', parameters: {} }] },
        ...(multi ? [{ type: 'namespace', name: 'collaboration', tools: [{ type: 'function', name: 'spawn_agent', parameters: {} }, { type: 'function', name: 'wait_agent', parameters: {} }] }] : []),
      ];
      return ok(JSON.stringify([{ type: 'additional_tools', role: 'developer', tools }, { type: 'message', role: 'user', content: [] }]));
    }
    return { code: 2, stdout: '', stderr: `unknown: ${args.join(' ')}` };
  }
}

interface Thread {
  id: string;
  word: string | null;
  turn: { id: string; steered: string[]; interrupted: boolean } | null;
  params: any;
}

export class FakeAppServer {
  readonly received: Array<{ method: string; params: any; id?: number | string }> = [];
  readonly threads = new Map<string, Thread>();
  /** Threads that exist "on disk" (kept across server restarts by the test, if it wants). */
  readonly process: AppServerProcess;
  killed = false;
  private toClient = new PassThrough();
  private fromClient = new PassThrough();
  private exitCb: ((d: string) => void) | null = null;
  private buf = '';
  private seq = 0;
  private serverReqId = 0;
  private waiting = new Map<number, (r: any) => void>();

  constructor(
    readonly args: string[],
    private opts: FakeCodexOptions,
  ) {
    this.fromClient.setEncoding('utf8');
    this.fromClient.on('data', (d: string) => this.data(d));
    this.process = {
      stdin: this.fromClient,
      stdout: this.toClient,
      kill: () => this.exit('killed'),
      onExit: (cb) => (this.exitCb = cb),
    };
  }

  /** Ends the process as a crash would. */
  exit(detail = 'crashed'): void {
    if (this.killed) return;
    this.killed = true;
    queueMicrotask(() => this.exitCb?.(detail));
  }

  calls(method: string): any[] {
    return this.received.filter((r) => r.method === method).map((r) => r.params);
  }

  private send(m: unknown): void {
    if (!this.killed) this.toClient.write(JSON.stringify(m) + '\n');
  }
  private note(method: string, params: unknown): void {
    this.send({ method, params });
  }
  private ask(method: string, params: unknown): Promise<any> {
    const id = this.serverReqId++;
    return new Promise((r) => {
      this.waiting.set(id, r);
      this.send({ id, method, params });
    });
  }
  private id(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }
  private sleep(ms = this.opts.stepMs ?? 5): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private data(d: string): void {
    this.buf += d;
    let n: number;
    while ((n = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, n);
      this.buf = this.buf.slice(n + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.method === undefined) {
        this.waiting.get(m.id)?.(m.result ?? { error: m.error });
        this.waiting.delete(m.id);
        continue;
      }
      this.received.push({ method: m.method, params: m.params, id: m.id });
      if (m.id !== undefined) void this.handle(m.method, m.params ?? {}).then(
        (result) => this.send({ id: m.id, result }),
        (e: { code?: number; message?: string }) => this.send({ id: m.id, error: { code: e.code ?? -32600, message: e.message ?? String(e) } }),
      );
    }
  }

  private async handle(method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return { userAgent: 'fake/0.172.0', codexHome: '/tmp/fake', platformFamily: 'unix', platformOs: 'linux' };
      case 'model/list':
        return { data: FAKE_MODEL_LIST.filter((m) => p.includeHidden || !m.hidden), nextCursor: null };
      case 'config/read':
        return { config: { mcp_servers: { blender: { command: 'x' }, notes: { url: 'http://localhost' } } }, origins: {}, layers: null };
      case 'thread/start': {
        const t: Thread = { id: this.id('thread'), word: null, turn: null, params: p };
        this.threads.set(t.id, t);
        queueMicrotask(() => this.note('thread/started', { thread: { id: t.id } }));
        return { thread: { id: t.id, path: `/tmp/fake/${t.id}.jsonl`, ephemeral: false } };
      }
      case 'thread/resume': {
        const t = this.threads.get(p.threadId) ?? FakeAppServer.disk.get(p.threadId);
        if (!t) throw { code: -32600, message: `no rollout found for thread id ${p.threadId}` };
        t.params = p;
        this.threads.set(t.id, t);
        return { thread: { id: t.id } };
      }
      case 'thread/unsubscribe': {
        const t = this.threads.get(p.threadId);
        if (t) FakeAppServer.disk.set(t.id, t);
        return {};
      }
      case 'turn/start': {
        const t = this.threads.get(p.threadId);
        if (!t) throw { code: -32600, message: 'unknown thread' };
        const turnId = this.id('turn');
        t.turn = { id: turnId, steered: [], interrupted: false };
        void this.runTurn(t, turnId, p);
        return { turn: { id: turnId, status: 'inProgress', items: [] } };
      }
      case 'turn/steer': {
        const t = this.threads.get(p.threadId);
        if (!t?.turn || t.turn.id !== p.expectedTurnId) throw { code: -32600, message: 'expected turn mismatch' };
        t.turn.steered.push(textOf(p.input));
        this.note('item/completed', { threadId: t.id, turnId: t.turn.id, item: { type: 'userMessage', id: this.id('u'), content: p.input } });
        return { turnId: t.turn.id };
      }
      case 'thread/compact/start': {
        const t = this.threads.get(p.threadId);
        if (!t) throw { code: -32600, message: 'unknown thread' };
        const turnId = this.id('turn');
        void (async () => {
          await this.sleep(1);
          const base = { threadId: t.id, turnId };
          this.note('turn/started', { threadId: t.id, turn: { id: turnId, status: 'inProgress', items: [] } });
          const id = this.id('cc');
          this.note('item/started', { ...base, item: { type: 'contextCompaction', id } });
          await this.sleep(1);
          this.note('item/completed', { ...base, item: { type: 'contextCompaction', id } });
          this.note('thread/tokenUsage/updated', { ...base, tokenUsage: { total: { totalTokens: 900, outputTokens: 10 }, last: { totalTokens: 400, outputTokens: 10 }, modelContextWindow: 272000 } });
          const bad = t.word === 'BADCOMPACT';
          this.note('turn/completed', { threadId: t.id, turn: { id: turnId, status: bad ? 'failed' : 'completed', items: [], error: bad ? { message: 'compaction failed', codexErrorInfo: 'other' } : null } });
        })();
        return {};
      }
      case 'turn/interrupt': {
        for (const t of [...this.threads.values(), ...this.children.values()]) if (t.turn && t.turn.id === p.turnId) t.turn.interrupted = true;
        return {};
      }
      default:
        throw { code: -32601, message: `fake has no ${method}` };
    }
  }

  /** Threads kept across fake servers, like rollout files on disk. */
  static disk = new Map<string, Thread>();
  private children = new Map<string, Thread>();

  private async runTurn(t: Thread, turnId: string, p: any): Promise<void> {
    const text = textOf(p.input);
    const base = { threadId: t.id, turnId };
    this.note('turn/started', { threadId: t.id, turn: { id: turnId, status: 'inProgress', items: [] } });
    await this.sleep(1);
    const say = async (answer: string, phase = 'final_answer') => {
      const id = this.id('msg');
      this.note('item/started', { ...base, item: { type: 'agentMessage', id, text: '', phase } });
      for (const part of answer.match(/.{1,6}/g) ?? []) this.note('item/agentMessage/delta', { ...base, itemId: id, delta: part });
      this.note('item/completed', { ...base, item: { type: 'agentMessage', id, text: answer, phase } });
    };
    const end = (status: string, error: unknown = null) => {
      this.note('thread/tokenUsage/updated', { ...base, tokenUsage: { total: { totalTokens: 2000, outputTokens: 40 * this.seq }, last: { totalTokens: 1500, outputTokens: 40 }, modelContextWindow: 272000 } });
      this.note('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1796364996 }, secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1796900000 }, rateLimitReachedType: null } });
      t.turn = null;
      this.note('turn/completed', { threadId: t.id, turn: { id: turnId, status, error, items: [] } });
    };
    let m: RegExpExecArray | null;
    if ((m = /Reply with exactly the word (\w+)/.exec(text))) {
      t.word = m[1]!;
      await say(m[1]!);
      return end('completed');
    }
    if (/What word did you reply with before/.test(text)) {
      await say(t.word ?? 'NOTHING');
      return end('completed');
    }
    if ((m = /Call the tool (\w+) with input (\{.*?\})/.exec(text))) {
      const callId = this.id('exec');
      const args = JSON.parse(m[2]!);
      this.note('item/started', { ...base, item: { type: 'dynamicToolCall', id: callId, namespace: null, tool: m[1], arguments: args, status: 'inProgress' } });
      const r = await this.ask('item/tool/call', { ...base, callId, namespace: null, tool: m[1], arguments: args });
      this.note('item/completed', { ...base, item: { type: 'dynamicToolCall', id: callId, namespace: null, tool: m[1], arguments: args, status: 'completed', contentItems: r.contentItems, success: r.success } });
      await say(`The tool returned: ${(r.contentItems ?? []).map((c: { text?: string }) => c.text ?? '').join(' ')}`);
      return end('completed');
    }
    if (/Count slowly/.test(text)) {
      const id = this.id('msg');
      this.note('item/started', { ...base, item: { type: 'agentMessage', id, text: '', phase: 'commentary' } });
      for (let i = 1; i <= 5; i++) {
        await this.sleep(this.opts.stepMs ?? 20);
        if (t.turn?.interrupted) return end('interrupted');
        this.note('item/agentMessage/delta', { ...base, itemId: id, delta: `${i}\n` });
      }
      this.note('item/completed', { ...base, item: { type: 'agentMessage', id, text: '1\n2\n3\n4\n5', phase: 'commentary' } });
      const extra = (t.turn?.steered ?? []).some((s) => /EXTRA/.test(s));
      await say(extra ? 'DONE EXTRA' : 'DONE');
      return end('completed');
    }
    if ((m = /Run the shell command `([^`]+)`/.exec(text))) {
      const itemId = this.id('exec');
      this.note('item/started', { ...base, item: { type: 'commandExecution', id: itemId, command: `/usr/bin/bash -lc '${m[1]}'`, cwd: '/tmp', status: 'inProgress' } });
      const r = await this.ask('item/commandExecution/requestApproval', { ...base, itemId, kind: 'command', command: `/usr/bin/bash -lc '${m[1]}'`, cwd: '/tmp', reason: null, availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] });
      const ok = r.decision === 'accept' || r.decision === 'acceptForSession';
      this.note('item/completed', { ...base, item: { type: 'commandExecution', id: itemId, command: m[1], status: ok ? 'completed' : 'declined', exitCode: ok ? 0 : null, aggregatedOutput: ok ? 'conformance\n' : null } });
      await say(ok ? 'It printed: conformance' : 'The command was denied.');
      return end('completed');
    }
    if (/EDIT FILE/.test(text)) {
      const itemId = this.id('patch');
      const changes = [{ path: '/tmp/a.txt', kind: { type: 'add' }, diff: '+a' }];
      this.note('item/started', { ...base, item: { type: 'fileChange', id: itemId, changes, status: 'inProgress' } });
      const r = await this.ask('item/fileChange/requestApproval', { ...base, itemId, reason: 'needs write', grantRoot: null });
      const ok = r.decision === 'accept' || r.decision === 'acceptForSession';
      this.note('item/completed', { ...base, item: { type: 'fileChange', id: itemId, changes, status: ok ? 'completed' : 'declined' } });
      await say(`file ${r.decision}`);
      return end('completed');
    }
    if (/ASK PERSON/.test(text)) {
      const r = await this.ask('item/tool/requestUserInput', { ...base, itemId: 'q1', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'colour', header: 'Colour', question: 'Which colour?', isOther: false, isSecret: false, options: [{ label: 'teal', description: 'a colour' }, { label: 'red', description: '' }] }] });
      await say(`answers ${JSON.stringify(r.answers)}`);
      return end('completed');
    }
    if (/WANT PERMISSION/.test(text)) {
      const r = await this.ask('item/permissions/requestApproval', { ...base, itemId: 'p1', environmentId: null, startedAtMs: 0, cwd: '/tmp', reason: 'network', permissions: { network: { enabled: true }, fileSystem: null } });
      await say(`permissions ${JSON.stringify(r)}`);
      return end('completed');
    }
    if (/WITHDRAW/.test(text)) {
      const id = this.serverReqId;
      void this.ask('item/commandExecution/requestApproval', { ...base, itemId: 'w1', kind: 'command', command: 'rm x', cwd: '/tmp', reason: null });
      await this.sleep(10);
      this.waiting.delete(id);
      this.note('serverRequest/resolved', { threadId: t.id, requestId: id });
      await say('withdrawn');
      return end('completed');
    }
    if (/MCP IMAGE/.test(text)) {
      const id = this.id('mcp');
      this.note('item/started', { ...base, item: { type: 'mcpToolCall', id, server: 'shots', tool: 'grab', arguments: { x: 1 }, status: 'inProgress' } });
      this.note('item/completed', { ...base, item: { type: 'mcpToolCall', id, server: 'shots', tool: 'grab', arguments: { x: 1 }, status: 'completed', result: { content: [{ type: 'text', text: 'shot' }, { type: 'image', data: FAKE_PNG, mimeType: 'image/png' }] }, error: null } });
      await say('done');
      return end('completed');
    }
    if (/THINK/.test(text)) {
      const id = this.id('rs');
      this.note('item/started', { ...base, item: { type: 'reasoning', id, summary: [], content: [] } });
      this.note('item/reasoning/summaryTextDelta', { ...base, itemId: id, delta: 'pondering', summaryIndex: 0 });
      this.note('item/completed', { ...base, item: { type: 'reasoning', id, summary: ['pondering deeply'], content: [] } });
      await say('thought');
      return end('completed');
    }
    if (/USAGE LIMIT/.test(text)) {
      this.note('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1796364996 }, secondary: null, rateLimitReachedType: 'rate_limit_reached' } });
      t.turn = null;
      this.note('turn/completed', { threadId: t.id, turn: { id: turnId, status: 'failed', items: [], error: { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } } });
      return;
    }
    if (/NATIVE AGENT/.test(text)) {
      const child: Thread = { id: this.id('child'), word: null, turn: null, params: {} };
      this.children.set(child.id, child);
      this.note('item/started', { ...base, item: { type: 'subAgentActivity', id: this.id('sa'), kind: 'started', model: 'fake-luna', agentThreadId: child.id } });
      const childTurn = this.id('turn');
      child.turn = { id: childTurn, steered: [], interrupted: false };
      this.note('turn/started', { threadId: child.id, turn: { id: childTurn, status: 'inProgress' } });
      for (let i = 0; i < 20 && !(t.turn?.interrupted); i++) await this.sleep(5);
      this.note('turn/completed', { threadId: child.id, turn: { id: childTurn, status: child.turn.interrupted ? 'interrupted' : 'completed', items: [] } });
      return end(t.turn?.interrupted ? 'interrupted' : 'completed');
    }
    if (/COMPACT/.test(text)) {
      this.note('thread/compacted', { threadId: t.id, turnId });
      await say('compacted');
      return end('completed');
    }
    if (/CRASH/.test(text)) {
      this.exit('panic: fake crash');
      return;
    }
    await say(`ok: ${text.slice(0, 40)}`);
    return end('completed');
  }
}

function textOf(input: Array<{ type: string; text?: string; path?: string }>): string {
  return (input ?? []).map((i) => (i.type === 'text' ? i.text : `[${i.type}:${i.path ?? ''}]`)).join('\n');
}
