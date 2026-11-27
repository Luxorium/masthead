import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentInfo, AgentStatus, Item } from '../../shared/protocol.ts';
import Transcript from '../src/lib/Transcript.svelte';
import AnswerMarker from '../src/lib/transcript/AnswerMarker.svelte';
import StatusLine from '../src/lib/transcript/StatusLine.svelte';
import TeamOutline from '../src/lib/team/TeamOutline.svelte';
import { endsWithQuestion, fmtSpan, noteAgent, noteOutput, openQuestion, quietSpan, spanWords } from '../src/lib/progress.ts';
import { progress } from '../src/lib/progress.svelte.ts';
import { store } from '../src/lib/store.svelte.ts';
import { ui } from '../src/lib/ui.svelte.ts';

const MIN = 60_000;
const ag = (name: string, parentId: string | null, status: AgentStatus, extra: Partial<AgentInfo> = {}): AgentInfo =>
  ({ id: name, convId: 'c', name, tier: parentId ? 'sonnet' : 'lead', parentId, title: `${name} job`, task: '', status, model: 'claude-sonnet-5-5', effort: 'low', createdAt: 0, usage: { context: 0, contextMax: 1, output: 0, costUsd: 0, turns: 0 }, ...extra }) as AgentInfo;
const text = (id: string, t: string): Item => ({ id, ts: 0, kind: 'text', text: t });
const user = (id: string, t: string): Item => ({ id, ts: 0, kind: 'user', text: t });
const tool = (id: string): Item => ({ id, ts: 0, kind: 'tool', name: 'Read', input: {}, done: true }) as unknown as Item;

describe('time on an activity', () => {
  it('keeps the start while the activity is unchanged and restarts it on a change', () => {
    const a = ag('bravo', 'alpha', 'running', { activity: 'Reading small.png' });
    const m1 = noteAgent(undefined, a, 1000, true);
    expect(noteAgent(m1, { ...a, usage: { ...a.usage, turns: 3 } }, 5000, true)).toBe(m1);
    const m2 = noteAgent(m1, { ...a, activity: 'Writing notes.md' }, 9000, true);
    expect(m2.since).toBe(9000);
  });
  it('counts from the later of the activity start and the last output', () => {
    const m = noteAgent(undefined, ag('b', 'a', 'running'), 0, true);
    expect(quietSpan(m, 4 * MIN)).toEqual({ ms: 4 * MIN, exact: true });
    const out = noteOutput(m, 3 * MIN, 4 * MIN)!;
    expect(quietSpan(out, 4 * MIN)!.ms).toBe(MIN);
    expect(noteOutput(out, 10 * MIN, 5 * MIN)!.output).toBe(5 * MIN); // a server clock ahead is clamped to now
  });
  it('says a lower bound as "over", and hides one under a minute', () => {
    const lower = noteAgent(undefined, ag('b', 'a', 'running'), 0, false);
    expect(spanWords(lower, 30_000)).toBe('');
    expect(spanWords(lower, 4 * MIN + 5000)).toBe('over 4 min');
    expect(quietSpan(noteOutput(lower, MIN, 2 * MIN), 3 * MIN)).toEqual({ ms: 2 * MIN, exact: true });
  });
  it('words spans plainly', () => {
    expect(fmtSpan(10_000)).toBe('under 1 min');
    expect(fmtSpan(4 * MIN + 59_000)).toBe('4 min');
    expect(fmtSpan(65 * MIN)).toBe('1 h 5 min');
    expect(fmtSpan(120 * MIN)).toBe('2 h');
  });
});

describe('the lead\'s open question', () => {
  it('knows a question when it sees one', () => {
    expect(endsWithQuestion('Which folder should I use?')).toBe(true);
    expect(endsWithQuestion('Shall I go ahead?**\n')).toBe(true);
    expect(endsWithQuestion('Which one do you want?\n\n1. The small fix\n2. The full rewrite\n')).toBe(true);
    expect(endsWithQuestion('How should I go on?\n- keep it\n  (the safe choice)\n- drop it')).toBe(true);
    expect(endsWithQuestion('Done. Next steps:\n1. tests\n2. docs')).toBe(false);
    expect(endsWithQuestion('Is it done? Yes, it is.')).toBe(false);
  });
  it('is open only when more came after it and the person has not written since', () => {
    const q = text('q', 'Which folder?');
    expect(openQuestion([user('u', 'hi'), q])).toBeNull(); // still the last thing: not buried
    expect(openQuestion([user('u', 'hi'), q, tool('t1'), tool('t2')])).toBe('q');
    expect(openQuestion([q, tool('t'), user('u', 'the docs one')])).toBeNull();
    expect(openQuestion([q, { id: 'r', ts: 0, kind: 'inbound', from: 'bravo', via: 'report', text: 'done' } as Item, text('x', 'Bravo finished.')])).toBe('q'); // buried by a report
    expect(openQuestion([text('x', 'All done.'), tool('t')])).toBeNull();
  });
});

describe('the live marks', () => {
  beforeEach(() => {
    store.convId = 'c';
    progress.snapshot('fresh-' + Math.random(), []);
  });
  it('come from the messages the page receives', () => {
    const b = ag('bravo', 'alpha', 'running', { activity: 'Reading small.png' });
    store.receive({ t: 'agent', agent: b });
    const since = progress.marks.bravo!.since;
    expect(progress.marks.bravo!.exact).toBe(true);
    store.receive({ t: 'agent', agent: { ...b } });
    expect(progress.marks.bravo!.since).toBe(since);
    store.receive({ t: 'draft', convId: 'c', agentId: 'bravo', draft: { kind: 'text', text: 'hi' } });
    expect(progress.marks.bravo!.output).toBeGreaterThanOrEqual(since);
    progress.now = since + 4 * MIN + 1000;
    expect(progress.span('bravo')).toBe('4 min');
  });
});

describe('on the page', () => {
  const t0 = 1_000_000;
  beforeEach(() => {
    store.convId = 'c';
    const team = [ag('alpha', null, 'waiting'), ag('bravo', 'alpha', 'running', { activity: 'Reading small.png' }), ag('charlie', 'alpha', 'waiting', { activity: undefined }), ag('delta', 'alpha', 'done')];
    store.agents = Object.fromEntries(team.map((a) => [a.id, a]));
    store.viewAgentId = null;
    progress.snapshot('page-' + Math.random(), []);
    for (const a of team) progress.agent(a, true, t0);
    progress.now = t0 + 4 * MIN + 2000;
    ui.teamOf('other');
    ui.setHideFinished(false);
  });

  it('the team outline says how long each working helper has been at it', async () => {
    const { container } = render(TeamOutline);
    progress.now = t0 + 4 * MIN + 2000; // the clock starts at the real time when the first span mounts
    await tick();
    const bravo = container.querySelector('[data-key="bravo"] .doing')!;
    expect(bravo.textContent).toBe('Reading small.png · 4 min');
    expect(container.querySelector('[data-key="delta"] > .row > .doing .since')).toBeNull(); // finished: no time
    expect(container.querySelector('[data-key="alpha"] > .row > .doing .since')).toBeNull(); // the lead: no time
    expect(screen.getAllByRole('treeitem')[1]!.getAttribute('aria-label')).toContain('Reading small.png · 4 min');
  });

  it('the time moves with the clock', async () => {
    const { container } = render(TeamOutline);
    progress.now = t0 + 9 * MIN;
    await tick();
    expect(container.querySelector('[data-key="bravo"] .since')!.textContent).toBe(' · 9 min');
  });

  it('"waiting for helpers" names them and opens to what each is doing', async () => {
    render(StatusLine, { agent: store.agents.alpha!, toolRunning: false });
    const toggle = screen.getByRole('button', { name: /Waiting for 2 helpers: Bravo, Charlie/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle);
    progress.now = t0 + 4 * MIN + 2000; // the clock starts at the real time when the first span mounts
    await tick();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(list.textContent).toContain('Reading small.png');
    expect(list.textContent).toContain('4 min');
    await fireEvent.click(screen.getByRole('button', { name: 'Charlie' }));
    expect(store.viewAgentId).toBe('charlie');
  });

  it('"Waiting for your answer" shows a buried question and goes once the person writes', async () => {
    store.items = { alpha: [user('u1', 'Tidy the docs'), text('q', 'Which folder should I use?'), tool('t1')] };
    const marker = render(AnswerMarker);
    const transcript = render(Transcript);
    const button = screen.getByRole('button', { name: /Waiting for your answer/ });
    await fireEvent.click(button);
    await tick();
    await tick();
    const q = transcript.container.querySelector('[data-item="q"]')!;
    expect(q.classList.contains('highlight')).toBe(true);
    expect(document.activeElement).toBe(q);
    store.items.alpha!.push(user('u2', 'docs/'));
    await tick();
    expect(marker.container.querySelector('.answer-marker')).toBeNull();
  });

  it('shows no marker while a helper\'s chat is open', () => {
    store.items = { alpha: [text('q', 'Which folder?'), tool('t1')] };
    store.viewAgentId = 'bravo';
    const { container } = render(AnswerMarker);
    expect(container.querySelector('.answer-marker')).toBeNull();
  });
});
