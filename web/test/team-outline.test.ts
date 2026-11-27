import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentInfo, AgentStatus } from '../../shared/protocol.ts';
import TeamOutline from '../src/lib/team/TeamOutline.svelte';
import { indent, outlineRows } from '../src/lib/team/outline.ts';
import { store } from '../src/lib/store.svelte.ts';
import { ui } from '../src/lib/ui.svelte.ts';

let n = 0;
const ag = (name: string, parentId: string | null, status: AgentStatus, tier = 'opus'): AgentInfo =>
  ({ id: name, convId: 'c', name, tier, parentId, title: `${name} job`, task: '', status, model: 'claude-opus-5-5', effort: 'low', createdAt: n++, usage: { context: 0, contextMax: 1, output: 0, costUsd: 0, turns: 0 } }) as AgentInfo;

/** alpha > bravo (running) > [charlie done, delta failed, echo running > foxtrot stopped]; golf done under alpha. */
function team(): AgentInfo[] {
  n = 0;
  return [
    ag('alpha', null, 'waiting', 'lead'),
    ag('bravo', 'alpha', 'running'),
    ag('charlie', 'bravo', 'done', 'sonnet'),
    ag('delta', 'bravo', 'failed', 'sonnet'),
    ag('echo', 'bravo', 'running', 'sonnet'),
    ag('foxtrot', 'echo', 'stopped', 'haiku'),
    ag('golf', 'alpha', 'done'),
  ];
}
const none = { collapsed: new Set<string>(), hideFinished: false, openGroups: new Set<string>() };
const names = (rows: ReturnType<typeof outlineRows>) => rows.map((r) => (r.kind === 'agent' ? `${r.agent.name}@${r.depth}` : `[${r.agents.map((a) => a.name).join(',')}]@${r.depth}`));

describe('outline rows', () => {
  it('nests helpers under whoever started them, in start order', () => {
    expect(names(outlineRows(team(), none))).toEqual(['alpha@1', 'bravo@2', 'charlie@3', 'delta@3', 'echo@3', 'foxtrot@4', 'golf@2']);
  });
  it('folds finished helpers per parent when asked, never a failed one', () => {
    const rows = outlineRows(team(), { ...none, hideFinished: true });
    expect(names(rows)).toEqual(['alpha@1', 'bravo@2', 'delta@3', 'echo@3', '[foxtrot]@4', '[charlie]@3', '[golf]@2']);
    expect(names(outlineRows(team(), { ...none, hideFinished: true, openGroups: new Set(['bravo']) }))).toContain('charlie@3');
  });
  it('leaves out a collapsed branch', () => {
    expect(names(outlineRows(team(), { ...none, collapsed: new Set(['bravo']) }))).toEqual(['alpha@1', 'bravo@2', 'golf@2']);
  });
  it('shrinks the indent past depth 4 so text keeps its room', () => {
    expect([indent(1), indent(2), indent(4), indent(5)]).toEqual([0, 16, 48, 54]);
  });
});

describe('TeamOutline', () => {
  beforeEach(() => {
    store.convId = 'c';
    store.agents = Object.fromEntries(team().map((a) => [a.id, a]));
    ui.teamOf('other');
    ui.setHideFinished(false);
  });

  it('is a tree with levels, and failed helpers keep their words', () => {
    render(TeamOutline);
    const items = screen.getAllByRole('treeitem');
    expect(items).toHaveLength(7);
    expect(items[2]!.getAttribute('aria-level')).toBe('3');
    expect(items[1]!.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('treeitem', { name: /^Delta/ }).querySelector('.row')!.classList.contains('failed')).toBe(true);
  });

  it('closes a branch with its twisty and opens it with the arrow keys', async () => {
    render(TeamOutline);
    await fireEvent.click(screen.getByRole('button', { name: 'Hide the helpers under Bravo' }));
    expect(screen.getAllByRole('treeitem')).toHaveLength(3);
    const bravo = screen.getByRole('treeitem', { name: /^Bravo/ });
    bravo.focus();
    await fireEvent.keyDown(bravo, { key: 'ArrowRight' });
    expect(screen.getAllByRole('treeitem')).toHaveLength(7);
    await fireEvent.keyDown(bravo, { key: 'ArrowLeft' });
    expect(screen.getAllByRole('treeitem')).toHaveLength(3);
  });

  it('moves focus with ↓ and keeps one tab stop', async () => {
    render(TeamOutline);
    const items = screen.getAllByRole('treeitem');
    expect(items.filter((i) => i.tabIndex === 0)).toHaveLength(1);
    items[0]!.focus();
    await fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    await tick();
    await Promise.resolve();
    expect(document.activeElement?.getAttribute('data-key')).toBe('bravo');
  });

  it('"Hide finished" folds finished helpers into one row that opens on click', async () => {
    render(TeamOutline);
    await fireEvent.click(screen.getByLabelText('Hide finished'));
    expect(screen.getByRole('treeitem', { name: '1 finished: Charlie' })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: /^Charlie/ })).toBeNull();
    expect(screen.getByRole('treeitem', { name: /^Delta/ })).toBeTruthy();
    await fireEvent.click(screen.getByText('1 finished: Charlie'));
    expect(screen.getByRole('treeitem', { name: /^Charlie/ })).toBeTruthy();
  });
});
