import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, ServerMsg, Settings } from '../../shared/protocol.ts';
import { Store } from '../src/lib/store.svelte.ts';

const settings = { tiers: {}, permissionMode: 'inherit', defaultCwd: '/home/x' } as unknown as Settings;
const state = (over: Partial<AppState> = {}): ServerMsg => ({
  t: 'state',
  state: { version: 't', settings, conversations: [], claude: { path: '/c', version: '1' }, home: '/home/x', pending: [], usage: [], ...over } as AppState,
});

/** A store whose socket is a stub that records what was sent. */
function connected(): { store: Store; sent: unknown[] } {
  const store = new Store();
  const sent: unknown[] = [];
  (store as unknown as { ws: unknown }).ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) };
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  store.connected = true;
  return { store, sent };
}

describe('store', () => {
  beforeEach(() => history.replaceState(null, '', '/'));

  it('finds the main assistant on any team, not only by the tier id "lead"', () => {
    const { store } = connected();
    const agent = (id: string, tier: string, parentId: string | null) => ({ id, tier, parentId, name: id, createdAt: id === 'a' ? 1 : 2, status: 'idle' });
    store.agents = { a: agent('a', 'copy:0', null), b: agent('b', 'copy:1', 'a') } as never;
    expect(store.lead?.id).toBe('a');
    expect(store.viewAgent?.id).toBe('a');
    store.viewOf('a');
    expect(store.viewAgentId).toBe(null);
    store.viewOf('b');
    expect(store.viewAgentId).toBe('b');
  });

  it('replaces pending approvals from every state message', () => {
    const { store } = connected();
    store.pending = [{ id: 'old' } as never];
    store.receive(state({ pending: [{ id: 'new', convId: 'c' } as never] }));
    expect(store.pending.map((p) => p.id)).toEqual(['new']);
  });

  it('gives a refused message back to its draft', () => {
    const { store, sent } = connected();
    store.receive(state());
    const key = store.composerKey;
    store.composerFor(key).text = 'hello';
    expect(store.sendMessage(key)).toBe(true);
    expect(store.composerFor(key).text).toBe('');
    const ref = (sent.at(-1) as { ref: string }).ref;
    store.receive({ t: 'error', message: 'The message is too long.', ref });
    expect(store.composerFor(key).text).toBe('hello');
    expect(store.creating).toBe(false);
  });

  it('does not overwrite newer typing when giving a message back', () => {
    const { store, sent } = connected();
    store.receive(state());
    const key = store.composerKey;
    store.composerFor(key).text = 'first';
    store.sendMessage(key);
    store.composerFor(key).text = 'second';
    store.receive({ t: 'error', message: 'x', ref: (sent.at(-1) as { ref: string }).ref });
    expect(store.composerFor(key).text).toBe('second');
  });

  it('derives the usage banner from the worst window and keeps a dismissal until it changes', () => {
    const { store } = connected();
    store.receive(state({ usage: [{ type: 'five_hour', status: 'allowed_warning', resetsAt: 1 }] }));
    expect(store.rateLimit?.type).toBe('five_hour');
    store.dismissLimit();
    expect(store.rateLimit).toBeNull();
    store.receive({ t: 'rate_limit', notice: { type: 'five_hour', status: 'rejected', resetsAt: 1 } });
    expect(store.rateLimit?.status).toBe('rejected');
  });
});
