import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RemoteSignIn from '../src/lib/remote/RemoteSignIn.svelte';

type Reply = { status?: number; body: unknown };
function stubFetch(routes: Record<string, Reply | Reply[]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.startsWith(k))!;
    const r = routes[key]!;
    const reply = Array.isArray(r) ? (r.length > 1 ? r.shift()! : r[0]!) : r;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RemoteSignIn', () => {
  it('asks, shows the code, keeps the poll secret across a reload, and hands over the token', async () => {
    const calls = stubFetch({
      '/api/remote/whoami': { body: { state: 'unknown', device: { name: 'phone' } } },
      '/api/remote/request/': [{ body: { state: 'pending' } }, { body: { state: 'allowed', token: 't'.repeat(64), role: 'full' } }],
      '/api/remote/request': { body: { requestId: 'a'.repeat(24), pollSecret: 's1', code: '482913' } },
    });
    const onapproved = vi.fn();
    render(RemoteSignIn, { withdrawn: false, onapproved });
    await fireEvent.click(await screen.findByRole('button', { name: 'Ask for access' }));
    expect((await screen.findByLabelText('Code 4 8 2 9 1 3')).textContent).toContain('482 913');
    expect(JSON.parse(sessionStorage.getItem('masthead.pairing')!).pollSecret).toBe('s1');
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(2100);
    await waitFor(() => expect(onapproved).toHaveBeenCalledWith('t'.repeat(64)));
    const poll = calls.find((c) => c.url.startsWith('/api/remote/request/'))!;
    expect(JSON.parse(String(poll.init!.body))).toEqual({ pollSecret: 's1' });
    expect(sessionStorage.getItem('masthead.pairing')).toBeNull();
  });

  it('after a reload with a waiting request, polls again instead of asking', async () => {
    sessionStorage.setItem('masthead.pairing', JSON.stringify({ requestId: 'b'.repeat(24), pollSecret: 's2', code: '111222' }));
    const calls = stubFetch({
      '/api/remote/whoami': { body: { state: 'unknown', device: { name: 'phone' } } },
      '/api/remote/request/': { body: { state: 'pending' } },
    });
    render(RemoteSignIn, { withdrawn: false, onapproved: vi.fn() });
    expect(await screen.findByLabelText('Code 1 1 1 2 2 2')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2100);
    expect(calls.some((c) => c.url === '/api/remote/request')).toBe(false);
    expect(calls.some((c) => c.url === `/api/remote/request/${'b'.repeat(24)}`)).toBe(true);
  });

  it('says plainly when not allowed, refused, too many, or withdrawn', async () => {
    stubFetch({
      '/api/remote/whoami': { body: { state: 'unknown', device: { name: 'phone' } } },
      '/api/remote/request/': { body: { state: 'gone' } },
      '/api/remote/request': { body: { requestId: 'c'.repeat(24), pollSecret: 's', code: '000111' } },
    });
    render(RemoteSignIn, { withdrawn: true, onapproved: vi.fn() });
    expect(screen.getByText('This computer withdrew access for this device.')).toBeTruthy();
    await fireEvent.click(await screen.findByRole('button', { name: 'Ask for access' }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(await screen.findByText('This device was not allowed, or the request ran out.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeTruthy();
  });

  it('a refused device and a rate limit get their reason', async () => {
    stubFetch({ '/api/remote/whoami': { body: { state: 'refused', reason: 'tagged devices are not allowed' } } });
    render(RemoteSignIn, { withdrawn: false, onapproved: vi.fn() });
    expect(await screen.findByText('This computer does not accept this device: tagged devices are not allowed.')).toBeTruthy();
  });

  it('an approved stored token connects at once', async () => {
    localStorage.setItem('masthead.device', 'd'.repeat(64));
    const calls = stubFetch({ '/api/remote/whoami': { body: { state: 'approved', role: 'read', device: { name: 'phone' } } } });
    const onapproved = vi.fn();
    render(RemoteSignIn, { withdrawn: false, onapproved });
    await waitFor(() => expect(onapproved).toHaveBeenCalledWith('d'.repeat(64)));
    expect((calls[0]!.init!.headers as Record<string, string>)['x-masthead-device']).toBe('d'.repeat(64));
  });
});
