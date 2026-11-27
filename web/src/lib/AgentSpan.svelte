<script lang="ts">
  // " · 4 min" after what an agent is doing: how long it has been quiet on its current activity.
  // Only this span reads the clock, so the 15 s tick re-renders nothing else.
  import { progress } from './progress.svelte.ts';
  import { T } from './text.ts';

  let { agentId }: { agentId: string } = $props();

  $effect(() => progress.useClock());
  const span = $derived(progress.span(agentId));
</script>

{#if span}<span class="since" data-since={agentId}>{T.progress.sep}{span}</span>{/if}

<style>
  .since {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    /* Keeps the separator's spaces, which a flex row would otherwise drop at the item's start. */
    white-space: pre;
  }
</style>
