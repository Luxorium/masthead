<script lang="ts">
  import type { Item } from '../../../../shared/protocol.ts';

  let { item }: { item: Extract<Item, { kind: 'notice' }> } = $props();
</script>

<div class="notice" class:error={item.level === 'error'}>{item.text}</div>

<style>
  .notice {
    align-self: center;
    max-width: 90%;
    font-size: 13px;
    color: var(--faint);
    text-align: center;
    overflow-wrap: anywhere;
  }
  .notice.error {
    color: var(--bad);
  }
</style>
