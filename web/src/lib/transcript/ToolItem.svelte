<script lang="ts">
  import { T } from '../text.ts';
  import type { Item } from '../../../../shared/protocol.ts';
  import { toolLine } from '../tools.ts';
  import { store } from '../store.svelte.ts';
  import Thumbs from '../images/Thumbs.svelte';

  let { item }: { item: Extract<Item, { kind: 'tool' }> } = $props();

  let open = $state(false);
  /** Arrived clipped (a very long input or result): opening it fetches the whole item. */
  const clipped = $derived(!!store.clipped[item.id]);
  function toggle() {
    open = !open;
    if (open && clipped && store.viewAgent) store.fetchFull(store.viewAgent.id, item.id);
  }
  const line = $derived(toolLine(item.name, item.input, !item.done));

  function pretty(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
</script>

<div class="tool" class:err={item.isError}>
  <button class="tool-line" onclick={toggle} aria-expanded={open}>
    {#if !item.done}<span class="dot running"></span>{/if}
    <span class="verb">{line.verb}</span>
    {#if line.target}<span class="target mono">{line.target}</span>{/if}
    {#if item.isError}<span class="failed">{T.transcript.failed}</span>{/if}
    <span class="chev">{open ? '▾' : '›'}</span>
  </button>
  {#if item.images?.length}
    <!-- Shown even when the line is closed: a screenshot is usually the point of the tool call. -->
    <div class="tool-images"><Thumbs refs={item.images} label={T.images.fromTool} /></div>
  {/if}
  {#if open}
    <div class="tool-body">
      <div class="tool-label">{T.transcript.input}</div>
      <pre>{pretty(item.input)}</pre>
      {#if item.result !== undefined}
        <div class="tool-label">{T.transcript.result}</div>
        <pre>{item.result || T.transcript.empty}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool {
    margin: -6px 0;
  }
  .tool-line {
    display: flex;
    align-items: center;
    gap: 7px;
    max-width: 100%;
    padding: 2px 0;
    font-size: 13.5px;
    color: var(--muted);
    text-align: left;
  }
  .tool-line:hover {
    color: var(--text);
  }
  .verb {
    flex: none;
  }
  .target {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    opacity: 0.85;
  }
  .failed {
    flex: none;
    color: var(--bad);
  }
  .chev {
    flex: none;
    color: var(--faint);
  }
  .tool-body {
    margin: 4px 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--raised);
    overflow: hidden;
  }
  .tool-label {
    padding: 6px 12px 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .tool-body pre {
    margin: 0;
    padding: 6px 12px 10px;
    max-height: 320px;
    overflow: auto;
    font: 12.5px/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .tool-images {
    margin: 4px 0 10px;
  }
</style>
