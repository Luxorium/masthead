import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, CompactState } from '../../shared/protocol.ts';
import CompactCard from '../src/lib/team/CompactCard.svelte';
import CompactProgress from '../src/lib/team/CompactProgress.svelte';
import TeamOutline from '../src/lib/team/TeamOutline.svelte';
import { store } from '../src/lib/store.svelte.ts';

const state = (over: Partial<CompactState>): CompactState => ({
  id: 'k1', phase: 'proposed', keep: [], archive: [], note: '', pending: [], failed: [], startedAt: 0, ...over,
});
const ag = (name: string, over: Partial<AgentInfo> = {}): AgentInfo =>
  ({ id: name, convId: 'c', name, tier: 'opus', parentId: name === 'alpha' ? null : 'alpha', title: `${name} job`, task: '', status: 'done', model: 'claude-opus-5-5', effort: 'low', createdAt: 0, usage: { context: 0, contextMax: 1, output: 0, costUsd: 0, turns: 0 }, ...over }) as AgentInfo;

describe('tidying the team', () => {
  beforeEach(() => {
    store.convId = 'c';
    store.deviceRole = null;
  });
  afterEach(() => {
    store.compact = null;
    vi.restoreAllMocks();
  });

  it('the card keeps forced helpers ticked and sends the ticks', async () => {
    store.compact = state({ keep: [{ name: 'bravo', why: 'still needed', forced: false }, { name: 'charlie', why: '', forced: true }], archive: ['delta'] });
    const answer = vi.spyOn(store, 'answerCompact').mockImplementation(() => {});
    render(CompactCard);
    const charlie = screen.getByRole('checkbox', { name: /Charlie/ }) as HTMLInputElement;
    expect(charlie.disabled).toBe(true);
    expect(charlie.checked).toBe(true);
    await fireEvent.click(screen.getByRole('checkbox', { name: /Delta/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Tidy up' }));
    expect(answer).toHaveBeenCalledWith(expect.arrayContaining(['bravo', 'charlie', 'delta']), true);
  });

  it('progress counts the agents done and offers Cancel', async () => {
    store.compact = state({ phase: 'compacting', keep: [{ name: 'alpha', why: '' }, { name: 'bravo', why: '' }, { name: 'charlie', why: '' }], pending: ['charlie'] });
    const cancel = vi.spyOn(store, 'cancelCompact').mockImplementation(() => {});
    render(CompactProgress);
    expect(screen.getByRole('status').textContent).toContain('Tidying the team… 2 of 3');
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalled();
  });

  it('archived helpers leave the outline and sit under one row with Restore', async () => {
    store.agents = { alpha: ag('alpha', { status: 'idle', tier: 'lead' }), bravo: ag('bravo'), golf: ag('golf', { archived: Date.now() }) };
    const restore = vi.spyOn(store, 'restoreAgent').mockImplementation(() => {});
    render(TeamOutline);
    expect(screen.queryByRole('treeitem', { name: /^Golf/ })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Archived helpers (1)' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(restore).toHaveBeenCalledWith('golf');
  });
});
