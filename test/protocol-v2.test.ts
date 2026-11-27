// Protocol version 2 (server/app/clients.ts): handshake, subscriptions, seq and resync, draft deltas,
// clipping, coded errors, the v1 adapter, and the role gate. Uses the Hub with a stand-in host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInfo, AppState, Item, PermissionRequest, ServerMsg } from '../shared/protocol.ts';
import { CLIP_CHARS, RING_SIZE } from '../shared/protocol-v2.ts';
import { ClientError, Hub, clipItem, codeOf, type Client } from '../server/app/clients.ts';

const agent = (id: string, convId = 'c1') => ({ id, convId, name: id, tier: 'lead', status: 'idle' }) as unknown as AgentInfo;
const request = (id: string, convId = 'c1') => ({ id, convId, agentId: 'a', agentName: 'bravo', kind: 'permission', toolName: 'Bash', input: {}, canAlways: false, ts: 1 }) as PermissionRequest;

function setup() {
  const items: Record<string, Item> = { big: { id: 'big', ts: 1, kind: 'tool', name: 'Bash', input: {}, result: 'x'.repeat(CLIP_CHARS * 2), done: true } as Item };
  const pending: PermissionRequest[] = [];
  const hub = new Hub({
    snapshot: (convId) => (convId === 'c1' || convId === 'c2' ? { conv: { id: convId } as never, agents: [agent('a', convId)], lastItemIds: { a: 'last' }, pending: pending.filter((p) => p.convId === convId) } : null),
    fullItem: (convId, _a, itemId) => (convId === 'c1' ? (items[itemId] ?? null) : null),
    state: () => ({ version: 'x', pending, conversations: [] }) as unknown as AppState,
  });
  const tab = (role?: Client['role']) => {
    const got: Array<Record<string, unknown>> = [];
    const client: Client = { send: (m) => void got.push(JSON.parse(JSON.stringify(m))), role };
    hub.add(client);
    const say = (m: Record<string, unknown>) => {
      got.length = 0;
      try {
        hub.admit(client, String(m.t));
        hub.intercept(client, m);
      } catch (e) {
        hub.error(client, e);
      }
      return [...got];
    };
    return { client, got, say };
  };
  return { hub, tab, pending };
}

const v2 = { t: 'hello', protocol: 2, caps: ['drafts-delta', 'resync', 'nonsense'] };

test('v2: hello negotiates the version; a wrong one is a protocol error; state carries summaries', () => {
  const { tab, pending } = setup();
  pending.push(request('p1'));
  const a = tab();
  const [st] = a.say(v2);
  assert.equal(st!.t, 'state');
  assert.equal(st!.protocol, 2);
  assert.deepEqual((st!.state as { pending: unknown[] }).pending, [{ id: 'p1', convId: 'c1', agentName: 'bravo', kind: 'permission' }]);
  const b = tab();
  assert.deepEqual(b.say({ t: 'hello', protocol: 3 }), [{ t: 'error', message: 'This Masthead speaks protocol 2. Reload the page.' }], 'still v1, so no code');
  assert.deepEqual(b.say({ t: 'subscribe', convId: 'c1' }), [{ t: 'error', message: 'Say hello with protocol 2 first.' }]);
});

test('v1 adapter: a tab that never says hello 2 gets every event unchanged', () => {
  const { hub, tab } = setup();
  const old = tab();
  const events: ServerMsg[] = [
    { t: 'agent', agent: agent('a') },
    { t: 'item', convId: 'c9', agentId: 'a', item: { id: 'i', ts: 1, kind: 'text', text: 'hi' } as Item },
    { t: 'draft', convId: 'c1', agentId: 'a', draft: { kind: 'text', text: 'he' } },
    { t: 'permission_request', request: request('p1') },
    { t: 'conversations', conversations: [] },
  ];
  for (const e of events) hub.publish(e);
  assert.deepEqual(old.got, JSON.parse(JSON.stringify(events)));
});

test('v2: detailed events only for subscribed conversations, list-level events always, each with seq', () => {
  const { hub, tab } = setup();
  const a = tab();
  a.say(v2);
  const snap = a.say({ t: 'subscribe', convId: 'c1' });
  assert.equal(snap[0]!.t, 'conversation');
  assert.equal(snap[0]!.seq, 0);
  a.got.length = 0;
  hub.publish({ t: 'agent', agent: agent('a', 'c1') });
  hub.publish({ t: 'agent', agent: agent('b', 'c2') });
  hub.publish({ t: 'conversations', conversations: [] });
  hub.publish({ t: 'permission_request', request: request('p2', 'c2') });
  hub.publish({ t: 'permission_request', request: request('p3', 'c1') });
  assert.deepEqual(a.got.map((m) => [m.t, m.seq]), [
    ['agent', 1],
    ['conversations', undefined],
    ['approval', undefined],
    ['approval', undefined],
    ['permission_request', 2],
  ]);
  a.got.length = 0;
  a.say({ t: 'unsubscribe', convId: 'c1' });
  hub.publish({ t: 'agent', agent: agent('a', 'c1') });
  assert.deepEqual(a.got, []);
  assert.equal(a.say({ t: 'subscribe', convId: 'nope' })[0]!.code, 'not_found');
});

test('v2: resync replays from the ring, or says resync and sends a snapshot when too old', () => {
  const { hub, tab } = setup();
  for (let i = 0; i < 10; i++) hub.publish({ t: 'agent', agent: agent('a', 'c1') });
  const a = tab();
  a.say(v2);
  const replay = a.say({ t: 'subscribe', convId: 'c1', since: 7 });
  assert.deepEqual(replay.map((m) => m.seq), [8, 9, 10]);
  const current = a.say({ t: 'subscribe', convId: 'c1', since: 10 });
  assert.deepEqual(current, [], 'up to date: nothing to send');
  for (let i = 0; i < RING_SIZE + 5; i++) hub.publish({ t: 'agent', agent: agent('a', 'c1') });
  const old = a.say({ t: 'subscribe', convId: 'c1', since: 3 });
  assert.deepEqual(old.map((m) => m.t), ['resync', 'conversation']);
  assert.equal(old[1]!.seq, 10 + RING_SIZE + 5);
  const future = a.say({ t: 'subscribe', convId: 'c1', since: 99_999 });
  assert.deepEqual(future.map((m) => m.t), ['resync', 'conversation'], 'a seq from before a server restart');
});

test('v2: drafts become deltas; a replacement restarts dseq; draft_sync gives the whole text; the end is said once', () => {
  const { hub, tab } = setup();
  const a = tab();
  a.say(v2);
  a.say({ t: 'subscribe', convId: 'c1' });
  a.got.length = 0;
  const d = (text: string | null, kind: 'text' | 'thinking' = 'text') => hub.publish({ t: 'draft', convId: 'c1', agentId: 'a', draft: text === null ? null : { kind, text } });
  d('Hel');
  d('Hello');
  d('Hello');
  d('Hello, world');
  d('Different', 'thinking');
  hub.publish({ t: 'item', convId: 'c1', agentId: 'a', item: { id: 'th1', ts: 1, kind: 'thinking', text: 'Different' } as Item });
  d(null);
  d(null);
  assert.deepEqual(a.got.map(({ t, dseq, append, text }) => ({ t, dseq, append, text })), [
    { t: 'draft', dseq: 1, append: undefined, text: 'Hel' },
    { t: 'draft', dseq: 2, append: 'lo', text: undefined },
    { t: 'draft', dseq: 3, append: ', world', text: undefined },
    { t: 'draft', dseq: 1, append: undefined, text: 'Different' },
    { t: 'item', dseq: undefined, append: undefined, text: undefined },
    { t: 'draft_end', dseq: undefined, append: undefined, text: undefined },
  ]);
  assert.equal(a.got.at(-1)!.itemId, 'th1', 'the end names the item that replaces the draft');
  d('Again');
  d('Again and');
  const sync = a.say({ t: 'draft_sync', convId: 'c1', agentId: 'a' });
  assert.deepEqual({ ...sync[0], seq: 0 }, { t: 'draft', convId: 'c1', agentId: 'a', dseq: 2, kind: 'text', text: 'Again and', seq: 0 });
  const joined = tab();
  joined.say(v2);
  const snap = joined.say({ t: 'subscribe', convId: 'c1' });
  assert.deepEqual(snap[0]!.drafts, { a: { kind: 'text', text: 'Again and', dseq: 2 } }, 'joining mid-draft gives the whole draft once');
});

test('v2: heavy tool fields are clipped live and fetched whole on request', () => {
  const { hub, tab } = setup();
  const a = tab();
  a.say(v2);
  a.say({ t: 'subscribe', convId: 'c1' });
  a.got.length = 0;
  const big = { id: 'big', ts: 1, kind: 'tool', name: 'Bash', input: { command: 'y'.repeat(CLIP_CHARS + 10) }, result: 'x'.repeat(CLIP_CHARS * 2), done: true } as unknown as Item;
  hub.publish({ t: 'item', convId: 'c1', agentId: 'a', item: big });
  const ev = a.got[0] as { item: { result: string; input: { clipped: string } }; truncated: boolean };
  assert.equal(ev.truncated, true);
  assert.equal(ev.item.result.length, CLIP_CHARS);
  assert.equal(ev.item.input.clipped.length, CLIP_CHARS);
  const full = a.say({ t: 'item_full', convId: 'c1', agentId: 'a', itemId: 'big' });
  assert.equal((full[0]!.item as { result: string }).result.length, CLIP_CHARS * 2);
  assert.equal(a.say({ t: 'item_full', convId: 'c1', agentId: 'a', itemId: 'gone' })[0]!.code, 'not_found');
  const small = { id: 's', ts: 1, kind: 'text', text: 'z'.repeat(CLIP_CHARS * 2) } as Item;
  assert.deepEqual(clipItem(small), { item: small, truncated: false }, 'only tool items are clipped');
});

test('v2: errors carry codes; roles are enforced at the gate; deleting a conversation drops its subscription', () => {
  assert.equal(codeOf(new Error('That conversation no longer exists.')), 'not_found');
  assert.equal(codeOf(new Error('The message is too long.')), 'too_large');
  assert.equal(codeOf(new Error('An image is larger than 5 MB.')), 'too_large');
  assert.equal(codeOf(new Error('Unknown request.')), 'invalid');
  assert.equal(codeOf(new ClientError('refused', 'x')), 'refused');
  const { hub, tab } = setup();
  const phone = tab('read');
  phone.say(v2);
  assert.equal(phone.say({ t: 'subscribe', convId: 'c1' })[0]!.t, 'conversation', 'reading is allowed');
  assert.throws(() => hub.admit(phone.client, 'send'), (e: ClientError) => e.code === 'refused');
  assert.throws(() => hub.admit(phone.client, 'settings'), (e: ClientError) => e.code === 'refused');
  const approver = tab('approve');
  hub.admit(approver.client, 'permission');
  const local = tab();
  hub.admit(local.client, 'device_revoke');
  hub.publish({ t: 'deleted', convId: 'c1' });
  phone.got.length = 0;
  hub.publish({ t: 'agent', agent: agent('a', 'c1') });
  assert.deepEqual(phone.got, [], 'no events for a deleted conversation');
});

test('v2: a draft that ends before its item waits for it, or ends unnamed after a moment', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { hub, tab } = setup();
  const a = tab();
  a.say(v2);
  a.say({ t: 'subscribe', convId: 'c1' });
  a.got.length = 0;
  hub.publish({ t: 'draft', convId: 'c1', agentId: 'a', draft: { kind: 'text', text: 'Done.' } });
  hub.publish({ t: 'draft', convId: 'c1', agentId: 'a', draft: null });
  assert.deepEqual(a.got.map((m) => m.t), ['draft'], 'the end waits');
  hub.publish({ t: 'item', convId: 'c1', agentId: 'a', item: { id: 'final', ts: 1, kind: 'text', text: 'Done.' } as Item });
  assert.deepEqual(a.got.map((m) => [m.t, m.itemId]), [['draft', undefined], ['item', undefined], ['draft_end', 'final']]);
  assert.ok((a.got[2]!.seq as number) > (a.got[1]!.seq as number));
  a.got.length = 0;
  hub.publish({ t: 'draft', convId: 'c1', agentId: 'a', draft: { kind: 'text', text: 'Cut' } });
  hub.publish({ t: 'draft', convId: 'c1', agentId: 'a', draft: null });
  t.mock.timers.tick(1600);
  assert.deepEqual(a.got.map((m) => [m.t, m.itemId]), [['draft', undefined], ['draft_end', undefined]]);
  const snap = tab();
  snap.say(v2);
  assert.deepEqual(snap.say({ t: 'subscribe', convId: 'c1' })[0]!.lastItemIds, { a: 'last' });
});
