// A tab that cannot keep up: draft deltas are dropped first, and a socket far behind is closed.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { BlobTokens } from '../server/transport/blobs.ts';
import { attach } from '../server/transport/http.ts';
import type { Client } from '../server/app/app.ts';

test('transport: back-pressure drops drafts past 4 MB buffered and closes past 32 MB', () => {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [] as string[], closed: 0, send(d: string) { this.sent.push(d); }, close(code: number) { this.closed = code; }, ping() {}, terminate() {} });
  let client: Client | null = null;
  const app = { connect: (c: Client) => void (client = c), disconnect: () => {}, handle: () => {}, workingCount: () => 0 };
  attach(app as never, ws as never, new BlobTokens());
  const c = client!;
  c.send({ t: 'draft', convId: 'c', agentId: 'a', draft: null } as never);
  ws.bufferedAmount = 5 * 1024 * 1024;
  c.send({ t: 'draft', convId: 'c', agentId: 'a', draft: null } as never);
  c.send({ t: 'item', convId: 'c', agentId: 'a', item: {} } as never);
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s).t), ['draft', 'item'], 'the draft was dropped, the item was not');
  ws.bufferedAmount = 33 * 1024 * 1024;
  c.send({ t: 'item', convId: 'c', agentId: 'a', item: {} } as never);
  assert.equal(ws.closed, 4002);
  assert.equal(ws.sent.length, 2);
  ws.emit('close');
});
