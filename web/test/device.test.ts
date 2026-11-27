import { render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../../shared/protocol.ts';
import StopControl from '../src/lib/StopControl.svelte';
import { Store, store as shared } from '../src/lib/store.svelte.ts';

/** A WebSocket stand-in: records what was sent and lets the test close it. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string, public protocols: string[]) {
    FakeSocket.last = this;
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.onclose?.({ code: 1000 });
  }
}

const whoamiSays = (body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body }) as Response));

describe('remote device sign-in', () => {
  beforeEach(() => {
    localStorage.setItem('masthead.device', 'tok');
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the token after a brief refusal while the server still knows the device', async () => {
    whoamiSays({ state: 'approved', role: 'full' });
    const s = new Store();
    (s as unknown as { connectDevice(): void }).connectDevice();
    expect(FakeSocket.last!.protocols).toEqual(['masthead', 'device.tok']);
    FakeSocket.last!.onclose!({ code: 1006 }); // refused before it opened
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem('masthead.device')).toBe('tok');
    expect(s.signedOut).toBeNull();
  });

  it('forgets the token only when the server says it is no longer valid', async () => {
    whoamiSays({ state: 'unknown', device: { name: 'phone' } });
    const s = new Store();
    (s as unknown as { connectDevice(): void }).connectDevice();
    FakeSocket.last!.onclose!({ code: 1006 });
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem('masthead.device')).toBeNull();
    expect(s.signedOut).toBe('device');
  });

  it('Forget this device tells the server, clears the token and the pairing, and signs out', async () => {
    whoamiSays({ state: 'approved', role: 'full' });
    sessionStorage.setItem('masthead.pairing', '{"requestId":"r"}');
    const s = new Store();
    (s as unknown as { connectDevice(): void }).connectDevice();
    const ws = FakeSocket.last!;
    ws.readyState = 1;
    ws.onopen!();
    s.forgetThisDevice();
    expect(ws.sent.map((m) => JSON.parse(m).t)).toContain('forget_me');
    expect(localStorage.getItem('masthead.device')).toBeNull();
    expect(sessionStorage.getItem('masthead.pairing')).toBeNull();
    ws.onclose!({ code: 4001 }); // the server drops the device
    expect(s.signedOut).toBe('device');
  });
});

describe('what a device role may do', () => {
  const agent = { id: 'b', name: 'bravo', status: 'running' } as unknown as AgentInfo;
  afterEach(() => (shared.deviceRole = null));

  it('a read-only device gets no stop buttons, and cannot act or answer', () => {
    shared.deviceRole = 'read';
    const { container } = render(StopControl, { agent, placement: 'row' });
    expect(container.querySelector('.stop')).toBeNull();
    expect(shared.mayAct).toBe(false);
    expect(shared.mayAnswer).toBe(false);
  });

  it('an approve device may answer but not act; this computer may do both', () => {
    shared.deviceRole = 'approve';
    expect([shared.mayAct, shared.mayAnswer]).toEqual([false, true]);
    shared.deviceRole = null;
    expect([shared.mayAct, shared.mayAnswer]).toEqual([true, true]);
  });
});
