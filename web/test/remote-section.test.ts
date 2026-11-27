import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeviceRequestCard from '../src/lib/remote/DeviceRequestCard.svelte';
import RemoteSection from '../src/lib/remote/RemoteSection.svelte';
import type { RemoteState } from '../src/lib/remote/types.ts';
import { store } from '../src/lib/store.svelte.ts';

const base = (over: Partial<RemoteState> = {}): RemoteState => ({
  enabled: false, port: 7443, available: true, serve: 'off', target: 'socket', allowOtherTailnets: false, allowTagged: false, devices: [], requests: [], ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
  store.remote = null;
});

describe('DeviceRequestCard', () => {
  const req = { id: 'r1', nodeName: 'phone', os: 'iOS', user: { login: 'me@example.com', name: 'Me' }, address: '100.64.0.2', code: '482913', createdAt: 0 };
  it('shows the device and the code, starts at read only, warns for everything, and sends the decision with the role', async () => {
    const sent = vi.spyOn(store, 'request').mockReturnValue(true);
    render(DeviceRequestCard, { request: req });
    const card = screen.getByRole('alertdialog', { name: 'phone asks to use Masthead' });
    expect((card).textContent).toContain('iOS · me@example.com · 100.64.0.2');
    expect((screen.getByLabelText('Code 4 8 2 9 1 3')).textContent).toContain('482 913');
    // Read only is first and already chosen, and the button says what it allows.
    const group = screen.getByRole('group', { name: 'What it may do' });
    const radios = Array.from(group.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['read', 'approve', 'full']);
    expect((screen.getByRole('radio', { name: /Read only/ }) as HTMLInputElement).checked).toBe(true);
    expect(card.textContent).toContain('It cannot send, answer or stop anything.');
    expect(card.textContent).not.toContain('including running commands. Choose it only');
    await fireEvent.click(screen.getByRole('button', { name: 'Allow, read only' }));
    expect(sent).toHaveBeenCalledWith({ t: 'device_decision', requestId: 'r1', decision: 'allow', role: 'read' });
    // Choosing Everything warns plainly and the button changes with it.
    await fireEvent.click(screen.getByRole('radio', { name: /Everything/ }));
    expect(card.textContent).toContain('Everything lets this device do anything you can do here, including running commands');
    await fireEvent.click(screen.getByRole('button', { name: 'Allow everything' }));
    expect(sent).toHaveBeenLastCalledWith({ t: 'device_decision', requestId: 'r1', decision: 'allow', role: 'full' });
    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(sent).toHaveBeenLastCalledWith({ t: 'device_decision', requestId: 'r1', decision: 'deny' });
    await Promise.resolve();
    expect(document.activeElement).toBe(card);
  });
});

describe('RemoteSection', () => {
  it('switches on, shows the address, and locks the port while on', async () => {
    const sent = vi.spyOn(store, 'request').mockReturnValue(true);
    store.remote = base() as never;
    const { rerender } = render(RemoteSection);
    await fireEvent.click(screen.getByLabelText('Allow my other devices to connect'));
    expect(sent).toHaveBeenCalledWith({ t: 'remote_settings', enabled: true });
    store.remote = base({ enabled: true, serve: 'ours', url: 'https://host.example.ts.net:7443' }) as never;
    await rerender({});
    expect((screen.getByRole('status')).textContent).toContain('Open this address on your other device: https://host.example.ts.net:7443');
    expect((screen.getByLabelText('Port') as HTMLInputElement).disabled).toBe(true);
  });

  it('after a refused switch-on the box follows the real state, and the command is shown', async () => {
    vi.spyOn(store, 'request').mockReturnValue(true);
    vi.spyOn(store, 'fail').mockImplementation(() => {});
    store.remote = base() as never;
    const { rerender } = render(RemoteSection);
    const box = screen.getByLabelText('Allow my other devices to connect') as HTMLInputElement;
    await fireEvent.click(box);
    expect(box.checked).toBe(true);
    // The refusal: an error, and a state that is still off but carries the problem and the command.
    store.receive({ t: 'error', message: 'refused' } as never);
    expect(box.checked).toBe(false);
    await fireEvent.click(box);
    const cmd = 'sudo tailscale serve --bg --https=7443 unix:/run/user/1000/masthead/remote.sock';
    store.remote = base({ problem: "Tailscale needs your password once to share Masthead's private connection.", command: cmd }) as never;
    await rerender({});
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    expect(screen.getByText(cmd)).toBeTruthy();
    expect(screen.getByText('Run this once in a terminal:')).toBeTruthy();
  });

  it('shows the operator command with Copy, the Windows warning as sent, and Tailscale missing', async () => {
    store.remote = base({ problem: 'Tailscale did not let Masthead change its settings.', command: 'sudo tailscale set --operator=ann', target: 'loopback', warning: 'On this computer Tailscale reaches Masthead through a local port…' }) as never;
    render(RemoteSection);
    expect(screen.getByText('sudo tailscale set --operator=ann')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy: sudo tailscale set --operator=ann' })).toBeTruthy();
    expect(screen.getByText('On this computer Tailscale reaches Masthead through a local port…')).toBeTruthy();
    store.remote = null;
  });

  it('lists devices with role change, removal, last use and expiry; loads the activity', async () => {
    const sent = vi.spyOn(store, 'request').mockReturnValue(true);
    let auditFn: ((m: Record<string, unknown>) => void) | null = null;
    vi.spyOn(store, 'listen').mockImplementation((t, fn) => {
      if (t === 'remote_audit') auditFn = fn;
      return () => {};
    });
    store.remote = base({ devices: [{ nodeId: 'n1', nodeName: 'phone', os: 'iOS', address: '100.64.0.2', role: 'full', createdAt: 0, lastSeen: 1_700_000_000_000, expiresAt: 1_702_000_000_000 }] }) as never;
    render(RemoteSection);
    const item = screen.getByRole('listitem', { name: 'Device phone' });
    expect((item).textContent).toContain('Last used');
    expect((item).textContent).toContain('renewed when used');
    await fireEvent.change(screen.getByLabelText('What phone may do'), { target: { value: 'approve' } });
    expect(sent).toHaveBeenCalledWith({ t: 'device_role', nodeId: 'n1', role: 'approve' });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove phone' }));
    expect(sent).toHaveBeenCalledWith({ t: 'device_revoke', nodeId: 'n1' });
    await fireEvent.click(screen.getByRole('button', { name: 'Show recent activity' }));
    expect(sent).toHaveBeenCalledWith({ t: 'remote_audit' });
    auditFn!({ t: 'remote_audit', entries: [{ ts: 1, event: 'request', nodeName: 'phone' }, { ts: 2, event: 'allow', nodeName: 'phone', detail: 'full' }] });
    expect(await screen.findByText(/phone was allowed \(everything\)/)).toBeTruthy();
  });
});
