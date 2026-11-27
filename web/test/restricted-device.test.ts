// What the page shows on a remote device whose role is limited (read, approve): no control the
// server would refuse (server/remote/authorise.ts allowedMessage), and plain words where they would be.
import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, CompactState, ConversationMeta, PermissionRequest } from '../../shared/protocol.ts';
import App from '../src/App.svelte';
import PermissionCard from '../src/lib/PermissionCard.svelte';
import CompactCard from '../src/lib/team/CompactCard.svelte';
import { store } from '../src/lib/store.svelte.ts';
import { T } from '../src/lib/text.ts';

const ag = (name: string, over: Partial<AgentInfo> = {}): AgentInfo =>
  ({ id: name, convId: 'c', name, tier: name === 'alpha' ? 'lead' : 'sonnet', parentId: name === 'alpha' ? null : 'alpha', title: '', task: '', status: 'done', model: 'claude-sonnet-5-5', effort: 'low', createdAt: name === 'alpha' ? 0 : 1, usage: { context: 0, contextMax: 1, output: 0, costUsd: 0, turns: 0 }, ...over }) as AgentInfo;

const permission = (): PermissionRequest => ({
  id: 'p1', convId: 'c', agentId: 'alpha', agentName: 'alpha', kind: 'permission', toolName: 'Bash', input: { command: 'ls' }, canAlways: true, ts: 0,
});
const question = (): PermissionRequest => ({
  id: 'q1', convId: 'c', agentId: 'alpha', agentName: 'alpha', kind: 'question', toolName: 'AskUserQuestion', input: {}, canAlways: false, ts: 0,
  questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
});

function chat(leadStatus: AgentInfo['status'], helpers: AgentInfo[] = []) {
  store.conversations = [{ id: 'c', title: 'My chat', cwd: '/tmp', busy: leadStatus === 'running', createdAt: 0, updatedAt: 0 } as unknown as ConversationMeta];
  store.convId = 'c';
  store.agents = Object.fromEntries([ag('alpha', { status: leadStatus }), ...helpers].map((a) => [a.id, a]));
}

let sent: { t: string }[] = [];
beforeEach(() => {
  sent = [];
  vi.spyOn(store, 'connect').mockImplementation(() => {});
  vi.spyOn(store, 'send').mockImplementation((m) => (sent.push(m as { t: string }), true));
  vi.spyOn(store, 'answer').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  store.deviceRole = null;
  store.pending = [];
  store.compact = null;
  store.agents = {};
  store.conversations = [];
  store.convId = null;
});

describe('a read-only device', () => {
  beforeEach(() => (store.deviceRole = 'read'));

  it('has no message box; the note says why and how to get more, with no stop buttons', () => {
    chat('running', [ag('bravo', { status: 'running' })]);
    const { container } = render(App);
    expect(container.querySelector('#message')).toBeNull();
    const note = container.querySelector('.role-line')!;
    expect(note.textContent).toContain(T.device.roleRead);
    expect(note.textContent).toContain(T.device.askMore);
    expect(note.querySelectorAll('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: T.composer.stopAll })).toBeNull();
    expect(screen.queryByRole('button', { name: T.composer.stop })).toBeNull();
  });

  it('cannot rename the chat (the title is not a button)', () => {
    chat('done');
    const { container } = render(App);
    expect(container.querySelector('header .title-btn')).toBeNull();
    expect(screen.getByText('My chat', { selector: '.title-text' })).toBeTruthy();
  });

  it('cannot start or delete chats', () => {
    chat('done');
    render(App);
    expect(screen.queryByRole('button', { name: new RegExp(T.shell.newChat) })).toBeNull();
    expect(screen.queryByRole('button', { name: T.shell.deleteChat })).toBeNull();
  });

  it('sees a waiting permission request, with no Allow or Deny, and the reason', () => {
    chat('waiting');
    store.pending = [permission()];
    render(App);
    expect(screen.getByRole('alertdialog', { name: T.card.permission('Alpha') })).toBeTruthy();
    for (const name of [T.card.allow, T.card.deny, T.card.always]) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByText(T.device.cannotAnswer)).toBeTruthy();
  });

  it('sees a question with its choices greyed out and no Answer or Skip', () => {
    render(PermissionCard, { request: question() });
    expect((screen.getByRole('button', { name: 'A' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText(T.card.other) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: T.card.answer })).toBeNull();
    expect(screen.queryByRole('button', { name: T.card.skip })).toBeNull();
    expect(screen.getByText(T.device.cannotAnswer)).toBeTruthy();
  });

  it('sees the tidy-up proposal but cannot answer it, and is told so', () => {
    store.convId = 'c';
    store.compact = { id: 'k', phase: 'proposed', keep: [{ name: 'bravo', why: '' }], archive: ['charlie'], note: '', pending: [], failed: [], startedAt: 0 } as CompactState;
    render(CompactCard);
    expect((screen.getByRole('checkbox', { name: /Charlie/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: T.compact.confirm })).toBeNull();
    expect(screen.getByText(T.device.cannotTidy)).toBeTruthy();
  });

  it('an archived helper offers no Restore, and the note still explains', () => {
    chat('done', [ag('bravo', { archived: 5 } as Partial<AgentInfo>)]);
    store.viewAgentId = 'bravo';
    const { container } = render(App);
    expect(screen.queryByRole('button', { name: T.compact.restore })).toBeNull();
    expect(container.querySelector('.role-line')!.textContent).toContain(T.device.roleRead);
    store.viewAgentId = null;
  });
});

describe('an approve device', () => {
  beforeEach(() => (store.deviceRole = 'approve'));

  it('has no message box; the note says what it may do and how to get more', () => {
    chat('done');
    const { container } = render(App);
    expect(container.querySelector('#message')).toBeNull();
    expect(container.querySelector('.role-line')!.textContent).toContain(T.device.roleApprove);
    expect(container.querySelector('.role-line')!.textContent).toContain(T.device.askMore);
    // Nothing running: nothing to stop.
    expect(container.querySelectorAll('.role-line button')).toHaveLength(0);
  });

  it('may answer: Allow and Deny are there and send the answer', async () => {
    chat('waiting');
    store.pending = [permission()];
    render(App);
    await fireEvent.click(screen.getByRole('button', { name: T.card.allow }));
    expect(store.answer).toHaveBeenCalledWith('p1', 'allow');
    expect(screen.getByRole('button', { name: T.card.deny })).toBeTruthy();
    expect(screen.queryByText(T.device.cannotAnswer)).toBeNull();
  });

  it('may stop the reply and all helpers, which the message box held', async () => {
    chat('running', [ag('bravo', { status: 'running' })]);
    render(App);
    await fireEvent.click(screen.getByRole('button', { name: T.device.stopReply }));
    await fireEvent.click(screen.getByRole('button', { name: T.composer.stopAll }));
    expect(sent.map((m) => m.t)).toEqual(['interrupt', 'stop_all']);
  });

  it('cannot rename the chat', () => {
    chat('done');
    const { container } = render(App);
    expect(container.querySelector('header .title-btn')).toBeNull();
  });
});

describe('this computer', () => {
  it('keeps the message box and no role note', () => {
    chat('done');
    const { container } = render(App);
    expect(container.querySelector('#message')).not.toBeNull();
    expect(container.querySelector('.role-line')).toBeNull();
    expect(container.querySelector('header .title-btn')!.textContent).toBe('My chat');
  });
});
