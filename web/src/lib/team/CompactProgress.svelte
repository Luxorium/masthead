<script lang="ts">
  // A quiet status line while the team is being tidied (a compaction), with Cancel while it may be.
  import { store } from '../store.svelte.ts';
  import { T } from '../text.ts';

  const c = $derived(store.compact);
  const running = $derived(!!c && (c.phase === 'asked' || c.phase === 'archiving' || c.phase === 'compacting'));
  const total = $derived(c ? c.keep.length : 0);
  const done = $derived(c ? Math.max(0, total - c.pending.length) : 0);
  const words = $derived(
    !c ? '' : c.phase === 'asked' ? T.compact.asking : c.phase === 'archiving' ? T.compact.archiving : total > 0 ? T.compact.progress(done, total) : T.compact.working,
  );
</script>

{#if running}
  <div class="tidy" role="status">
    <span class="dot running" aria-hidden="true"></span>
    <span class="words">{words}</span>
    {#if store.mayAnswer}
      <button class="btn ghost" onclick={() => store.cancelCompact()}>{T.compact.stop}</button>
    {/if}
  </div>
{/if}

<style>
  .tidy {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    font-size: 13px;
    color: var(--muted);
  }
  .words {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .btn {
    padding: 2px 10px;
  }
</style>
