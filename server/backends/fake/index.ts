/**
 * A scripted backend with no CLI behind it, for unit tests, the conformance suite, the browser test and
 * CI on machines without any account. It is deterministic: what it does follows from the text of the
 * messages it gets (see `script.ts`).
 *
 * It is never chosen by accident: the app may offer it only when `fakeBackendSelected(process.env)` is
 * true, which needs both MASTHEAD_BACKEND=fake and MASTHEAD_ALLOW_FAKE=1.
 */
import { randomUUID } from 'node:crypto';
import { EFFORTS, type Effort } from '../../../shared/protocol.js';
import type { Backend, BackendCaps, BackendInfo, Content, ModelInfo, Session, SessionEvents, SessionSpec } from '../types.js';
import { plan, type Step } from './script.js';

export { plan, type Step } from './script.js';

/** True only when the environment asks for the fake on purpose. */
export function fakeBackendSelected(env: Record<string, string | undefined>): boolean {
  return env.MASTHEAD_BACKEND === 'fake' && env.MASTHEAD_ALLOW_FAKE === '1';
}

export const FAKE_CAPS: BackendCaps = {
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
};

export const FAKE_MODELS: ModelInfo[] = [
  { id: 'fake-large', label: 'Fake Large', efforts: [...EFFORTS], nativeEffort: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }, contextWindow: 200_000, default: true },
  { id: 'fake-small', label: 'Fake Small', efforts: ['low', 'medium', 'high'], nativeEffort: { low: 'low', medium: 'medium', high: 'high' }, contextWindow: 100_000 },
];

export interface FakeOptions {
  caps?: Partial<BackendCaps>;
  models?: ModelInfo[];
  /** Pause between steps, in ms. 0 (default) keeps unit tests fast; the browser test may use more. */
  stepMs?: number;
  /** How long a "slow" turn runs, so messages can arrive during it. */
  slowMs?: number;
  /** How long a background task runs before it finishes, unless the message says. */
  backgroundMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A 1×1 red PNG. */
export const FAKE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

export class FakeBackend implements Backend {
  readonly id = 'fake';
  readonly label = 'Fake backend';
  readonly caps: BackendCaps;
  readonly sessions: FakeSession[] = [];
  /** Session id -> what the session remembers (its last reply word), as a CLI's session files would. */
  readonly stored = new Map<string, { lastWord: string | null }>();
  readonly opts: Required<Omit<FakeOptions, 'caps' | 'models'>>;
  private modelList: ModelInfo[];

  constructor(opts: FakeOptions = {}) {
    this.caps = { ...FAKE_CAPS, ...opts.caps };
    this.modelList = opts.models ?? FAKE_MODELS;
    this.opts = { stepMs: opts.stepMs ?? 0, slowMs: opts.slowMs ?? 150, backgroundMs: opts.backgroundMs ?? 50 };
  }

  async detect(): Promise<BackendInfo> {
    return { id: this.id, label: this.label, available: true, path: null, version: 'fake-1', signedIn: true };
  }

  async models(): Promise<ModelInfo[]> {
    return this.modelList.map((m) => ({ ...m, efforts: [...m.efforts], nativeEffort: { ...m.nativeEffort } }));
  }

  open(spec: SessionSpec, events: SessionEvents): Session {
    const s = new FakeSession(this, spec, events);
    this.sessions.push(s);
    return s;
  }

  /** Deletes a stored session, as if its file were removed. */
  forget(sessionId: string): void {
    this.stored.delete(sessionId);
  }
}

interface Queued {
  id: string;
  content: Content;
}

export class FakeSession implements Session {
  readonly received: Queued[] = [];
  sessionId: string | null = null;
  effort: Effort;
  model: string;
  closed: 'graceful' | 'now' | null = null;
  readonly ended: Promise<void>;
  private end!: () => void;
  private queue: Queued[] = [];
  private running = false;
  /** Ids consumed by the turn that is running now. */
  private current: Queued[] | null = null;
  private interruptRequested = false;
  private turns = 0;
  private background = new Set<string>();
  private dead = false;

  constructor(
    private backend: FakeBackend,
    readonly spec: SessionSpec,
    private ev: SessionEvents,
  ) {
    this.effort = spec.effort;
    this.model = spec.model;
    this.ended = new Promise<void>((r) => (this.end = r));
    queueMicrotask(() => this.boot());
  }

  private get step(): number {
    return this.backend.opts.stepMs;
  }

  private boot(): void {
    if (this.dead) return;
    if (this.spec.resume !== undefined) {
      if (!this.backend.stored.has(this.spec.resume)) {
        this.dead = true;
        this.ev.exited({ failure: `No session found with id ${this.spec.resume}`, sessionMissing: true });
        this.end();
        return;
      }
      this.sessionId = this.spec.resume;
    } else {
      this.sessionId = `fake-${randomUUID()}`;
      this.backend.stored.set(this.sessionId, { lastWord: null });
    }
    this.ev.sessionStarted(this.sessionId);
    void this.pump();
  }

  send(id: string, content: Content): void {
    if (this.dead || this.closed) return;
    const m = { id, content };
    this.received.push(m);
    if (this.current && this.backend.caps.midTurnDelivery) this.current.push(m);
    else this.queue.push(m);
    void this.pump();
  }

  async interrupt(): Promise<void> {
    if (this.current) this.interruptRequested = true;
    this.abortAsks();
  }

  /** Approval requests still open; withdrawn when the turn is interrupted or the session closed at once. */
  private asks = new Set<AbortController>();
  private abortAsks(): void {
    for (const c of this.asks) c.abort();
    this.asks.clear();
  }

  setEffort(effort: Effort): void {
    this.effort = effort;
  }

  setModel(model: string): void {
    this.model = model;
  }

  close(how: 'graceful' | 'now'): void {
    if (this.closed) return;
    this.closed = how;
    // Asked to close: no exited event (that is only for an unexpected end). Graceful lets the running
    // turn finish, as a CLI does when its input ends; now stops at once.
    this.queue = [];
    if (how === 'now' || !this.running) {
      this.dead = true;
      this.abortAsks();
      queueMicrotask(() => this.end());
    }
  }

  async contextUsage(): Promise<{ used: number; max: number }> {
    const max = FAKE_MODELS.find((m) => m.id === this.model)?.contextWindow;
    return { used: 1000 + this.turns * 500, max: max ?? 200_000 };
  }

  private memory() {
    return this.backend.stored.get(this.sessionId ?? '') ?? { lastWord: null };
  }

  private async pump(): Promise<void> {
    if (this.running || this.dead || !this.sessionId) return;
    this.running = true;
    try {
      while (!this.dead && this.queue.length > 0) {
        const batch = this.queue.splice(0);
        await this.turn(batch, false);
      }
    } finally {
      this.running = false;
      this.finishGracefulClose();
    }
  }

  private finishGracefulClose(): void {
    if (this.closed === 'graceful' && !this.dead) {
      this.dead = true;
      this.end();
    }
  }

  private textOf(content: Content): string {
    if (typeof content === 'string') return content;
    return content.map((p) => (p.type === 'text' ? p.text : `[image ${p.mediaType}]`)).join('\n');
  }

  /** Runs one turn. `selfStarted` turns consume nothing (as when a background task finishes). */
  private async turn(batch: Queued[], selfStarted: boolean, selfText?: string): Promise<void> {
    this.current = batch;
    this.interruptRequested = false;
    this.turns += 1;
    this.ev.turnStarted();
    const parts: string[] = [];
    let error: string | undefined;
    let apiError: string | undefined;
    let interrupted = false;
    const done = new Set<string>();
    try {
      if (selfText !== undefined) parts.push(selfText);
      // Messages that arrive during the turn join `batch` and are planned when reached.
      for (let i = 0; i < batch.length; i++) {
        const msg = batch[i]!;
        done.add(msg.id);
        for (const step of plan(this.textOf(msg.content), { hasImage: typeof msg.content !== 'string' && msg.content.some((p) => p.type === 'image') })) {
          if (this.dead) return;
          if (this.interruptRequested) {
            interrupted = true;
            break;
          }
          const r = await this.run(step);
          if (this.interruptRequested) {
            interrupted = true;
            break;
          }
          if (r.text) parts.push(r.text);
          if (r.error) {
            error = r.error;
            apiError = r.apiError;
          }
          if (r.crash) {
            this.dead = true;
            this.current = null;
            this.ev.exited({ failure: 'The fake process crashed.' });
            this.end();
            return;
          }
          if (r.stopTurn) break;
        }
        if (interrupted) break;
      }
    } finally {
      this.current = null;
    }
    if (this.dead) return;
    const text = interrupted ? '' : parts.join('\n\n');
    if (text) {
      await this.stream(text);
      this.ev.text(text, error !== undefined);
    }
    this.ev.usage({ context: 1000 + this.turns * 500, output: text.length });
    const consumed = !this.backend.caps.consumedIds ? null : selfStarted ? [] : batch.filter((m) => done.has(m.id) || interrupted).map((m) => m.id);
    this.ev.turnEnded({ consumed, text, error, apiError, interrupted });
  }

  private async stream(text: string): Promise<void> {
    for (let i = 0; i < text.length; i += 40) {
      this.ev.draft({ kind: 'text', append: text.slice(i, i + 40) });
      if (this.step) await sleep(this.step);
    }
    this.ev.draft(null);
  }

  private async run(step: Step): Promise<{ text?: string; error?: string; apiError?: string; crash?: boolean; stopTurn?: boolean }> {
    if (this.step) await sleep(this.step);
    switch (step.kind) {
      case 'reply':
        return { text: step.text };
      case 'word': {
        this.memory().lastWord = step.word;
        return { text: step.word };
      }
      case 'recall':
        return { text: this.memory().lastWord ?? 'I do not remember any word.' };
      case 'think':
        this.ev.draft({ kind: 'thinking', append: step.text });
        this.ev.draft(null);
        this.ev.thinking(step.text);
        return {};
      case 'tool': {
        const def = this.spec.tools.find((t) => t.name === step.name);
        const id = `tool-${randomUUID()}`;
        this.ev.toolStarted({ id, name: step.name, input: step.input });
        if (!def) {
          this.ev.toolFinished({ id, result: `No such tool: ${step.name}`, isError: true });
          return { text: `The tool ${step.name} does not exist.` };
        }
        try {
          const result = await def.run(step.input);
          this.ev.toolFinished({ id, result, isError: result.startsWith('Error:') });
          return { text: `Tool result: ${result}` };
        } catch (e) {
          const msg = (e as Error)?.message || String(e);
          this.ev.toolFinished({ id, result: msg, isError: true });
          return { text: `The tool failed: ${msg}` };
        }
      }
      case 'image': {
        const id = `tool-${randomUUID()}`;
        this.ev.toolStarted({ id, name: 'Screenshot', input: {} });
        this.ev.toolFinished({ id, result: 'A screenshot.', isError: false, images: [{ type: 'image', mediaType: 'image/png', data: FAKE_PNG }] });
        return { text: 'I took a screenshot.' };
      }
      case 'command':
      case 'question': {
        const id = `tool-${randomUUID()}`;
        const name = step.kind === 'command' ? 'Bash' : 'AskUserQuestion';
        const input = step.kind === 'command' ? { command: step.command } : { questions: [{ question: 'Which colour?', options: [{ label: 'teal' }, { label: 'red' }] }] };
        if (step.kind === 'question' && !this.spec.canAskPerson) return { text: 'I may not ask the person.' };
        this.ev.toolStarted({ id, name, input });
        const ctl = new AbortController();
        this.asks.add(ctl);
        const answer = await this.ev.askPermission({
          kind: step.kind,
          toolName: name,
          input,
          title: step.kind === 'command' ? `Run ${step.command}` : 'A question for you',
          canAlways: step.kind === 'command' && this.backend.caps.approvalsAlways,
          questions: step.kind === 'question' ? (input as { questions: never }).questions : undefined,
          signal: ctl.signal,
        });
        this.asks.delete(ctl);
        if (ctl.signal.aborted) return { stopTurn: true };
        if (answer.decision === 'deny') {
          this.ev.toolFinished({ id, result: answer.message ?? 'Denied.', isError: true });
          return { text: 'Permission denied.' };
        }
        if (step.kind === 'question') {
          const a = answer.answers?.['Which colour?'] ?? '(no answer)';
          this.ev.toolFinished({ id, result: a, isError: false });
          return { text: `COLOUR=${a}` };
        }
        this.ev.toolFinished({ id, result: `ran: ${step.command}`, isError: false });
        return { text: `Ran ${step.command}${answer.decision === 'always' ? ' (always allowed)' : ''}.` };
      }
      case 'slow':
        await sleep(this.backend.opts.slowMs);
        return { text: step.text };
      case 'background': {
        const taskId = `bg-${randomUUID().slice(0, 8)}`;
        this.background.add(taskId);
        this.ev.background([...this.background]);
        const ms = step.ms ?? this.backend.opts.backgroundMs;
        setTimeout(() => void this.finishBackground(taskId, step.silent), ms);
        return { text: `Started a background task (${taskId}).` };
      }
      case 'limit':
        this.ev.rateLimit({ status: 'rejected', type: 'five_hour', utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + step.seconds });
        return { error: "You've hit your usage limit.", apiError: 'rate_limit', stopTurn: true };
      case 'error':
        return { error: step.message, stopTurn: true };
      case 'crash':
        return { crash: true };
    }
  }

  private async finishBackground(taskId: string, silent: boolean): Promise<void> {
    if (this.dead || !this.background.delete(taskId)) return;
    this.ev.background([...this.background]);
    if (silent) return; // the task list empties and no turn follows
    // Claude Code starts a turn by itself to tell the agent; wait for any running turn first.
    while (this.running && !this.dead) await sleep(5);
    if (this.dead) return;
    this.running = true;
    try {
      await this.turn([], true, `The background task ${taskId} finished.`);
      while (!this.dead && this.queue.length > 0) await this.turn(this.queue.splice(0), false);
    } finally {
      this.running = false;
      this.finishGracefulClose();
    }
  }
}
