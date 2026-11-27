import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BackendsSection from '../src/lib/settings/BackendsSection.svelte';
import ProfileChip from '../src/lib/settings/ProfileChip.svelte';
import ProfilesSection from '../src/lib/settings/ProfilesSection.svelte';
import { store } from '../src/lib/store.svelte.ts';
import { backends, claude, codex, settings } from './settings-fixtures.ts';

beforeEach(() => {
  store.settings = settings();
  store.backends = backends() as unknown as Record<string, unknown>[];
});
afterEach(() => vi.restoreAllMocks());

describe('BackendsSection', () => {
  it('shows each program with one plain next step and its note', async () => {
    store.backends = [
      ...backends().slice(0, 1),
      { id: 'codex', label: 'Codex', available: false, path: null, version: null, signedIn: null, models: [] },
      { id: 'other', label: 'Other', available: false, path: '/x', version: '1.0.0', signedIn: false, models: [] },
      { id: 'new', label: 'Newer', available: true, path: '/y', version: '0.180.0', signedIn: true, warning: 'Codex 0.180.0 has not been tested with Masthead.', models: [] },
    ] as unknown as Record<string, unknown>[];
    render(BackendsSection);
    expect(screen.getByText('Install Codex, then press “Check again”.')).toBeTruthy();
    expect(screen.getByText('Sign in to Other in a terminal, then press “Check again”.')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/has not been tested/);
    const request = vi.spyOn(store, 'request').mockReturnValue(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(request).toHaveBeenCalledWith({ t: 'check_backends' });
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeTruthy();
  });
});

describe('ProfilesSection', () => {
  it('shows the Codex team as a proposal; using it sets the team for new chats', async () => {
    const update = vi.spyOn(store, 'updateSettings');
    render(ProfilesSection);
    const proposal = screen.getByRole('region', { name: 'A team for Codex is ready' });
    expect(within(proposal).getByText('Main assistant: GPT-6.2-Astra')).toBeTruthy();
    await fireEvent.click(within(proposal).getByRole('button', { name: 'Use it for new chats' }));
    expect(update).toHaveBeenCalled();
    expect(store.settings!.defaultProfile).toBe('codex');
    expect(screen.queryByRole('region', { name: 'A team for Codex is ready' })).toBeNull();
  });

  it('edits a team with the program’s real models, refuses a bad team in plain words, then saves', async () => {
    const update = vi.spyOn(store, 'updateSettings');
    render(ProfilesSection);
    await fireEvent.click(screen.getByRole('button', { name: 'Edit Claude' }));
    const model = screen.getAllByLabelText('Model')[1] as HTMLSelectElement;
    expect([...model.options].map((o) => o.textContent)).toEqual(['Fable 5.2', 'Opus 5.5', 'Haiku 5.5']);
    await fireEvent.change(model, { target: { value: 'claude-haiku-5-5' } });
    const thinking = screen.getAllByLabelText('Thinking time up to')[1] as HTMLSelectElement;
    expect([...thinking.options].map((o) => o.textContent)).toEqual(['Short', 'Medium', 'Long']);
    await fireEvent.input(screen.getByLabelText('Team name'), { target: { value: '' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save team' }));
    expect(screen.getByRole('alert').textContent).toMatch('Give the team a name.');
    expect(update).not.toHaveBeenCalled();
    await fireEvent.input(screen.getByLabelText('Team name'), { target: { value: 'My Claude' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add a helper level' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save team' }));
    expect(update).toHaveBeenCalledTimes(1);
    const saved = store.settings!.profiles.find((p) => p.id === 'claude')!;
    expect(saved.label).toBe('My Claude');
    expect(saved.tiers[1]!.model).toBe('claude-haiku-5-5');
    expect(saved.tiers[1]!.label).toBe('Haiku 5.5');
    expect(saved.tiers[1]!.effort).toBe('high');
    expect(saved.tiers).toHaveLength(3);
  });

  it('copies; removing asks the server, and a team chats use is removed only after a second yes', async () => {
    window.confirm = vi.fn(() => true);
    const request = vi.spyOn(store, 'request').mockReturnValue(true);
    render(ProfilesSection);
    await fireEvent.click(screen.getAllByRole('button', { name: 'Make a copy' })[0]!);
    const copy = store.settings!.profiles.find((p) => p.label === 'Claude (copy)')!;
    expect(copy).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Remove team' }));
    expect(request).toHaveBeenLastCalledWith({ t: 'delete_profile', id: copy.id });
    // The server says 3 chats use it; the person confirms again and it is sent with force.
    (store as unknown as { listeners: Map<string, Set<(m: Record<string, unknown>) => void>> }).listeners.get('error')!.forEach((fn) => fn({ t: 'error', code: 'refused', message: 'in use', inUse: { id: copy.id, chats: 3 } }));
    expect((window.confirm as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatch(/^3 chats use the team “Claude \(copy\)”/);
    expect(request).toHaveBeenLastCalledWith({ t: 'delete_profile', id: copy.id, force: true });
    // Asked again and the person says no: the team stays and the page says why in its own words.
    (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const sent = request.mock.calls.length;
    (store as unknown as { listeners: Map<string, Set<(m: Record<string, unknown>) => void>> }).listeners.get('error')!.forEach((fn) => fn({ t: 'error', code: 'refused', message: 'in use', inUse: { id: copy.id, chats: 1 } }));
    expect(request.mock.calls.length).toBe(sent);
    expect(store.error).toBe('Kept “Claude (copy)”: 1 chat uses it.');
    await fireEvent.click(screen.getAllByRole('button', { name: 'Reset to the built-in team' })[0]!);
    expect(request).toHaveBeenLastCalledWith({ t: 'reset_profile', id: 'claude' });
  });

  it('a level whose program name is invalid shows why', () => {
    const p = claude();
    p.tiers[1]!.unusable = 'Unknown agent program “x y”.';
    store.settings = settings([p, codex()]);
    render(ProfilesSection);
    expect(screen.getByText(/Unknown agent program “x y”\./)).toBeTruthy();
  });

  it('a team whose program is not ready says so and cannot be the team for new chats', () => {
    store.backends = backends(false) as unknown as Record<string, unknown>[];
    render(ProfilesSection);
    expect(screen.getByText('Needs Codex, which is not ready on this computer.')).toBeTruthy();
    const pick = screen.getByLabelText('Team for new chats') as HTMLSelectElement;
    expect([...pick.options].find((o) => o.value === 'codex')!.disabled).toBe(true);
    expect(screen.queryByRole('region', { name: 'A team for Codex is ready' })).toBeNull();
  });
});

describe('ProfileChip', () => {
  it('opens a menu of usable teams, picks one, and closes with Esc returning focus', async () => {
    const onchange = vi.fn();
    render(ProfileChip, { value: 'claude', onchange });
    const chip = screen.getByRole('button', { name: 'Uses Claude' });
    await fireEvent.click(chip);
    const menu = screen.getByRole('menu', { name: 'Choose which AI works on this chat' });
    expect(within(menu).getAllByRole('menuitemradio').map((i) => i.textContent?.trim())).toEqual(['Claude', 'Codex']);
    await fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(chip);
    await fireEvent.click(chip);
    await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Codex' }));
    expect(onchange).toHaveBeenCalledWith('codex');
  });

  it('when the asked-for team cannot start, picks the one it shows', () => {
    store.backends = backends(false) as unknown as Record<string, unknown>[];
    const onchange = vi.fn();
    render(ProfileChip, { value: 'codex', onchange });
    expect(screen.getByRole('button', { name: 'Uses Claude' })).toBeTruthy();
    expect(onchange).toHaveBeenCalledWith('claude');
  });

  it('lists only teams that can start', async () => {
    store.backends = backends(false) as unknown as Record<string, unknown>[];
    render(ProfileChip, { value: 'claude', onchange: () => {} });
    await fireEvent.click(screen.getByRole('button', { name: 'Uses Claude' }));
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1);
  });
});
