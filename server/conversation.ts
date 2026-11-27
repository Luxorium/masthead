import { randomUUID } from 'node:crypto';
import type { CanUseTool, McpSdkServerConfigWithInstance, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  CHILD_TIER,
  modelLabel,
  agentName,
  capEffort,
  effortRank,
  type AgentInfo,
  type ConversationMeta,
  type Draft,
  type Effort,
  type ImageAttachment,
  type Item,
  type RateLimitNotice,
  type Settings,
  type Tier,
} from '../shared/protocol.js';
import { Agent, clip, type AgentHost, type TurnOutcome } from './agent.js';
import { messageEnvelope, reportEnvelope } from './prompts.js';
import type { Scheduler } from './scheduler.js';
import type { StoredConversation } from './store.js';
import { teamTools, type TeamActions } from './tools.js';

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
  askPermission(conv: Conversation, agent: Agent, toolName: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]): Promise<PermissionResult>;
  cancelPermissions(agentId: string): void;
}

/** The error of an agent cut off by a shutdown or restart; `restartNote()` finds such agents by it. */
const CLOSED_WHILE_WORKING = 'Masthead was closed while this agent was working.';
/** What that error becomes once the lead has been told, so it is told only once. */
const CLOSED_LEAD_TOLD = 'Masthead was closed while this agent was working. The lead was told.';

/** An agent waiting for an answer from its parent or the lead (send_message with wait). */
interface Wait {
  to: string;
  /** The recipient's turn already ended once without answering and it was reminded. */
  reminded: boolean;
}

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
   * Agents the person stopped. Other agents may not wake them; the person still can, which clears the
   * mark. Kept in memory only, so after a restart any agent can wake them again.
   */
  private stoppedByPerson = new Set<string>();
  /** Waiting agent id -> whom it waits for. In memory only: a restart stops every waiting agent anyway. */
  private waits = new Map<string, Wait>();
  /** When each live agent last became live, for list(). */
  private liveSince = new Map<string, number>();

  private constructor(
    readonly meta: ConversationMeta,
    private host: ConversationHost,
  ) {}

  static create(host: ConversationHost, cwd: string): Conversation {
    const id = randomUUID();
    const leadId = randomUUID();
    const now = Date.now();
    const conv = new Conversation({ id, title: 'New conversation', cwd, createdAt: now, updatedAt: now, leadId }, host);
    const s = host.settings();
    conv.addAgent(
      new Agent(conv.newInfo({ id: leadId, name: agentName(0), tier: 'lead', parentId: null, title: '', task: '', status: 'idle', effort: s.autoEffort ? 'low' : s.tiers.lead.effort }), conv),
    );
    return conv;
  }

  /** Rebuilds a conversation saved by an earlier run. Nothing is running afterwards. */
  static restore(host: ConversationHost, stored: StoredConversation): Conversation {
    const conv = new Conversation(stored.meta, host);
    for (const a of stored.agents) {
      const info = { ...a.info, title: a.info.title ?? '', activity: undefined, waitingFor: undefined };
      if (info.status === 'queued' || info.status === 'running' || info.status === 'waiting') {
        // The app was closed while this agent was working.
        info.status = info.tier === 'lead' ? 'idle' : 'stopped';
        if (info.tier !== 'lead') info.error = CLOSED_WHILE_WORKING;
      }
      // Nobody is waiting for a report after a restart; a parent that messages the agent asks for one again.
      conv.agents.set(info.id, new Agent(info, conv, { sessionId: a.sessionId, owesReport: false, seed: a.sessionId ? null : (a.seed ?? null) }));
    }
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
      model: this.host.settings().tiers[p.tier].model,
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
  userSend(text: string, images: ImageAttachment[] | undefined, agentId?: string): void {
    const target = (agentId && this.agents.get(agentId)) || this.lead;
    if (this.meta.title === 'New conversation' && target === this.lead && text.trim()) this.meta.title = titleFrom(text);
    target.addItem({ kind: 'user', text, ...(images?.length ? { images: images.length } : {}) });
    if (this.tierOff(target)) {
      target.addItem({ kind: 'notice', level: 'error', text: `${this.label(target.tier)} agents are switched off in the settings. Turn them on to wake "${target.name}".` });
      return;
    }
    this.stoppedByPerson.delete(target.id);
    // The person answering a waiting agent directly ends its wait.
    this.clearWait(target.id);
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
    this.markStoppedByPerson(agent);
    if (agent.tier === 'lead') {
      for (const c of this.children(agent)) this.stopTree(c, why);
      void agent.interrupt();
      // If the lead was only waiting on those agents, nothing else would wake it.
      this.settle(agent);
      return;
    }
    const parent = this.parent(agent);
    const wasLive = agent.live;
    const owed = agent.owesReport;
    this.stopTree(agent, why);
    if (wasLive && owed && parent) this.report(parent, agent, 'stopped', why);
    else if (parent) this.settle(parent);
  }

  stopAll(): void {
    this.stopAgent(this.lead.id, 'Stopped by the person.');
    this.settle(this.lead);
  }

  private markStoppedByPerson(agent: Agent): void {
    if (agent.tier !== 'lead') this.stoppedByPerson.add(agent.id);
    for (const c of this.children(agent)) this.markStoppedByPerson(c);
  }

  /** A sub-agent that is not running and whose tier is off: it could only queue for ever. */
  private tierOff(agent: Agent): boolean {
    return agent.tier !== 'lead' && !agent.live && this.host.settings().tiers[agent.tier].max <= 0;
  }

  private stopTree(agent: Agent, why: string): void {
    for (const c of this.children(agent)) this.stopTree(c, why);
    if (!agent.live) return;
    this.host.cancelPermissions(agent.id);
    agent.owesReport = false;
    this.clearWait(agent.id);
    agent.end('stopped', why);
    agent.addItem({ kind: 'notice', level: 'info', text: why });
    this.releaseWaitsOn(agent);
  }

  /** Ends every process when the app shuts down. */
  shutdown(): void {
    for (const a of this.agents.values()) {
      if (a.tier !== 'lead' && a.live) a.end('stopped', CLOSED_WHILE_WORKING);
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
  claudePath(): string | null {
    return this.host.claudePath();
  }
  parentName(agent: Agent): string | null {
    return this.parent(agent)?.name ?? null;
  }
  tools(agent: Agent): McpSdkServerConfigWithInstance {
    return teamTools(agent, this);
  }
  agentChanged(agent: Agent): void {
    if (!agent.live) this.liveSince.delete(agent.id);
    else if (!this.liveSince.has(agent.id)) this.liveSince.set(agent.id, Date.now());
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
  askPermission(agent: Agent, toolName: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    return this.host.askPermission(this, agent, toolName, input, opts);
  }

  turnEnded(agent: Agent, outcome: TurnOutcome): void {
    this.touch();
    if (outcome.interrupted) agent.addItem({ kind: 'notice', level: 'info', text: 'Stopped.' });
    else if (outcome.error) agent.addItem({ kind: 'notice', level: 'error', text: outcome.error });

    if (agent.tier === 'lead') {
      agent.setStatus(this.mustWait(agent) ? 'waiting' : 'idle');
      void agent.refreshContext();
      this.checkWaitsOn(agent, outcome.interrupted);
      return;
    }
    if (!outcome.error && this.mustWait(agent)) {
      // Waiting for agents it started, for an answer, or for its background commands: not finished.
      agent.setStatus('waiting');
      this.checkWaitsOn(agent, outcome.interrupted);
      return;
    }
    this.finish(agent, outcome.error ? 'failed' : 'done', outcome.text, outcome.error);
  }

  /** Whether an agent whose turn ended still has something coming that will wake it. (The lead never waits for an answer.) */
  private mustWait(agent: Agent): boolean {
    return this.liveChildren(agent).length > 0 || this.waits.has(agent.id) || this.hasBackgroundWork(agent);
  }

  private hasBackgroundWork(agent: Agent): boolean {
    return (agent as { hasBackgroundWork?: boolean }).hasBackgroundWork === true;
  }

  /** Background commands ended and no new turn followed: move the agent on if nothing else holds it. */
  backgroundIdle(agent: Agent): void {
    this.settle(agent);
  }

  /** Settings changed: running agents take what they can at once (effort ceiling, model of the lead, …). */
  settingsChanged(): void {
    const s = this.host.settings();
    for (const a of this.agents.values()) (a as { applySettings?: (s: Settings) => void }).applySettings?.(s);
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
    for (const [id, w] of this.waits) {
      if (w.to !== r.id) continue;
      const waiter = this.agents.get(id);
      if (!waiter?.live) this.clearWait(id);
      else if (interrupted || (w.reminded && r.tier !== 'lead')) this.noAnswer(waiter, r);
      else if (w.reminded) continue;
      else {
        w.reminded = true;
        remind.push(waiter);
      }
    }
    if (remind.length === 0) return;
    const names = remind.map((a) => `"${a.name}"`).join(', ');
    r.addItem({ kind: 'notice', level: 'info', text: `Reminded: ${names} still waiting for an answer.` });
    const are = remind.length > 1 ? 'are' : 'is';
    r.deliver(
      r.tier === 'lead'
        ? `${names} ${are} still waiting for your answer. Answer with send_message, or ask the person; it keeps waiting.`
        : `${names} ${are} still waiting for your answer. Reply with send_message, even if only to say you cannot help.`,
    );
  }

  private clearWait(id: string): void {
    if (!this.waits.delete(id)) return;
    const a = this.agents.get(id);
    if (a && a.info.waitingFor !== undefined) {
      a.info.waitingFor = undefined;
      this.agentChanged(a);
    }
  }

  /** `r` ended: nobody can wait for its answer any more. */
  private releaseWaitsOn(r: Agent): void {
    for (const [id, w] of this.waits) {
      if (w.to !== r.id) continue;
      const waiter = this.agents.get(id);
      if (waiter?.live) this.noAnswer(waiter, r);
      else this.clearWait(id);
    }
  }

  private noAnswer(waiter: Agent, r: Agent): void {
    this.clearWait(waiter.id);
    waiter.addItem({ kind: 'notice', level: 'info', text: `No answer from "${r.name}".` });
    waiter.deliver(`No answer from "${r.name}"; carry on with your best judgment or report what you have.`);
  }

  processLost(agent: Agent, message: string): void {
    this.host.cancelPermissions(agent.id);
    agent.addItem({ kind: 'notice', level: 'error', text: message });
    this.scheduler.release(agent.tier, agent.id);
    if (agent.tier === 'lead') {
      // Agents waiting for the lead's answer keep waiting: the person can still answer them.
      agent.setStatus(this.mustWait(agent) ? 'waiting' : 'idle');
      return;
    }
    this.finish(agent, 'failed', '', message);
  }

  /** A sub-agent is finished: close it, tell whoever is waiting for it. */
  private finish(agent: Agent, status: 'done' | 'failed', text: string, error?: string): void {
    for (const c of this.liveChildren(agent)) this.stopTree(c, `"${agent.name}" ended before this agent finished.`);
    const owed = agent.owesReport;
    agent.owesReport = false;
    this.clearWait(agent.id);
    agent.end(status, error);
    this.releaseWaitsOn(agent);
    const parent = this.parent(agent);
    if (!parent) return;
    if (owed) this.report(parent, agent, status, status === 'failed' ? `The agent failed: ${error ?? 'unknown error'}${text ? `\n\nIts last message:\n${text}` : ''}` : text);
    else this.settle(parent);
  }

  private report(parent: Agent, child: Agent, status: string, text: string): void {
    const canReceive = parent.tier === 'lead' || parent.live;
    if (!canReceive) return;
    parent.addItem({ kind: 'inbound', via: 'report', from: child.name, text: text.trim() || '(no report text)', status: child.status });
    parent.deliver(reportEnvelope(child.name, child.tier, status, text));
  }

  /**
   * Called when an agent under `agent` stopped being live without sending a report. If `agent` was
   * only waiting on it, nothing else will wake it, so move it on.
   */
  private settle(agent: Agent): void {
    if (agent.status !== 'waiting' || agent.busy) return;
    if (this.mustWait(agent)) return;
    if (agent.tier === 'lead') agent.setStatus('idle');
    else this.finish(agent, 'done', agent.lastText);
  }

  // ---- TeamActions: what the agents' tools do ----

  autoEffort(): boolean {
    return this.host.settings().autoEffort;
  }

  /** The name of the model a tier is set to, as agents and people read it. */
  label(tier: Tier): string {
    return modelLabel(this.host.settings().tiers[tier].model);
  }

  spawn(parent: Agent, rawTitle: string, task: string, effort: Effort | undefined): string {
    const tier = CHILD_TIER[parent.tier];
    if (!tier) return 'Error: Haiku agents cannot start other agents.';
    const s = this.host.settings();
    const cap = s.tiers[tier].max;
    if (cap <= 0) return `Error: ${this.label(tier)} agents are switched off in the settings. Do this work yourself.`;
    if (this.agents.size >= MAX_AGENTS) return `Error: this conversation already has ${MAX_AGENTS} agents. Reuse one with send_message.`;
    if (!task.trim()) return 'Error: the task is empty.';

    // Names are handed out in order, so the person can call any agent by a name they can say.
    let index = this.agents.size;
    let name = agentName(index);
    while (this.find(name)) name = agentName(++index);
    const title = rawTitle.replace(/\s+/g, ' ').trim().slice(0, 60);

    const ceiling = s.tiers[tier].effort;
    const startEffort = s.autoEffort ? capEffort(effort ?? 'low', ceiling) : ceiling;
    const info = this.newInfo({ id: randomUUID(), name, tier, parentId: parent.id, title, task: clip(task.trim(), TASK_PREVIEW), status: 'queued', effort: startEffort });
    const agent = new Agent(info, this, { owesReport: true, seed: task });
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
    if (!target.live && this.stoppedByPerson.has(target.id)) return `Error: the person stopped "${target.name}"; only they can wake it.`;
    if (this.tierOff(target)) return `Error: ${this.label(target.tier)} agents are switched off in the settings, so "${target.name}" cannot be woken.`;
    if (this.agentMessages >= MAX_AGENT_MESSAGES) return 'Error: this conversation has reached its limit of messages between agents.';
    this.agentMessages++;
    const wasLive = target.live;
    const statusBefore = target.status;
    const parent = this.parent(target);
    // A woken sub-agent owes its parent a fresh report, whoever woke it, if the parent can still receive
    // one (as in report()). An agent that is already live keeps the debt it has, so nothing is reported twice.
    const reportsTo = !wasLive && parent && (parent.tier === 'lead' || parent.live) ? parent : null;
    if (reportsTo) target.owesReport = true;
    // Any message from the agent someone waits on is its answer.
    if (this.waits.get(target.id)?.to === from.id) this.clearWait(target.id);
    // Only a sub-agent may wait, and only for its parent or the lead, who are bound to see the question.
    const waits = wait && from.tier !== 'lead' && (target === this.parent(from) || target === this.lead);
    if (waits) {
      this.waits.set(from.id, { to: target.id, reminded: false });
      from.info.waitingFor = target.name;
      this.agentChanged(from);
    }
    target.addItem({ kind: 'inbound', via: 'message', from: from.name, text });
    if (waits && target === this.lead) {
      target.addItem({ kind: 'notice', level: 'info', text: `"${from.name}" is waiting for an answer to this. You can also answer it yourself by messaging ${from.name} directly.` });
    }
    // A message from the parent is answered by the report; anyone else needs send_message.
    target.deliver(messageEnvelope(from.name, from.tier, text, waits ? 'wait' : parent !== from ? 'reply' : undefined));
    this.touch();
    const state = target.tier === 'lead' ? 'the lead' : wasLive ? statusBefore : `was ${statusBefore}, now resuming`;
    const where = reportsTo && reportsTo !== from ? ` Its report goes to "${reportsTo.name}"; it answers you only with send_message.` : '';
    const waitNote = waits
      ? ' End your turn when you have nothing else to do; you resume when the answer arrives.'
      : wait
        ? ' (Not waiting: you can wait only for your parent or the lead.)'
        : '';
    return `Delivered to "${target.name}" (${state}).${where}${waitNote}`;
  }

  list(viewer: Agent): string {
    const now = Date.now();
    const lines = [...this.agents.values()].map((a) => {
      const by = this.parent(a)?.name;
      const you = a === viewer ? ' (you)' : '';
      const job = a.info.title || a.info.task.replace(/\s+/g, ' ').slice(0, 120);
      const task = job ? ` — ${job}` : '';
      const w = a.live ? this.waits.get(a.id) : undefined;
      let state: string = a.status;
      if (w) state = w.to === viewer.id ? 'waiting for your answer' : `waiting for an answer from ${this.agents.get(w.to)?.name ?? '?'}`;
      if (a.status === 'running' && a.info.activity) state += `: ${a.info.activity}`;
      const facts = [state];
      const since = this.liveSince.get(a.id);
      if (a.live && since) facts.push(`for ${duration(now - since)}`);
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
    // The caller asked for this, so it does not need a report about it.
    target.owesReport = false;
    this.stopTree(target, `Stopped by "${caller.name}".`);
    const parent = this.parent(target);
    if (parent && parent !== caller) this.settle(parent);
    return `Stopped "${target.name}" and everything under it.`;
  }

  setOwnEffort(agent: Agent, level: Effort, reason: string): string {
    const s = this.host.settings();
    if (!s.autoEffort) return 'Error: automatic effort is switched off in the settings.';
    const ceiling = s.tiers[agent.tier].effort;
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
    if (!(parent.tier === 'lead' || parent.live)) {
      return `Error: "${parent.name}" is no longer running, so nobody can approve this. Stay at ${current}.`;
    }
    const text = `Effort request: "${agent.name}" asks to go from ${current} to ${level} effort.\nReason: ${reason}\nApprove with set_agent_effort (name "${agent.name}", level "${level}"), choose another level, or decline with send_message.`;
    this.agentMessages++;
    parent.addItem({ kind: 'inbound', via: 'message', from: agent.name, text });
    parent.deliver(messageEnvelope(agent.name, agent.tier, text));
    agent.addItem({ kind: 'notice', level: 'info', text: `Asked "${parent.name}" for ${level} effort: ${reason}` });
    return `Asked "${parent.name}" to raise you from ${current} to ${level}. Keep working at ${current}; if approved, the change applies by itself.`;
  }

  setAgentEffort(caller: Agent, name: string, level: Effort): string {
    const s = this.host.settings();
    if (!s.autoEffort) return 'Error: automatic effort is switched off in the settings.';
    const target = this.find(name, caller);
    if (!target) return `Error: there is no agent named "${name}".`;
    if (!this.isAncestor(caller, target)) return 'Error: you can only set the effort of agents started by you or below you.';
    const ceiling = s.tiers[target.tier].effort;
    if (effortRank(level) > effortRank(ceiling)) return `Error: ${this.label(target.tier)} agents may go up to ${ceiling} effort. The person sets that limit.`;
    const before = target.info.effort;
    if (before === level) return `"${target.name}" is already at ${level} effort.`;
    target.setEffort(level);
    // Not sent as a message: that would force an extra turn, whose reply could replace the agent's report.
    target.addItem({ kind: 'notice', level: 'info', text: `Effort set to ${level} by "${caller.name}" (was ${before}).` });
    return `"${target.name}" ${effortRank(level) > effortRank(before) ? 'raised' : 'lowered'} from ${before} to ${level} effort.`;
  }
}
