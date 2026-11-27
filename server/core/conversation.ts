import { randomUUID } from 'node:crypto';
import type { Backend, PermissionAnswer, PermissionAsk, ToolDef } from '../backends/types.js';
import {
  CLAUDE_PROFILE,
  EFFORTS,
  childTierOf,
  findTier,
  modelLabel,
  agentName,
  capEffort,
  effortRank,
  type AgentInfo,
  type BlobRef,
  type ConversationMeta,
  type Draft,
  type Effort,
  type ImageAttachment,
  type Item,
  type RateLimitNotice,
  type Settings,
  type Tier,
  type TierSpec,
} from '../../shared/protocol.js';
import { Agent, clip, type AgentHost, type TurnOutcome } from '../runtime/agent.js';
import { initial, live, statusOf, step, type AgentState, type Effect, type Event, type StopBy } from './machine.js';
import { messageEnvelope, reportEnvelope } from './prompts.js';
import type { Scheduler } from './scheduler.js';
import type { StoredConversation } from '../storage/store.js';
import { teamToolDefs, type TeamActions } from './tools.js';

/** What a conversation needs from the app around it. */
export interface ConversationHost {
  readonly scheduler: Scheduler;
  settings(): Settings;
  claudePath(): string | null;
  agentChanged(conv: Conversation, agent: Agent): void;
  itemChanged(conv: Conversation, agent: Agent, item: Item): void;
  draftChanged(conv: Conversation, agent: Agent, draft: Draft | null): void;
  metaChanged(conv: Conversation): void;
  rateLimit(notice: RateLimitNotice): void;
  askPermission(conv: Conversation, agent: Agent, ask: PermissionAsk): Promise<PermissionAnswer>;
  cancelPermissions(agentId: string): void;
  /** The backend agents run on, when not the default Claude Code (the fake, in tests and CI). */
  backend?(tier: string): Backend | undefined;
  /** Stores an image from a tool result as a blob of this conversation. */
  storeImage?(convId: string, data: string, mediaType: string): { ref: unknown } | { error: string };
  /** Tests replace the clock; the app uses the real one. */
  clock?: Clock;
}

/** Time and a repeating timer, so tests can run the pause and run-time rules without sleeping. */
export interface Clock {
  /** Wall-clock time (ms since 1970): deadlines such as a usage limit's reset time. */
  now(): number;
  /**
   * Time the machine was awake, for durations (run-time limit, background cap, "running for 3m"):
   * a suspend or sleep must not count. Defaults to `now`.
   */
  active?(): number;
  /** Calls `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
}

/**
 * An awake-time clock: it advances with the wall clock but by at most ACTIVE_STEP_MS per reading, and
 * an unref'd timer reads it every 15 s, so a sleep shows up as one capped gap. (performance.now() is
 * not used: whether it pauses during suspend differs between systems.)
 */
const ACTIVE_STEP_MS = 60_000;
let activeBase = Date.now();
let activeLastWall = activeBase;
/** Conversations to tell when the clock sees the computer was asleep. */
const sleepWatchers = new Set<(from: number, to: number) => void>();
function activeNow(): number {
  const wall = Date.now();
  const gap = wall - activeLastWall;
  activeBase += Math.min(Math.max(0, gap), ACTIVE_STEP_MS);
  // A gap the 15 s reader cannot explain: the computer was asleep (above the step, so jitter never counts).
  if (gap > ACTIVE_STEP_MS) for (const w of sleepWatchers) w(activeLastWall, wall);
  activeLastWall = wall;
  return activeBase;
}
let activeTimer: NodeJS.Timeout | null = null;

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  active() {
    if (!activeTimer) {
      activeTimer = setInterval(activeNow, 15_000);
      activeTimer.unref?.();
    }
    return activeNow();
  },
  every(ms, fn) {
    const h = setInterval(fn, ms);
    h.unref?.();
    return () => clearInterval(h);
  },
};

/** How often paused agents and the run-time limit are checked. */
const TICK_MS = 30_000;
/** How long a sub-agent may wait on background commands alone before it is finished anyway. */
const BACKGROUND_WAIT_MS = 10 * 60_000;

/** From Agent: when the limit resets, and whether closing the process at the limit ended background commands. */
type UsageLimit = { resetsAt?: number; backgroundStopped?: boolean };

function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The error of an agent cut off by a shutdown or restart; `restartNote()` finds such agents by it. */
const CLOSED_WHILE_WORKING = 'Masthead was closed while this agent was working.';
/** What that error becomes once the lead has been told, so it is told only once. */
const CLOSED_LEAD_TOLD = 'Masthead was closed while this agent was working. The lead was told.';

/** Effects that would tell a parent about a child stopped as part of stopping the parent itself. */
const QUIET: ReadonlySet<Effect['type']> = new Set(['report', 'childEndedQuietly', 'stopChildren']);
/** At shutdown nothing is told or shown: the state is saved as it ends. */
const SHUTDOWN: ReadonlySet<Effect['type']> = new Set(['report', 'childEndedQuietly', 'stopChildren', 'notice']);

const MAX_AGENTS = 200;
const MAX_AGENT_MESSAGES = 1000;
const TASK_PREVIEW = 400;

function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'agent';
}

/** "45s", "12m", "3h05m". */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? 'New conversation';
  const clean = line.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

/**
 * One conversation: the lead the person talks to and every agent started under it.
 *
 * The conversation owns the rules of the team. Agents can only start the tier directly below them,
 * reports travel up to whoever started an agent, messages can go to anyone, and effort changes go
 * through the agent above.
 */
export class Conversation implements AgentHost, TeamActions {
  readonly agents = new Map<string, Agent>();
  private agentMessages = 0;
  /**
   * Each agent's life-cycle state (server/core/machine.ts): phase, what it waits for (children, an
   * answer, background work, a usage-limit pause, approvals), its report debt, run clock and whether
   * the person stopped it. Every change goes through `apply()`, which runs `step()` and carries out its
   * effects. The stop marks are saved with the conversation, like the message counter.
   */
  private states = new Map<string, AgentState>();
  /** Messages from agents to a paused agent, delivered in order when the pause ends. */
  private held = new Map<string, string[]>();
  /** Cancels the shared 30 s timer; null while nothing needs watching. */
  private stopTimer: (() => void) | null = null;

  private readonly sleepWatcher = (from: number, to: number) => this.wokeFromSleep(from, to);

  private constructor(
    readonly meta: ConversationMeta,
    private host: ConversationHost,
  ) {
    if (!host.clock) {
      sleepWatchers.add(this.sleepWatcher);
      REAL_CLOCK.active?.(); // starts the 15 s reader that notices a sleep
    }
  }

  /**
   * The clock saw that the computer was asleep from `from` to `to` (wall clock). If this conversation was
   * working, its lead's transcript says so; the time asleep never counts as running time either way.
   */
  wokeFromSleep(from: number, to: number): void {
    if (!this.busy()) return;
    this.lead.addItem({ kind: 'notice', level: 'info', text: `This computer was asleep from ${clockTime(from)} to ${clockTime(to)}; work carried on afterwards.` });
  }

  /** A new conversation on team profile `profileId` (default: the settings' default profile). */
  static create(host: ConversationHost, cwd: string, profileId?: string): Conversation {
    const id = randomUUID();
    const leadId = randomUUID();
    const now = Date.now();
    const s = host.settings();
    const profile = s.profiles.find((p) => p.id === profileId) ?? s.profiles.find((p) => p.id === s.defaultProfile) ?? s.profiles.find((p) => p.id === CLAUDE_PROFILE)!;
    const leadTier = profile.tiers[0]!;
    const conv = new Conversation({ id, title: 'New conversation', cwd, createdAt: now, updatedAt: now, leadId, profileId: profile.id }, host);
    conv.addAgent(
      // `as Tier`: AgentInfo.tier keeps the Claude union for the page until web W7; profile tier ids are strings.
      new Agent(conv.newInfo({ id: leadId, name: agentName(0), tier: leadTier.id as Tier, parentId: null, title: '', task: '', status: 'idle', effort: s.autoEffort ? 'low' : leadTier.effort }), conv),
    );
    return conv;
  }

  /** Rebuilds a conversation saved by an earlier run. Nothing is running afterwards. */
  static restore(host: ConversationHost, stored: StoredConversation): Conversation {
    const conv = new Conversation(stored.meta, host);
    for (const a of stored.agents) {
      const info = { ...a.info, title: a.info.title ?? '', activity: undefined, waitingFor: undefined, pausedUntil: undefined };
      if (info.status === 'queued' || info.status === 'running' || info.status === 'waiting') {
        // The app was closed while this agent was working.
        info.status = info.parentId === null ? 'idle' : 'stopped';
        if (info.parentId !== null) info.error = CLOSED_WHILE_WORKING;
      }
      // Nobody is waiting for a report after a restart; a parent that messages the agent asks for one again.
      conv.agents.set(info.id, new Agent(info, conv, { sessionId: a.sessionId, owesReport: false, seed: a.sessionId ? null : (a.seed ?? null) }));
    }
    const stopped = Array.isArray(stored.stoppedByPerson) ? stored.stoppedByPerson : [];
    for (const id of stopped) {
      const a = typeof id === 'string' ? conv.agents.get(id) : undefined;
      if (a) conv.st(a).stoppedByPerson = true;
    }
    const sent = stored.agentMessages;
    if (typeof sent === 'number' && Number.isFinite(sent)) conv.agentMessages = Math.min(MAX_AGENT_MESSAGES, Math.max(0, Math.trunc(sent)));
    const note = conv.restartNote();
    // Deferred: the app only keeps items of a conversation it has registered, which happens after this returns.
    if (note) queueMicrotask(() => conv.lead.addItem({ kind: 'notice', level: 'info', text: note.text }));
    return conv;
  }

  /**
   * Agents cut off by a shutdown or restart that the lead has not been told about. Derived from the
   * stored error text, so it survives being saved and further restarts until the lead is told.
   */
  private restartNote(): { text: string; agents: Agent[] } | null {
    const agents = [...this.agents.values()].filter((a) => a.status === 'stopped' && a.info.error === CLOSED_WHILE_WORKING);
    if (agents.length === 0) return null;
    const names = agents.map((a) => `${a.name}${a.info.title ? ` (${a.info.title})` : ''}`).join(', ');
    return { text: `Masthead was restarted; these agents were stopped while working: ${names}. Message one to resume it.`, agents };
  }

  toStored(): StoredConversation {
    return {
      meta: { ...this.meta, busy: undefined },
      agents: [...this.agents.values()].map((a) => ({ info: a.info, sessionId: a.sessionId, owesReport: a.owesReport, ...(a.pendingSeed ? { seed: a.pendingSeed } : {}) })),
      stoppedByPerson: [...this.states].filter(([id, st]) => st.stoppedByPerson && this.agents.has(id)).map(([id]) => id),
      agentMessages: this.agentMessages,
    };
  }

  get lead(): Agent {
    return this.agents.get(this.meta.leadId)!;
  }

  /** True while any agent in the conversation is working. */
  busy(): boolean {
    for (const a of this.agents.values()) if (a.live) return true;
    return false;
  }

  infos(): AgentInfo[] {
    return [...this.agents.values()].map((a) => a.info);
  }

  private newInfo(p: { id: string; name: string; tier: Tier; parentId: string | null; title: string; task: string; status: AgentInfo['status']; effort: Effort }): AgentInfo {
    return {
      ...p,
      convId: this.meta.id,
      model: this.spec(p.tier).model,
      createdAt: Date.now(),
      usage: { context: 0, contextMax: 1_000_000, output: 0, costUsd: 0, turns: 0 },
    };
  }

  private addAgent(agent: Agent): void {
    this.agents.set(agent.id, agent);
    this.agentChanged(agent);
  }

  private touch(): void {
    this.meta.updatedAt = Date.now();
    this.host.metaChanged(this);
  }

  private children(agent: Agent): Agent[] {
    return [...this.agents.values()].filter((a) => a.info.parentId === agent.id);
  }

  private liveChildren(agent: Agent): Agent[] {
    return this.children(agent).filter((a) => a.live);
  }

  private parent(agent: Agent): Agent | null {
    return agent.info.parentId ? (this.agents.get(agent.info.parentId) ?? null) : null;
  }

  /** The lead is the agent nobody started (with profiles its tier id is not always `lead`). */
  private isLead(agent: Agent): boolean {
    return agent.info.parentId === null;
  }

  /**
   * A tier's settings from its profile. A tier whose profile was deleted reads as switched off, keeping
   * its name, so its agents still show and can be stopped but no new ones start.
   */
  private spec(tier: string): TierSpec {
    return findTier(this.host.settings(), tier) ?? { id: tier, label: tier, backend: 'claude-code', model: '', effort: 'low', max: 0, lean: true, colour: 'slate' };
  }

  private isAncestor(ancestor: Agent, agent: Agent): boolean {
    for (let p = this.parent(agent); p; p = this.parent(p)) if (p === ancestor) return true;
    return false;
  }

  private find(name: string, relativeTo?: Agent): Agent | null {
    const key = name.trim().toLowerCase();
    if (relativeTo && key === 'parent') return this.parent(relativeTo);
    if (key === 'lead') return this.lead;
    for (const a of this.agents.values()) if (a.name === key) return a;
    const s = slug(name);
    for (const a of this.agents.values()) if (a.name === s) return a;
    return null;
  }

  // ---- the person ----

  /** A message typed by the person, to the lead or straight to another agent. */
  userSend(text: string, images: ImageAttachment[] | undefined, agentId?: string, refs?: BlobRef[]): void {
    const target = (agentId && this.agents.get(agentId)) || this.lead;
    if (this.meta.title === 'New conversation' && target === this.lead && text.trim()) this.meta.title = titleFrom(text);
    target.addItem({ kind: 'user', text, ...(refs?.length ? { images: refs } : images?.length ? { images: images.length } : {}) });
    if (this.tierOff(target)) {
      target.addItem({ kind: 'notice', level: 'error', text: `${this.label(target.tier)} agents are switched off in the settings. Turn them on to wake "${target.name}".` });
      return;
    }
    // The person clears a stop mark; answering a waiting agent directly ends its wait.
    this.apply(target, { type: 'Woken', by: 'person', parentCanReceive: false });
    if (this.st(target).holds.answer) this.apply(target, { type: 'AnswerArrived' }, { busy: true });
    let content = text;
    const note = target === this.lead ? this.restartNote() : null;
    if (note) {
      // Told with the person's next message, so the lead spends no turn of its own on it.
      content = `[${note.text}]\n\n${text}`;
      for (const a of note.agents) {
        a.info.error = CLOSED_LEAD_TOLD;
        this.agentChanged(a);
      }
    }
    // The person may know the limit is gone: their message goes through at once, unlike agents' messages,
    // after what agents sent it meanwhile, in order.
    if (this.st(target).holds.pause) {
      const held = this.held.get(target.id) ?? [];
      this.held.delete(target.id);
      for (const m of held) target.deliver(m);
    }
    this.apply(target, { type: 'Input', from: 'person' });
    target.deliver(Agent.imageContent(content, images));
    this.touch();
  }

  /** Stops the lead's current turn. Agents it started keep working. */
  async interruptLead(): Promise<void> {
    await this.lead.interrupt();
  }

  /** Stops one agent and everything under it. Only the person calls this. */
  stopAgent(agentId: string, why: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (this.isLead(agent)) {
      for (const c of this.children(agent)) this.stopTree(c, why, 'person');
      void agent.interrupt();
      // The lead keeps its session; its pause ends, and if it was only waiting on those agents it goes idle.
      this.apply(agent, { type: 'Stop', by: 'person', why });
      return;
    }
    for (const c of this.children(agent)) this.stopTree(c, why, 'person');
    this.host.cancelPermissions(agent.id);
    const fx = this.apply(agent, { type: 'Stop', by: 'person', why });
    const parent = this.parent(agent);
    // A finished agent sends nothing, but a parent waiting only on it still has to move on.
    if (parent && !fx.some((f) => f.type === 'report' || f.type === 'childEndedQuietly')) this.settle(parent);
  }

  stopAll(): void {
    this.stopAgent(this.lead.id, 'Stopped by the person.');
    this.settle(this.lead);
  }

  /** A sub-agent that is not running and whose tier is off: it could only queue for ever. */
  private tierOff(agent: Agent): boolean {
    return !this.isLead(agent) && !agent.live && this.spec(agent.tier).max <= 0;
  }

  /**
   * Stops `agent` and everything under it as part of stopping an agent above (children first). Nobody
   * below the stopped agent reports or settles a parent: those parents are being stopped too.
   */
  private stopTree(agent: Agent, why: string, by: StopBy): void {
    for (const c of this.children(agent)) this.stopTree(c, why, by);
    if (!agent.live) return;
    this.host.cancelPermissions(agent.id);
    this.apply(agent, { type: 'Stop', by: by === 'person' ? 'person' : 'agent', why }, { drop: QUIET });
  }

  /** Ends every process when the app shuts down. */
  shutdown(): void {
    sleepWatchers.delete(this.sleepWatcher);
    this.stopTimer?.();
    this.stopTimer = null;
    for (const a of this.agents.values()) {
      // Through the machine, so it and the runtime agree the agent ended (quietly: the app is closing).
      if (!this.isLead(a) && a.live) this.apply(a, { type: 'Stop', by: 'restart', why: CLOSED_WHILE_WORKING }, { drop: SHUTDOWN });
      else a.dispose();
    }
    const lead = this.lead;
    if (lead.status !== 'idle') lead.setStatus('idle');
  }

  // ---- AgentHost ----

  get cwd(): string {
    return this.meta.cwd;
  }
  get scheduler(): Scheduler {
    return this.host.scheduler;
  }
  settings(): Settings {
    return this.host.settings();
  }
  backend(agent: Agent): Backend | undefined {
    return this.host.backend?.(agent.tier);
  }
  /** What the agent's backend supports, for the tools (effort levels); all four when no backend is known. */
  caps(agent: Agent): { efforts: Effort[] } {
    return this.backend(agent)?.caps ?? { efforts: [...EFFORTS] };
  }
  storeImage(_agent: Agent, data: string, mediaType: string): { ref: unknown } | { error: string } {
    return this.host.storeImage ? this.host.storeImage(this.meta.id, data, mediaType) : { error: 'images are not stored here' };
  }
  claudePath(): string | null {
    return this.host.claudePath();
  }
  parentName(agent: Agent): string | null {
    return this.parent(agent)?.name ?? null;
  }
  tools(agent: Agent): ToolDef[] {
    return teamToolDefs(agent, this);
  }
  agentChanged(agent: Agent): void {
    // The runtime changes the status itself when it starts a process or a turn; the machine follows.
    const st = this.states.get(agent.id);
    if (st && statusOf(st) !== agent.status) this.apply(agent, { type: 'Status', status: agent.status });
    if (!agent.live) this.held.delete(agent.id);
    this.host.agentChanged(this, agent);
  }

  itemChanged(agent: Agent, item: Item): void {
    this.host.itemChanged(this, agent, item);
  }
  draftChanged(agent: Agent, draft: Draft | null): void {
    this.host.draftChanged(this, agent, draft);
  }
  rateLimit(notice: RateLimitNotice): void {
    this.host.rateLimit(notice);
  }
  askPermission(agent: Agent, ask: PermissionAsk): Promise<PermissionAnswer> {
    // Time spent waiting for the person's approval does not count toward the run-time limit.
    this.apply(agent, { type: 'ApprovalOpened' });
    const done = () => void this.apply(agent, { type: 'ApprovalClosed' });
    const p = this.host.askPermission(this, agent, ask);
    p.then(done, done);
    return p;
  }

  turnEnded(agent: Agent, outcome: TurnOutcome): void {
    this.touch();
    const usageLimit = (outcome as { usageLimit?: UsageLimit }).usageLimit;
    const fx = this.apply(agent, { type: 'TurnEnded', text: outcome.text, error: outcome.error, interrupted: outcome.interrupted, usageLimit });
    const st = this.st(agent);
    if (st.holds.pause) return;
    if (this.isLead(agent)) void agent.refreshContext();
    // Its turn is over: agents waiting for its answer are reminded, or told there is none.
    if (st.phase !== 'ended' && !fx.some((f) => f.type === 'end')) this.checkWaitsOn(agent, outcome.interrupted);
  }

  processLost(agent: Agent, message: string, usageLimit?: UsageLimit): void {
    this.host.cancelPermissions(agent.id);
    // At a usage limit the agent pauses instead of failing; it resumes (and takes a slot again) later.
    this.apply(agent, { type: 'ProcessLost', error: message, usageLimit });
  }

  /** Background commands ended and no new turn followed: move the agent on if nothing else holds it. */
  backgroundIdle(agent: Agent): void {
    this.apply(agent, { type: 'BackgroundIdle' });
  }

  /** Settings changed: running agents take what they can at once (effort ceiling, model of the lead, …). */
  settingsChanged(): void {
    const s = this.host.settings();
    for (const a of this.agents.values()) (a as { applySettings?: (s: Settings) => void }).applySettings?.(s);
    // A run-time limit set now applies to agents already running, from the next tick.
    this.ensureTimer();
  }

  // ---- the state machine ----

  /** The agent's state, made from what the agent shows when the conversation first sees it. */
  private st(agent: Agent): AgentState {
    let s = this.states.get(agent.id);
    if (!s) {
      s = initial(this.isLead(agent));
      s.owesReport = agent.owesReport;
      const status = agent.status;
      if (status === 'done' || status === 'failed' || status === 'stopped') {
        s.phase = 'ended';
        s.end = { kind: status, ...(agent.info.error !== undefined ? { error: agent.info.error } : {}) };
      } else s.phase = status;
      if (live(s)) {
        s.liveSince = this.active();
        if (s.phase === 'running') s.run.since = s.liveSince;
      }
      this.states.set(agent.id, s);
    }
    return s;
  }

  /**
   * Runs one event through the agent's machine and carries out its effects. Facts the conversation
   * and the runtime own (live children, background work, the report debt) are read fresh first.
   */
  private apply(agent: Agent, ev: Event, opts: { busy?: boolean; inTurn?: boolean; drop?: ReadonlySet<Effect['type']> } = {}): Effect[] {
    const prev = this.st(agent);
    prev.holds.children = this.liveChildren(agent).length;
    prev.holds.background = this.hasBackgroundWork(agent) ? 1 : 0;
    prev.owesReport = agent.owesReport;
    const { state, effects } = step(prev, ev, {
      now: this.active(),
      wall: this.now(),
      busy: opts.busy ?? agent.busy,
      ...(opts.inTurn !== undefined ? { inTurn: opts.inTurn } : {}),
      autoEffort: this.host.settings().autoEffort,
      lastText: agent.lastText,
    });
    this.states.set(agent.id, state);
    agent.owesReport = state.owesReport;
    this.show(agent, state, ev.type !== 'Status');
    for (const f of effects) if (!opts.drop?.has(f.type)) this.exec(agent, f, state);
    if (!this.stopTimer) this.ensureTimer();
    return effects;
  }

  /** What the page sees: the machine's waiting/idle status, the agent it waits for, the pause. */
  private show(agent: Agent, st: AgentState, push: boolean): void {
    const waitingFor = st.holds.answer ? this.agents.get(st.holds.answer.from)?.name : undefined;
    const pausedUntil = st.holds.pause?.until;
    const changed = agent.info.waitingFor !== waitingFor || agent.info.pausedUntil !== pausedUntil;
    agent.info.waitingFor = waitingFor;
    agent.info.pausedUntil = pausedUntil;
    // queued/running are the runtime's to show (it starts the process); ended comes with the `end` effect.
    // A status the runtime just reported is not overwritten (a paused agent the person woke shows running).
    if (push && (st.phase === 'waiting' || st.phase === 'idle') && agent.status !== st.phase) agent.setStatus(st.phase);
    else if (changed) this.host.agentChanged(this, agent);
  }

  private exec(agent: Agent, f: Effect, st: AgentState): void {
    switch (f.type) {
      case 'send': // delivery is done by the caller, which has the content (deliverTo)
      case 'pauseRuntime': // held messages are kept here (`held`) until the pause ends
        return;
      case 'notice':
        agent.addItem({ kind: 'notice', level: f.level ?? 'info', text: f.text });
        return;
      case 'end':
        agent.end(f.kind, f.error);
        // Nobody can wait for its answer any more.
        this.releaseWaitsOn(agent);
        return;
      case 'setEffortLow':
        agent.setEffort('low');
        return;
      case 'releaseSlot':
        this.scheduler.release(agent.tier, agent.id);
        return;
      case 'dropHeld':
        this.held.delete(agent.id);
        (agent as { dropHeld?: () => void }).dropHeld?.();
        return;
      case 'resumeRuntime': {
        const held = this.held.get(agent.id) ?? [];
        this.held.delete(agent.id);
        for (const m of held) agent.deliver(m);
        if (f.note) agent.deliver(f.note);
        return;
      }
      case 'stopChildren':
        for (const c of this.liveChildren(agent)) this.stopTree(c, f.why ?? `"${agent.name}" ended before this agent finished.`, 'agent');
        return;
      case 'report': {
        const parent = this.parent(agent);
        if (parent) this.report(parent, agent, f.status, f.text);
        return;
      }
      case 'childEndedQuietly': {
        const parent = this.parent(agent);
        if (parent) this.settle(parent);
        return;
      }
      case 'remind': // batched per recipient by checkWaitsOn
        return;
      case 'noAnswer': {
        const r = this.agents.get(f.from);
        const name = r?.name ?? f.from;
        agent.addItem({ kind: 'notice', level: 'info', text: `No answer from "${name}".` });
        this.deliverTo(agent, `No answer from "${name}"; carry on with your best judgment or report what you have.`, 'masthead');
        return;
      }
      case 'save':
        this.host.metaChanged(this);
        return;
      default:
        void st;
    }
  }

  /** Delivers a message from an agent or from Masthead; held while the recipient is paused at a usage limit. */
  private deliverTo(agent: Agent, content: string, from: 'agent' | 'masthead'): void {
    this.apply(agent, { type: 'Input', from });
    if (this.st(agent).holds.pause) {
      const list = this.held.get(agent.id) ?? [];
      list.push(content);
      this.held.set(agent.id, list);
    } else agent.deliver(content);
  }

  /** A sub-agent under `agent` ended without a report: if `agent` was only waiting on it, move it on. */
  private settle(agent: Agent): void {
    this.apply(agent, { type: 'ChildEnded', reported: false });
  }

  private report(parent: Agent, child: Agent, status: string, text: string): void {
    const canReceive = this.isLead(parent) || parent.live;
    if (!canReceive) return;
    parent.addItem({ kind: 'inbound', via: 'report', from: child.name, text: text.trim() || '(no report text)', status: child.status });
    this.deliverTo(parent, reportEnvelope(child.name, child.tier, status, text), 'agent');
  }

  private hasBackgroundWork(agent: Agent): boolean {
    return (agent as { hasBackgroundWork?: boolean }).hasBackgroundWork === true;
  }

  // ---- clocks and the shared timer ----

  private now(): number {
    return (this.host.clock ?? REAL_CLOCK).now();
  }

  /** Awake time, for durations (see Clock.active). */
  private active(): number {
    const c = this.host.clock ?? REAL_CLOCK;
    return c.active ? c.active() : c.now();
  }

  private needsTimer(): boolean {
    const runLimit = this.host.settings().maxRunMinutes > 0;
    for (const a of this.agents.values()) {
      const st = this.states.get(a.id);
      if (st?.holds.pause || st?.holds.backgroundSince !== undefined) return true;
      if (runLimit && a.live && !this.isLead(a)) return true;
    }
    return false;
  }

  private ensureTimer(): void {
    if (!this.stopTimer && this.needsTimer()) this.stopTimer = (this.host.clock ?? REAL_CLOCK).every(TICK_MS, () => this.tick());
  }

  /** Every 30 s: resume agents whose usage limit has reset, the background cap, and the run-time limit. */
  tick(): void {
    const maxRunMs = this.host.settings().maxRunMinutes * 60_000;
    for (const a of [...this.agents.values()]) {
      if (!this.states.has(a.id)) continue;
      // Already in a turn (the person woke it): the pause just ends; a note would cost an extra turn.
      this.apply(a, { type: 'Tick', maxRunMs, backgroundCapMs: BACKGROUND_WAIT_MS }, { inTurn: a.status === 'running' && a.busy });
    }
    if (!this.needsTimer()) {
      this.stopTimer?.();
      this.stopTimer = null;
    }
  }

  // ---- waiting for an answer ----

  /**
   * `r`'s turn ended. Agents waiting for its answer get one reminder sent to it. After that, a non-lead
   * recipient's askers are told there is no answer, so nobody waits for ever; the lead's keep waiting,
   * since the lead may be asking the person, who can also answer them directly. If the person
   * interrupted the turn, the askers are told at once.
   */
  private checkWaitsOn(r: Agent, interrupted: boolean): void {
    const remind: Agent[] = [];
    for (const waiter of this.waitersOn(r)) {
      const fx = this.apply(waiter, { type: 'RecipientTurnEnded', recipientIsLead: this.isLead(r), interrupted });
      if (fx.some((f) => f.type === 'remind')) remind.push(waiter);
    }
    if (remind.length === 0) return;
    const names = remind.map((a) => `"${a.name}"`).join(', ');
    r.addItem({ kind: 'notice', level: 'info', text: `Reminded: ${names} still waiting for an answer.` });
    const are = remind.length > 1 ? 'are' : 'is';
    this.deliverTo(
      r,
      this.isLead(r)
        ? `${names} ${are} still waiting for your answer. Answer with send_message, or ask the person; it keeps waiting.`
        : `${names} ${are} still waiting for your answer. Reply with send_message, even if only to say you cannot help.`,
      'masthead',
    );
  }

  /** `r` ended: nobody can wait for its answer any more. */
  private releaseWaitsOn(r: Agent): void {
    for (const waiter of this.waitersOn(r)) this.apply(waiter, { type: 'RecipientEnded' });
  }

  private waitersOn(r: Agent): Agent[] {
    return [...this.agents.values()].filter((a) => this.states.get(a.id)?.holds.answer?.from === r.id);
  }

  // ---- TeamActions: what the agents' tools do ----

  autoEffort(): boolean {
    return this.host.settings().autoEffort;
  }

  childTier(tier: Tier): Tier | null {
    return childTierOf(this.host.settings(), tier) as Tier | null;
  }

  /** The name of the model a tier is set to, as agents and people read it. */
  label(tier: Tier): string {
    return this.spec(tier).label || modelLabel(this.spec(tier).model);
  }

  spawn(parent: Agent, rawTitle: string, task: string, effort: Effort | undefined): string {
    const tier = childTierOf(this.host.settings(), parent.tier) as Tier | null;
    if (!tier) return `Error: ${this.label(parent.tier)} agents cannot start other agents.`;
    const s = this.host.settings();
    const cap = this.spec(tier).max;
    if (cap <= 0) return `Error: ${this.label(tier)} agents are switched off in the settings. Do this work yourself.`;
    if (this.agents.size >= MAX_AGENTS) return `Error: this conversation already has ${MAX_AGENTS} agents. Reuse one with send_message.`;
    if (!task.trim()) return 'Error: the task is empty.';

    // Names are handed out in order, so the person can call any agent by a name they can say.
    let index = this.agents.size;
    let name = agentName(index);
    while (this.find(name)) name = agentName(++index);
    const title = rawTitle.replace(/\s+/g, ' ').trim().slice(0, 60);

    const ceiling = this.spec(tier).effort;
    const startEffort = s.autoEffort ? capEffort(effort ?? 'low', ceiling) : ceiling;
    const info = this.newInfo({ id: randomUUID(), name, tier, parentId: parent.id, title, task: clip(task.trim(), TASK_PREVIEW), status: 'queued', effort: startEffort });
    const agent = new Agent(info, this, { owesReport: true, seed: task });
    this.states.set(agent.id, initial(false));
    const willQueue = this.scheduler.running(tier) >= cap || this.scheduler.queued(tier) > 0;
    this.addAgent(agent);
    agent.addItem({ kind: 'inbound', via: 'task', from: parent.name, text: task });
    agent.start();
    this.touch();
    return `Started ${this.label(tier)} agent "${name}"${title ? ` (${title})` : ''} at ${startEffort} effort${willQueue ? ` (queued: ${cap} may run at once)` : ''}. Its report will arrive as a message when it finishes.`;
  }

  message(from: Agent, to: string, text: string, wait = false): string {
    const target = this.find(to, from);
    if (!target) return `Error: there is no agent named "${to}". Use list_agents to see the names.`;
    if (target === from) return 'Error: that is you.';
    if (!target.live && this.st(target).stoppedByPerson) return `Error: the person stopped "${target.name}"; only they can wake it.`;
    if (this.tierOff(target)) return `Error: ${this.label(target.tier)} agents are switched off in the settings, so "${target.name}" cannot be woken.`;
    if (this.agentMessages >= MAX_AGENT_MESSAGES) return 'Error: this conversation has reached its limit of messages between agents.';
    this.agentMessages++;
    const wasLive = target.live;
    const statusBefore = target.status;
    const parent = this.parent(target);
    // A woken sub-agent owes its parent a fresh report, whoever woke it, if the parent can still receive
    // one (as in report()). An agent that is already live keeps the debt it has, so nothing is reported twice.
    const reportsTo = !wasLive && parent && (this.isLead(parent) || parent.live) ? parent : null;
    if (!wasLive && !this.isLead(target)) this.apply(target, { type: 'Woken', by: 'agent', parentCanReceive: reportsTo !== null });
    // Any message from the agent someone waits on is its answer (it is read in the turn this message starts).
    if (this.st(target).holds.answer?.from === from.id) this.apply(target, { type: 'AnswerArrived' }, { busy: true });
    // Only a sub-agent may wait, and only for its parent or the lead, who are bound to see the question.
    const waits = wait && !this.isLead(from) && (target === this.parent(from) || target === this.lead);
    if (waits) this.apply(from, { type: 'Asked', from: target.id });
    target.addItem({ kind: 'inbound', via: 'message', from: from.name, text });
    if (waits && target === this.lead) {
      target.addItem({ kind: 'notice', level: 'info', text: `"${from.name}" is waiting for an answer to this. You can also answer it yourself by messaging ${from.name} directly.` });
    }
    // A message from the parent is answered by the report; anyone else needs send_message.
    this.deliverTo(target, messageEnvelope(from.name, from.tier, text, waits ? 'wait' : parent !== from ? 'reply' : undefined), 'agent');
    this.touch();
    const state = this.isLead(target) ? 'the lead' : wasLive ? statusBefore : `was ${statusBefore}, now resuming`;
    const where = reportsTo && reportsTo !== from ? ` Its report goes to "${reportsTo.name}"; it answers you only with send_message.` : '';
    const waitNote = waits
      ? ' End your turn when you have nothing else to do; you resume when the answer arrives.'
      : wait
        ? ' (Not waiting: you can wait only for your parent or the lead.)'
        : '';
    return `Delivered to "${target.name}" (${state}).${where}${waitNote}`;
  }

  list(viewer: Agent): string {
    const now = this.now();
    const awake = this.active();
    const lines = [...this.agents.values()].map((a) => {
      const by = this.parent(a)?.name;
      const you = a === viewer ? ' (you)' : '';
      const job = a.info.title || a.info.task.replace(/\s+/g, ' ').slice(0, 120);
      const task = job ? ` — ${job}` : '';
      const st = this.st(a);
      const w = a.live ? st.holds.answer : undefined;
      let state: string = a.status;
      if (w) state = w.from === viewer.id ? 'waiting for your answer' : `waiting for an answer from ${this.agents.get(w.from)?.name ?? '?'}`;
      if (st.holds.pause) state = `paused until ${clockTime(st.holds.pause.until)} (usage limit)`;
      const bg = st.holds.backgroundSince;
      if (bg !== undefined) state = `waiting on a background command for ${duration(awake - bg)}`;
      if (a.status === 'running' && a.info.activity) state += `: ${a.info.activity}`;
      const facts = [state];
      const since = st.liveSince;
      if (a.live && since !== undefined) facts.push(`for ${duration(awake - since)}`);
      else if (a.info.endedAt) facts.push(`ended ${duration(now - a.info.endedAt)} ago`);
      if (a.info.usage.context > 0) facts.push(`${Math.round(a.info.usage.context / 1000)}k ctx`);
      if (a.info.usage.costUsd > 0) facts.push(`$${a.info.usage.costUsd.toFixed(2)}`);
      facts.push(`${a.info.effort} effort`);
      if (by) facts.push(`started by ${by}`);
      return `- ${a.name}${you}: ${this.label(a.tier)}, ${facts.join(', ')}${task}`;
    });
    return lines.join('\n');
  }

  stop(caller: Agent, name: string): string {
    const target = this.find(name, caller);
    if (!target) return `Error: there is no agent named "${name}".`;
    if (!this.isAncestor(caller, target)) return `Error: you can only stop agents started by you or below you.`;
    if (!target.live) return `"${target.name}" is not running (${target.status}).`;
    // The caller asked for this, so it does not need a report about it (row 24); its parent may move on.
    for (const c of this.children(target)) this.stopTree(c, `Stopped by "${caller.name}".`, 'agent');
    this.host.cancelPermissions(target.id);
    this.apply(target, { type: 'Stop', by: 'agent', why: `Stopped by "${caller.name}".` });
    return `Stopped "${target.name}" and everything under it.`;
  }

  setOwnEffort(agent: Agent, level: Effort, reason: string): string {
    const s = this.host.settings();
    if (!s.autoEffort) return 'Error: automatic effort is switched off in the settings.';
    const ceiling = this.spec(agent.tier).effort;
    const current = agent.info.effort;
    if (level === current) return `You are already at ${current} effort.`;
    if (effortRank(level) > effortRank(ceiling)) return `Error: ${this.label(agent.tier)} agents may go up to ${ceiling} effort; you are at ${current}. The person sets that limit.`;
    const lowering = effortRank(level) < effortRank(current);
    const parent = this.parent(agent);
    if (lowering || !parent) {
      agent.setEffort(level);
      agent.addItem({ kind: 'notice', level: 'info', text: `Effort ${lowering ? 'lowered' : 'raised'} to ${level}: ${reason}` });
      return `Effort ${lowering ? 'lowered' : 'raised'} from ${current} to ${level}, from your next step on.`;
    }
    if (!(this.isLead(parent) || parent.live)) {
      return `Error: "${parent.name}" is no longer running, so nobody can approve this. Stay at ${current}.`;
    }
    if (this.agentMessages >= MAX_AGENT_MESSAGES) return 'Error: this conversation has reached its limit of messages between agents.';
    const text = `Effort request: "${agent.name}" asks to go from ${current} to ${level} effort.\nReason: ${reason}\nApprove with set_agent_effort (name "${agent.name}", level "${level}"), choose another level, or decline with send_message.`;
    this.agentMessages++;
    this.host.metaChanged(this); // the counter is saved
    parent.addItem({ kind: 'inbound', via: 'message', from: agent.name, text });
    this.deliverTo(parent, messageEnvelope(agent.name, agent.tier, text), 'agent');
    agent.addItem({ kind: 'notice', level: 'info', text: `Asked "${parent.name}" for ${level} effort: ${reason}` });
    return `Asked "${parent.name}" to raise you from ${current} to ${level}. Keep working at ${current}; if approved, the change applies by itself.`;
  }

  setAgentEffort(caller: Agent, name: string, level: Effort): string {
    const s = this.host.settings();
    if (!s.autoEffort) return 'Error: automatic effort is switched off in the settings.';
    const target = this.find(name, caller);
    if (!target) return `Error: there is no agent named "${name}".`;
    if (!this.isAncestor(caller, target)) return 'Error: you can only set the effort of agents started by you or below you.';
    const ceiling = this.spec(target.tier).effort;
    if (effortRank(level) > effortRank(ceiling)) return `Error: ${this.label(target.tier)} agents may go up to ${ceiling} effort. The person sets that limit.`;
    const before = target.info.effort;
    if (before === level) return `"${target.name}" is already at ${level} effort.`;
    target.setEffort(level);
    // Not sent as a message: that would force an extra turn, whose reply could replace the agent's report.
    target.addItem({ kind: 'notice', level: 'info', text: `Effort set to ${level} by "${caller.name}" (was ${before}).` });
    return `"${target.name}" ${effortRank(level) > effortRank(before) ? 'raised' : 'lowered'} from ${before} to ${level} effort.`;
  }
}
