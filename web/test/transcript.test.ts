// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import type { AgentInfo, Item } from '../../shared/protocol.ts';
import Transcript from '../src/lib/Transcript.svelte';
import { store } from '../src/lib/store.svelte.ts';

const lead: AgentInfo = {
  id: 'L', convId: 'c', name: 'alpha', tier: 'lead', parentId: null, title: '', task: '', status: 'idle',
  model: 'm', effort: 'low', createdAt: 0, usage: { context: 0, contextMax: 1, output: 0, costUsd: 0, turns: 0 },
};

function longChat(n: number): Item[] {
  return Array.from({ length: n }, (_, i): Item =>
    i % 3 === 0
      ? { id: `u${i}`, ts: i, kind: 'user', text: `question ${i}` }
      : { id: `t${i}`, ts: i, kind: 'text', text: `Answer **${i}** with a list:\n\n- a\n- b\n\n\`\`\`js\nconst x = ${i};\n\`\`\`` },
  );
}

describe('Transcript with a long chat', () => {
  it('renders only the newest page and adds earlier pages on request', async () => {
    store.convId = 'c';
    store.agents = { L: lead };
    store.items = { L: longChat(2000) };
    const t0 = performance.now();
    const { container, getByRole } = render(Transcript);
    const ms = performance.now() - t0;
    console.log(`2000-item chat: first render ${ms.toFixed(0)} ms, ${container.querySelectorAll('*').length} DOM nodes`);
    expect(container.querySelectorAll('.item')).toHaveLength(80);
    await fireEvent.click(getByRole('button', { name: /Show earlier/ }));
    await tick();
    expect(container.querySelectorAll('.item')).toHaveLength(160);
  });
});
