<script lang="ts">
  import type { Item } from '../../../../shared/protocol.ts';
  import { renderMarkdown } from '../markdown.ts';

  let { item }: { item: Extract<Item, { kind: 'text' }> } = $props();
</script>

<div class="md assistant">{@html renderMarkdown(item.text)}</div>
