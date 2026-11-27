import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AppState, Settings } from '../../shared/protocol.ts';
import { Store } from '../src/lib/store.svelte.ts';

const settings = { tiers: {}, permissionMode: 'inherit', defaultCwd: '/home/x' } as unknown as Settings;
const conv = { id: 'c1', title: 't', cwd: '/w', createdAt: 0, updatedAt: 0, leadId: 'L' };
const lead = { id: 'L', convId: 'c1', name: 'alpha', tier: 'lead', parentId: null, status: 'idle' } as unknown as AgentInfo;

function v2store() {
  const store = new Store();
  const sent: Record<string, unknown>[] = [];
  (store as unknown as { ws: unknown }).ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) };
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  store.connected = true;
  const state = { version: 't', settings, conversations: [conv], claude: { path: '/c', version: '1' }, home: '/h', usage: [] } as unknown as AppState;
  return { store, sent, state };
}

describe('store, protocol version 2', () => {
  beforeEach(() => history.replaceState(null, '', '/#/c/c1'));

  it('takes approvals as summaries and subscribes to the open conversation', () => {
    const { store, sent, state } = v2store();
    store.receive({ t: 'state', protocol: 2, state: { ...state, pending: [{ id: 'r1', convId: 'c1', agentName: 'bravo', kind: 'permission' }], blobToken: 'tok' } } as never);
    expect(store.v2).toBe(true);
    expect(store.waitingIn('c1')).toBe(1);
    expect(store.blobToken).toBe('tok');
    expect(store.pending).toEqual([]);
    expect(sent.at(-1)).toEqual({ t: 'subscribe', convId: 'c1' });
  });

  it('builds a draft from deltas and asks for the whole text after a gap', () => {
    const { store, sent, state } = v2store();
    store.receive({ t: 'state', protocol: 2, state: { ...state, pending: [] } } as never);
    store.receive({ t: 'conversation', conv, agents: [lead], pending: [], drafts: {}, seq: 5 } as never);
    store.receive({ t: 'draft', convId: 'c1', agentId: 'L', seq: 6, dseq: 1, kind: 'text', append: 'Hel' } as never);
    store.receive({ t: 'draft', convId: 'c1', agentId: 'L', seq: 7, dseq: 2, kind: 'text', append: 'lo' } as never);
    expect(store.drafts.L).toEqual({ kind: 'text', text: 'Hello' });
    store.receive({ t: 'draft', convId: 'c1', agentId: 'L', seq: 9, dseq: 4, kind: 'text', append: '!' } as never);
    expect(sent.at(-1)).toEqual({ t: 'draft_sync', convId: 'c1', agentId: 'L' });
    store.receive({ t: 'draft_end', convId: 'c1', agentId: 'L', seq: 10 } as never);
    expect(store.drafts.L).toBeNull();
  });

  it('resubscribes from the last event after a reconnect, keeping the loaded transcript', () => {
    const { store, sent, state } = v2store();
    store.receive({ t: 'state', protocol: 2, state: { ...state, pending: [] } } as never);
    store.receive({ t: 'conversation', conv, agents: [lead], pending: [], drafts: {}, seq: 3 } as never);
    store.receive({ t: 'items', convId: 'c1', agentId: 'L', items: [{ id: 'i1', ts: 1, kind: 'text', text: 'a' }], draft: null, cursor: 1, more: false } as never);
    store.receive({ t: 'item', convId: 'c1', agentId: 'L', seq: 8, item: { id: 'i2', ts: 2, kind: 'text', text: 'b' } } as never);
    store.receive({ t: 'state', protocol: 2, state: { ...state, pending: [] } } as never);
    expect(sent.at(-1)).toEqual({ t: 'subscribe', convId: 'c1', since: 8 });
    expect(store.items.L?.map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  it('puts an older page in front and keeps the newer copies', () => {
    const { store, sent, state } = v2store();
    store.receive({ t: 'state', protocol: 2, state: { ...state, pending: [] } } as never);
    store.receive({ t: 'conversation', conv, agents: [lead], pending: [], drafts: {}, seq: 1 } as never);
    store.receive({ t: 'items', convId: 'c1', agentId: 'L', items: [{ id: 'b', ts: 2, kind: 'text', text: 'new b' }, { id: 'c', ts: 3, kind: 'text', text: 'c' }], draft: null, cursor: 2, more: true } as never);
    store.loadEarlier('L');
    expect(sent.at(-1)).toMatchObject({ t: 'items', agentId: 'L', before: 2 });
    store.receive({ t: 'items', convId: 'c1', agentId: 'L', items: [{ id: 'a', ts: 1, kind: 'text', text: 'a' }, { id: 'b', ts: 2, kind: 'text', text: 'old b' }], draft: null, cursor: null, more: false } as never);
    expect(store.items.L?.map((i) => (i as { text: string }).text)).toEqual(['a', 'new b', 'c']);
    expect(store.pages.L?.more).toBe(false);
  });
});
