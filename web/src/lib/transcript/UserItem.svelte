<script lang="ts">
  import type { Item } from '../../../../shared/protocol.ts';
  import { T } from '../text.ts';

  let { item }: { item: Extract<Item, { kind: 'user' }> } = $props();
  // 0.1.x stored a count; 0.2.0 stores the images themselves (shown once images land, Stage B).
  const count = $derived(Array.isArray(item.images) ? item.images.length : (item.images ?? 0));
</script>

<div class="user">
  <div class="bubble">
    {#if count > 0}<div class="attached">{T.transcript.images(count)}</div>{/if}
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
