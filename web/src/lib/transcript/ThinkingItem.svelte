<script lang="ts">
  import { T } from '../text.ts';
  import type { Item } from '../../../../shared/protocol.ts';
  import { renderMarkdown } from '../markdown.ts';

  let { item }: { item: Extract<Item, { kind: 'thinking' }> } = $props();
</script>

<details class="thinking">
  <summary>{T.transcript.thought}</summary>
  <div class="md">{@html renderMarkdown(item.text)}</div>
</details>

<style>
  .thinking summary {
    font-size: 13.5px;
    color: var(--muted);
    cursor: pointer;
  }
  .thinking .md {
    margin-top: 6px;
    padding-left: 12px;
    border-left: 2px solid var(--border);
    color: var(--muted);
    font-size: 14px;
  }
</style>
