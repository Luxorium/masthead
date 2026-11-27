import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../shared/protocol.ts';
import PermissionCard from '../src/lib/PermissionCard.svelte';
import { store } from '../src/lib/store.svelte.ts';

const question = (): PermissionRequest => ({
  id: 'r1', convId: 'c', agentId: 'a', agentName: 'bravo', kind: 'question', toolName: 'AskUserQuestion', input: {},
  canAlways: false, ts: 0,
  questions: [
    { question: 'Which?', options: [{ label: 'A' }, { label: 'A' }] },
    { question: 'Which?', options: [{ label: 'B' }, { label: 'C' }] },
  ],
});

describe('PermissionCard', () => {
  it('names the agent and takes focus when nobody is typing', async () => {
    render(PermissionCard, { request: question() });
    const card = screen.getByRole('alertdialog', { name: 'Question from Bravo' });
    await Promise.resolve();
    expect(document.activeElement).toBe(card);
  });

  it('keeps both answers when two questions share their text', async () => {
    const answer = vi.spyOn(store, 'answer').mockImplementation(() => {});
    render(PermissionCard, { request: question() });
    const [a] = screen.getAllByRole('button', { name: 'A' });
    await fireEvent.click(a!);
    await fireEvent.click(screen.getByRole('button', { name: 'C' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(answer).toHaveBeenCalledWith('r1', 'allow', { 'Which?': 'A | C' });
  });
});
