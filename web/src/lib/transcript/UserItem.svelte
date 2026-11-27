<script lang="ts">
  import type { Item } from '../../../../shared/protocol.ts';

  let { item }: { item: Extract<Item, { kind: 'user' }> } = $props();
</script>

<div class="user">
  <div class="bubble">
    {#if item.images}<div class="attached">{item.images} image{item.images > 1 ? 's' : ''} attached</div>{/if}
    {item.text}
  </div>
</div>

<style>
  .user {
    display: flex;
    justify-content: flex-end;
  }
  .bubble {
    max-width: 85%;
    padding: 9px 14px;
    border-radius: 14px;
    background: var(--user-bubble);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .attached {
    margin-bottom: 4px;
    font-size: 12.5px;
    color: var(--muted);
  }
</style>
