<script lang="ts">
  import { T } from '../text.ts';
  import type { Draft } from '../../../../shared/protocol.ts';
  import { renderDraft } from '../markdown.ts';

  let { draft }: { draft: Draft } = $props();

  // At most one render per frame, however fast the updates come.
  let shown = $state('');
  let frame = 0;
  $effect(() => {
    const text = draft.kind === 'text' ? draft.text : '';
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      shown = renderDraft(text);
    });
    return () => frame && cancelAnimationFrame(frame);
  });
</script>

{#if draft.kind === 'text'}
  <div class="md assistant streaming">{@html shown}</div>
{:else if draft.text}
  <div class="thinking-live muted">{T.transcript.thinking} {draft.text.slice(-140)}</div>
{/if}

<style>
  .streaming::after {
    content: '';
    display: inline-block;
    width: 7px;
    height: 15px;
    margin-left: 2px;
    vertical-align: text-bottom;
    background: var(--accent);
    animation: pulse 1s steps(2) infinite;
  }
  .thinking-live {
    font-size: 13.5px;
    color: var(--muted);
    cursor: default;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
