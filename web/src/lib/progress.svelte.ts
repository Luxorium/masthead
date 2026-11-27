// The live side of progress.ts: when the page saw each agent start what it is doing and last put
// anything out, a clock that ticks every 15 s while something shows a time, and the request to show
// the lead's open question in the chat. The server sends no start time for an activity, so the marks
// come from the messages this page receives (store.listen); a mark made from a snapshot is a lower bound.
import type { AgentInfo, Item } from '../../../shared/protocol.ts';
import { noteAgent, noteOutput, spanWords, type Mark } from './progress.ts';
import { store } from './store.svelte.ts';

const TICK_MS = 15_000;

class Progress {
  /** Now, to the last tick. Only the spans read it, so a tick re-renders only them. */
  now = $state(Date.now());
  marks = $state<Record<string, Mark>>({});
  /** The chat item to scroll to and highlight, with a counter so asking again works. */
  focus = $state<{ id: string; n: number } | null>(null);

  private conv: string | null = null;
  private users = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Keeps the clock ticking while the caller lives; returns the function that lets it stop. Use in $effect. */
  useClock(): () => void {
    this.users++;
    if (!this.timer && typeof setInterval !== 'undefined') {
      this.now = Date.now();
      this.timer = setInterval(() => (this.now = Date.now()), TICK_MS);
    }
    return () => {
      if (--this.users <= 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.users = 0;
      }
    };
  }

  /** "4 min", "over 4 min" or '' for the agent, live with the clock. */
  span(agentId: string): string {
    return spanWords(this.marks[agentId], this.now);
  }

  agent(a: AgentInfo, exact: boolean, now = Date.now()): void {
    const prev = this.marks[a.id];
    const next = noteAgent(prev, a, now, exact);
    if (next !== prev) this.marks[a.id] = next;
  }

  output(agentId: string, at: number, now = Date.now()): void {
    const prev = this.marks[agentId];
    const next = noteOutput(prev, at, now);
    if (next && next !== prev) this.marks[agentId] = next;
  }

  /** A whole conversation arrived: a new one starts afresh, the same one again (a reconnect) keeps what it knew. */
  snapshot(convId: string, agents: AgentInfo[], now = Date.now()): void {
    if (convId !== this.conv) {
      this.conv = convId;
      this.marks = {};
    }
    for (const a of agents) this.agent(a, false, now);
  }

  showItem(id: string): void {
    this.focus = { id, n: (this.focus?.n ?? 0) + 1 };
  }
}

export const progress = new Progress();

store.listen('conversation', (m) => {
  const conv = m.conv as { id: string } | undefined;
  if (conv) progress.snapshot(conv.id, (m.agents as AgentInfo[]) ?? []);
});
store.listen('agent', (m) => {
  const a = m.agent as AgentInfo | undefined;
  if (a && a.convId === store.convId) progress.agent(a, true);
});
store.listen('item', (m) => {
  if (m.convId === store.convId) progress.output(m.agentId as string, Date.now());
});
store.listen('draft', (m) => {
  // A draft being cleared (`draft: null`) is the end of output, not new output.
  if (m.convId === store.convId && m.draft != null) progress.output(m.agentId as string, Date.now());
});
// A transcript that loads tells when its latest item came (the server's clock; kept no later than now).
store.listen('items', (m) => {
  const items = m.items as Item[] | undefined;
  const last = items?.[items.length - 1];
  if (m.convId === store.convId && last && typeof last.ts === 'number') progress.output(m.agentId as string, last.ts);
});
