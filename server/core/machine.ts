/**
 * The life cycle of one agent as a pure state machine (0.2.0 Core 3, docs/plans/0.2.0/core.md §3).
 *
 * `step(state, event, ctx)` returns the next state and the effects the shell (Conversation) must carry
 * out. Nothing here touches a process, a timer, the disk or another agent: effects that involve other
 * agents (reports, reminders, stopping children) are requests the shell fulfils by feeding events to
 * those agents' machines. Every transition is a row of the table in core.md §3.3 and has a test in
 * test/machine.test.ts.
 */
import type { AgentStatus } from '../../shared/protocol.js';

export type Phase = 'queued' | 'running' | 'waiting' | 'idle' | 'ended';
export type EndKind = 'done' | 'failed' | 'stopped';
export type StopBy = 'person' | 'agent' | 'limit' | 'restart';

/** Why a 'waiting' agent is not finished. Several can hold at once. */
export interface Holds {
  /** Live agents it started. */
  children: number;
  /** It asked its parent or the lead with send_message and wait. */
  answer?: { from: string; reminded: boolean };
  /** Background commands its backend reports as running. */
  background: number;
  /** Since when it has waited on background work alone (sub-agents; for the cap). */
  backgroundSince?: number;
  /** Paused at a usage limit. */
  pause?: { until: number; personWoke: boolean; backgroundStopped: boolean };
  /** Approval cards open (only while running); the run-time clock stops meanwhile. */
  approvals: number;
}

export interface AgentState {
  lead: boolean;
  phase: Phase;
  end?: { kind: EndKind; error?: string; by?: StopBy };
  holds: Holds;
  owesReport: boolean;
  /** Usage-limit pauses in a row; reset by a turn that gets through. */
  limitStreak: number;
  /** Run-time clock for the current piece of work: counts only 'running' with no approval open. */
  run: { ms: number; since?: number };
  liveSince?: number;
  /** The person stopped it while it was working; other agents may not wake it. Persisted. */
  stoppedByPerson: boolean;
}

export type UsageLimit = { resetsAt?: number; backgroundStopped?: boolean };

export type Event =
  | { type: 'Spawned' }
  | { type: 'Launched' }
  | { type: 'LaunchFailed'; error: string }
  | { type: 'Input'; from: 'agent' | 'person' | 'masthead' }
  | { type: 'TurnStarted' }
  | { type: 'TurnEnded'; text: string; error?: string; interrupted: boolean; usageLimit?: UsageLimit }
  | { type: 'ProcessLost'; error: string; usageLimit?: UsageLimit }
  | { type: 'Asked'; from: string }
  | { type: 'AnswerArrived' }
  | { type: 'RecipientTurnEnded'; recipientIsLead: boolean; interrupted: boolean }
  | { type: 'RecipientEnded' }
  | { type: 'ChildStarted' }
  | { type: 'ChildEnded'; reported: boolean }
  | { type: 'Background'; active: number }
  | { type: 'BackgroundIdle' }
  | { type: 'Tick'; maxRunMs: number; backgroundCapMs: number }
  | { type: 'Stop'; by: StopBy; why: string }
  | { type: 'ApprovalOpened' }
  | { type: 'ApprovalClosed' }
  | { type: 'Woken'; by: 'person' | 'agent'; parentCanReceive: boolean }
  | { type: 'Restored' }
  /** The runtime changed the agent's status itself (it started a process, a turn began, it was ended). */
  | { type: 'Status'; status: AgentStatus };

export type Effect =
  /** Let the runtime send what was delivered; `urgent` passes a pause (the person's own messages). */
  | { type: 'send'; urgent: boolean }
  | { type: 'report'; status: EndKind; text: string }
  | { type: 'end'; kind: EndKind; error?: string }
  | { type: 'setEffortLow' }
  | { type: 'releaseSlot' }
  | { type: 'pauseRuntime' }
  | { type: 'resumeRuntime'; note: string | null }
  | { type: 'dropHeld' }
  /** Stop its live children; `why` defaults to '"<name>" ended before this agent finished.' */
  | { type: 'stopChildren'; why?: string }
  | { type: 'notice'; text: string; level?: 'info' | 'error' }
  /** Ask the agent it waits on to answer (the shell batches reminders per recipient). */
  | { type: 'remind'; recipient: string }
  | { type: 'noAnswer'; from: string }
  /** Tell its parent it ended without a report, so a parent waiting only on it can move on. */
  | { type: 'childEndedQuietly' }
  | { type: 'save' };

export interface Ctx {
  /** Awake time: run clock, live-since, background cap (a sleep must not count). */
  now: number;
  /** Wall-clock time for deadlines (a usage limit's reset); defaults to `now`. */
  wall?: number;
  /** The agent is in a turn right now (the shell knows better than the phase); defaults to running && busy. */
  inTurn?: boolean;
  /** The runtime still has input no finished turn has consumed (or a start pending). */
  busy: boolean;
  /** Automatic effort is on (effort goes back to low after a piece of work). */
  autoEffort: boolean;
  /** Its last run's text, used when it finishes without a turn of its own (holds released). */
  lastText: string;
}

export const DEFAULT_PAUSE_MS = 15 * 60_000;
export const MAX_PAUSES = 3;
export const BACKGROUND_CLOSED = 'A background command was still running when Masthead closed this agent.';
export const RESUME_NOTE = 'The usage limit has reset. Carry on from where you stopped.';
export const BACKGROUND_STOPPED_NOTE = ' Background commands you had running were stopped.';

export function initial(lead: boolean): AgentState {
  return {
    lead,
    phase: lead ? 'idle' : 'queued',
    holds: { children: 0, background: 0, approvals: 0 },
    owesReport: !lead,
    limitStreak: 0,
    run: { ms: 0 },
    stoppedByPerson: false,
  };
}

export function live(s: AgentState): boolean {
  return s.phase === 'queued' || s.phase === 'running' || s.phase === 'waiting';
}

/** Anything that still has to happen before a waiting agent may finish. */
export function holding(s: AgentState): boolean {
  const h = s.holds;
  return h.children > 0 || h.answer !== undefined || h.background > 0 || h.pause !== undefined;
}

/** A sub-agent waiting on background work alone. */
export function backgroundOnly(s: AgentState): boolean {
  const h = s.holds;
  return !s.lead && s.phase === 'waiting' && h.background > 0 && h.children === 0 && !h.answer && !h.pause;
}

export type WaitReason = 'paused' | 'approval' | 'answer' | 'children' | 'background';

/** The one reason shown to people and in list_agents, by priority. */
export function waitReason(s: AgentState): WaitReason | undefined {
  const h = s.holds;
  if (h.pause) return 'paused';
  if (s.phase === 'running' && h.approvals > 0) return 'approval';
  if (s.phase !== 'waiting') return undefined;
  if (h.answer) return 'answer';
  if (h.children > 0) return 'children';
  if (h.background > 0) return 'background';
  return undefined;
}

/** The status the page and the agents see. */
export function statusOf(s: AgentState): AgentStatus {
  return s.phase === 'ended' ? s.end!.kind : s.phase;
}

export function ranMs(s: AgentState, now: number): number {
  return s.run.ms + (s.run.since === undefined ? 0 : now - s.run.since);
}

function clone(s: AgentState): AgentState {
  return {
    ...s,
    end: s.end && { ...s.end },
    holds: { ...s.holds, answer: s.holds.answer && { ...s.holds.answer }, pause: s.holds.pause && { ...s.holds.pause } },
    run: { ...s.run },
  };
}

function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Applies one event. Pure: the input state is not changed. */
export function step(prev: AgentState, ev: Event, ctx: Ctx): { state: AgentState; effects: Effect[] } {
  // A finished agent only reacts to being woken, restored or sent to; anything else is stale news.
  if (prev.phase === 'ended' && ev.type !== 'Woken' && ev.type !== 'Restored' && ev.type !== 'Input' && !(ev.type === 'Status' && (ev.status === 'queued' || ev.status === 'running'))) {
    return { state: prev, effects: [] };
  }
  const s = clone(prev);
  const fx: Effect[] = [];
  const wasLive = live(prev);

  const finish = (kind: 'done' | 'failed', text: string, error?: string) => {
    if (s.holds.children > 0) fx.push({ type: 'stopChildren' });
    endAs(kind, error);
    if (ctx.autoEffort) fx.push({ type: 'setEffortLow' });
    if (prev.owesReport) {
      fx.push({ type: 'report', status: kind, text: kind === 'failed' ? `The agent failed: ${error ?? 'unknown error'}${text ? `\n\nIts last message:\n${text}` : ''}` : text });
    } else fx.push({ type: 'childEndedQuietly' });
  };
  const endAs = (kind: EndKind, error?: string, by?: StopBy) => {
    s.phase = 'ended';
    s.end = { kind, ...(error !== undefined ? { error } : {}), ...(by ? { by } : {}) };
    s.owesReport = false;
    s.holds = { children: 0, background: 0, approvals: 0 };
    s.limitStreak = 0;
    // The runtime's end() gives the slot back; no separate releaseSlot here.
    fx.push({ type: 'end', kind, ...(error !== undefined ? { error } : {}) });
  };
  /** A waiting agent whose last hold went away finishes (sub-agent) or goes idle (lead). */
  const released = () => {
    if (s.phase !== 'waiting' || holding(s) || ctx.busy) return;
    if (s.lead) {
      s.phase = 'idle';
      if (ctx.autoEffort) fx.push({ type: 'setEffortLow' });
    } else finish('done', ctx.lastText);
  };
  /** Rows 11/11a: pause at a usage limit, or give up after MAX_PAUSES windows in a row. Returns false to give up. */
  const pause = (limit: UsageLimit): boolean => {
    const wall = ctx.wall ?? ctx.now;
    const until = limit.resetsAt && limit.resetsAt > wall ? limit.resetsAt : wall + DEFAULT_PAUSE_MS;
    const sameWindow = s.holds.pause !== undefined && !s.holds.pause.personWoke;
    if (!sameWindow) {
      if (s.limitStreak + 1 > MAX_PAUSES) {
        s.limitStreak = 0;
        // The lead carries on: what was held for it goes out (a sub-agent ends, and its held messages with it).
        if (s.holds.pause && s.lead) fx.push({ type: 'resumeRuntime', note: null });
        s.holds.pause = undefined;
        return false;
      }
      s.limitStreak += 1;
      fx.push({ type: 'notice', text: `Paused at the usage limit until ${clockTime(until)}; Masthead resumes it then.` });
    }
    s.holds.pause = {
      until: Math.max(until, s.holds.pause?.until ?? 0),
      personWoke: false,
      backgroundStopped: !!(limit.backgroundStopped || s.holds.pause?.backgroundStopped),
    };
    s.phase = 'waiting';
    fx.push({ type: 'releaseSlot' }, { type: 'pauseRuntime' });
    return true;
  };

  switch (ev.type) {
    case 'Spawned': // row 1
      Object.assign(s, initial(false));
      break;
    case 'Launched': // row 2
      if (s.phase === 'queued') s.phase = 'running';
      break;
    case 'LaunchFailed': // row 3
      if (live(s) && !s.lead) finish('failed', '', ev.error);
      else if (s.lead) s.phase = holding(s) ? 'waiting' : 'idle';
      break;
    case 'Input': // rows 4-6
      if (s.holds.pause && ev.from === 'person') s.holds.pause.personWoke = true;
      fx.push({ type: 'send', urgent: ev.from === 'person' });
      break;
    case 'TurnStarted':
      // While paused the shell owns the status: a late start does not flip it.
      if (!s.holds.pause && (s.phase === 'idle' || s.phase === 'waiting' || s.phase === 'queued')) s.phase = 'running';
      break;
    case 'TurnEnded': {
      if (ev.interrupted) fx.push({ type: 'notice', text: 'Stopped.' });
      else if (ev.error) fx.push({ type: 'notice', text: ev.error, level: 'error' });
      if (ev.usageLimit && !ev.interrupted && pause(ev.usageLimit)) break; // row 11
      if (!ev.usageLimit) {
        s.limitStreak = 0;
        if (s.holds.pause) {
          s.holds.pause = undefined;
          fx.push({ type: 'resumeRuntime', note: null }); // a turn got through: send what was held
        }
      }
      if (s.lead) {
        // row 8 / 9 (lead)
        s.phase = holding(s) ? 'waiting' : 'idle';
        if (s.phase === 'idle' && ctx.autoEffort) fx.push({ type: 'setEffortLow' });
        break;
      }
      if (!ev.error && holding(s)) {
        // row 9
        s.phase = 'waiting';
        if (backgroundOnly(s) && s.holds.backgroundSince === undefined) s.holds.backgroundSince = ctx.now;
        break;
      }
      finish(ev.error ? 'failed' : 'done', ev.text, ev.error); // rows 7, 10, 11a
      break;
    }
    case 'ProcessLost':
      fx.push({ type: 'notice', text: ev.error, level: 'error' }, { type: 'releaseSlot' });
      if (ev.usageLimit && pause(ev.usageLimit)) break;
      if (!ev.usageLimit) {
        s.limitStreak = 0;
        if (s.holds.pause) {
          s.holds.pause = undefined;
          fx.push({ type: 'resumeRuntime', note: null });
        }
      }
      if (s.lead) s.phase = holding(s) ? 'waiting' : 'idle';
      else if (live(s)) finish('failed', '', ev.error);
      break;
    case 'Asked':
      if (!s.lead) s.holds.answer = { from: ev.from, reminded: false };
      break;
    case 'AnswerArrived': // row 15
      s.holds.answer = undefined;
      released();
      break;
    case 'RecipientTurnEnded': {
      const a = s.holds.answer;
      if (!a || !live(s)) break;
      if (ev.interrupted || (a.reminded && !ev.recipientIsLead)) {
        // row 13 (and the interrupted case)
        s.holds.answer = undefined;
        fx.push({ type: 'noAnswer', from: a.from });
        if (s.phase === 'waiting' && !holding(s)) s.phase = 'running'; // the note starts its next turn
      } else if (!a.reminded) {
        a.reminded = true; // row 12
        fx.push({ type: 'remind', recipient: a.from });
      } // row 14: the lead was reminded already; keep waiting
      break;
    }
    case 'RecipientEnded':
      if (s.holds.answer && live(s)) {
        fx.push({ type: 'noAnswer', from: s.holds.answer.from });
        s.holds.answer = undefined;
        if (s.phase === 'waiting' && !holding(s)) s.phase = 'running';
      }
      break;
    case 'ChildStarted':
      s.holds.children += 1;
      s.holds.backgroundSince = undefined;
      break;
    case 'ChildEnded': // rows 16, 17
      s.holds.children = Math.max(0, s.holds.children - 1);
      if (!ev.reported) released();
      break;
    case 'Background': // row 18
      s.holds.background = ev.active;
      if (backgroundOnly(s)) s.holds.backgroundSince ??= ctx.now;
      else s.holds.backgroundSince = undefined;
      break;
    case 'BackgroundIdle': // row 19
      s.holds.background = 0;
      s.holds.backgroundSince = undefined;
      released();
      break;
    case 'Tick': {
      const p = s.holds.pause;
      if (p && p.until <= (ctx.wall ?? ctx.now)) {
        // row 20
        const inTurn = ctx.inTurn ?? (s.phase === 'running' && ctx.busy);
        s.holds.pause = undefined;
        fx.push({ type: 'resumeRuntime', note: inTurn ? null : `${RESUME_NOTE}${p.backgroundStopped ? BACKGROUND_STOPPED_NOTE : ''}` });
        if (inTurn) s.phase = 'running'; // the turn the person started carries on, now as a normal one
        if (!inTurn) {
          fx.push({ type: 'notice', text: 'The usage limit has reset; resumed.' });
          // The process was closed at the limit: the note starts a new one (Launched / TurnStarted follow).
          s.phase = 'queued';
        }
        break;
      }
      if (s.lead || !live(s) || s.holds.pause) break;
      if (ev.maxRunMs > 0 && ranMs(s, ctx.now) > ev.maxRunMs) {
        // row 21
        const minutes = Math.round(ev.maxRunMs / 60_000);
        const why = `Stopped after ${minutes} minutes: the run-time limit set by the person.`;
        const owed = s.owesReport;
        if (s.holds.children > 0) fx.push({ type: 'stopChildren', why });
        fx.push({ type: 'dropHeld' }, { type: 'notice', text: why });
        endAs('stopped', why, 'limit');
        fx.push(owed ? { type: 'report', status: 'stopped', text: why } : { type: 'childEndedQuietly' });
        break;
      }
      if (backgroundOnly(s) && s.holds.backgroundSince !== undefined && ctx.now - s.holds.backgroundSince >= ev.backgroundCapMs) {
        // row 22
        fx.push({ type: 'notice', text: BACKGROUND_CLOSED });
        finish('done', `${ctx.lastText}${ctx.lastText ? '\n\n' : ''}${BACKGROUND_CLOSED}`);
      }
      break;
    }
    case 'Stop': {
      if (s.lead) {
        // the lead keeps its session: what was held for it is dropped, its pause ends and, if nothing
        // else holds it, it goes idle
        s.holds.pause = undefined;
        fx.push({ type: 'dropHeld' });
        released();
        break;
      }
      if (!live(s)) break;
      const owed = s.owesReport;
      if (ev.by === 'person') s.stoppedByPerson = true; // row 23: only agents that were working
      if (s.holds.children > 0) fx.push({ type: 'stopChildren', why: ev.why });
      fx.push({ type: 'dropHeld' });
      endAs('stopped', ev.why, ev.by);
      fx.push({ type: 'notice', text: ev.why });
      // rows 23/24: the person's stop reports to a parent still waiting for it; an agent's own stop does not
      if (ev.by === 'person' && owed) fx.push({ type: 'report', status: 'stopped', text: ev.why });
      else if (ev.by !== 'restart') fx.push({ type: 'childEndedQuietly' });
      break;
    }
    case 'ApprovalOpened': // row 25
      s.holds.approvals += 1;
      break;
    case 'ApprovalClosed':
      s.holds.approvals = Math.max(0, s.holds.approvals - 1);
      break;
    case 'Woken': // row 26
      if (ev.by === 'person') s.stoppedByPerson = false;
      if (s.phase === 'ended' && !s.lead) {
        s.phase = 'queued';
        s.end = undefined;
        s.run = { ms: 0 };
        if (ev.parentCanReceive) s.owesReport = true;
      }
      break;
    case 'Status': {
      const st = ev.status;
      if (st === 'queued' || st === 'running') {
        // While paused the shell owns the status; otherwise the runtime's start or turn is taken as it is.
        if (!s.holds.pause) {
          s.phase = st;
          s.end = undefined;
        }
      } else if (st === 'waiting' || st === 'idle') {
        s.phase = st;
      } else if (s.lead) {
        s.phase = holding(s) ? 'waiting' : 'idle'; // the lead never ends; it keeps its session
      } else if (s.phase !== 'queued') {
        // Ended outside the machine (shutdown); a 'queued' state is a wake-up the runtime has not shown yet.
        s.phase = 'ended';
        s.end = { kind: st };
        s.holds = { children: 0, background: 0, approvals: 0 };
        s.owesReport = false;
      }
      break;
    }
    case 'Restored': // row 27
      s.holds = { children: 0, background: 0, approvals: 0 };
      s.limitStreak = 0;
      s.owesReport = false;
      s.run = { ms: 0 };
      if (s.lead) s.phase = 'idle';
      else if (wasLive) {
        s.phase = 'ended';
        s.end = { kind: 'stopped', error: 'Masthead was closed while this agent was working.', by: 'restart' };
      }
      break;
  }

  // Bookkeeping that follows from the phase, after every event.
  const nowLive = live(s);
  if (nowLive && (!wasLive || s.liveSince === undefined)) s.liveSince = ctx.now;
  if (!nowLive) s.liveSince = undefined;
  const clockOn = s.phase === 'running' && s.holds.approvals === 0;
  if (clockOn && s.run.since === undefined) s.run.since = ctx.now;
  else if (!clockOn && s.run.since !== undefined) {
    s.run.ms += ctx.now - s.run.since;
    s.run.since = undefined;
  }
  // Waiting on background work alone, however it got there (a child ended, a hold was released): time it.
  if (s.phase !== 'waiting' || !backgroundOnly(s)) s.holds.backgroundSince = undefined;
  else s.holds.backgroundSince ??= ctx.now;
  if (s.stoppedByPerson !== prev.stoppedByPerson) fx.push({ type: 'save' });
  return { state: s, effects: fx };
}
