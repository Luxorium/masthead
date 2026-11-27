import type { Tier } from '../../shared/protocol.js';

interface Waiter {
  id: string;
  /** Who asked for the slot; used to share slots fairly between parents. */
  owner: string;
  seq: number;
  grant: () => void;
  refuse: (reason: Error) => void;
}

export class SlotCancelled extends Error {
  constructor() {
    super('cancelled while waiting for a slot');
  }
}

/** A queued request refused because its tier was switched off (limit 0) while it waited. */
export class TierOff extends Error {
  constructor() {
    super('This tier was switched off in the settings while the agent was waiting to start.');
  }
  // The agent shows String(error); keep it free of an "Error:" prefix.
  override toString(): string {
    return this.message;
  }
}

/**
 * Limits how many agents of each tier run at once, across every conversation.
 *
 * An agent asks for a slot before it starts and gives it back when it finishes, fails or is stopped.
 * An agent that is waiting for agents it started keeps its slot: it is still part of the running team.
 * When a slot frees up, the request from the parent with the fewest running agents of that tier goes
 * first, so one busy parent cannot starve the others; ties go to whoever asked first.
 */
export class Scheduler {
  private active = new Map<Tier, Map<string, string>>(); // tier -> agent id -> owner
  private queue = new Map<Tier, Waiter[]>();
  private seq = 0;

  constructor(private limit: (tier: Tier) => number) {}

  private activeOf(tier: Tier): Map<string, string> {
    let m = this.active.get(tier);
    if (!m) this.active.set(tier, (m = new Map()));
    return m;
  }

  private queueOf(tier: Tier): Waiter[] {
    let q = this.queue.get(tier);
    if (!q) this.queue.set(tier, (q = []));
    return q;
  }

  /** The lead is never limited: each conversation always has its one lead. */
  private cap(tier: Tier): number {
    const limit = this.limit(tier);
    // The lead's tier is never limited; a limit function may also say so with Infinity (first tiers of other profiles).
    return tier === 'lead' || limit === Infinity ? Infinity : Math.max(0, limit);
  }

  running(tier: Tier): number {
    return this.activeOf(tier).size;
  }

  queued(tier: Tier): number {
    return this.queueOf(tier).length;
  }

  /** Resolves when the agent may run. Rejects with SlotCancelled if `cancel` is called first. */
  acquire(tier: Tier, id: string, owner: string): Promise<void> {
    const active = this.activeOf(tier);
    if (active.has(id)) return Promise.resolve();
    // A tier that is off would keep the request queued for ever (a paused agent resuming, say).
    if (this.cap(tier) === 0) return Promise.reject(new TierOff());
    if (active.size < this.cap(tier) && this.queueOf(tier).length === 0) {
      active.set(id, owner);
      return Promise.resolve();
    }
    return new Promise<void>((grant, refuse) => {
      this.queueOf(tier).push({ id, owner, seq: this.seq++, grant, refuse });
      this.pump(tier);
    });
  }

  release(tier: Tier, id: string): void {
    if (this.activeOf(tier).delete(id)) this.pump(tier);
  }

  /** Drops a queued request. Returns true if one was waiting. */
  cancel(tier: Tier, id: string): boolean {
    const q = this.queueOf(tier);
    const i = q.findIndex((w) => w.id === id);
    if (i < 0) return false;
    const [w] = q.splice(i, 1);
    w!.refuse(new SlotCancelled());
    return true;
  }

  /**
   * Call after the limits change so newly allowed agents start. Requests queued for a tier that is now
   * off would wait for ever, so they are refused with TierOff; the agent then fails and reports.
   */
  limitsChanged(): void {
    for (const [tier, q] of this.queue) {
      if (this.cap(tier) === 0) for (const w of q.splice(0)) w.refuse(new TierOff());
      else this.pump(tier);
    }
  }

  private pump(tier: Tier): void {
    const active = this.activeOf(tier);
    const q = this.queueOf(tier);
    while (q.length > 0 && active.size < this.cap(tier)) {
      const load = new Map<string, number>();
      for (const owner of active.values()) load.set(owner, (load.get(owner) ?? 0) + 1);
      let best = 0;
      for (let i = 1; i < q.length; i++) {
        const a = q[i]!;
        const b = q[best]!;
        const la = load.get(a.owner) ?? 0;
        const lb = load.get(b.owner) ?? 0;
        if (la < lb || (la === lb && a.seq < b.seq)) best = i;
      }
      const [w] = q.splice(best, 1);
      active.set(w!.id, w!.owner);
      w!.grant();
    }
  }
}
