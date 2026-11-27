<script lang="ts">
  // Stored pictures of one message or tool result as a row of thumbnails; a click opens the viewer.
  import type { BlobRef } from '../../../../shared/protocol.ts';
  import { blobUrl } from '../images.ts';
  import { store } from '../store.svelte.ts';
  import { T } from '../text.ts';
  import ImageViewer from './ImageViewer.svelte';

  let { refs, label }: { refs: BlobRef[]; label: string } = $props();
  const MAX = 4;
  let viewing = $state<number | null>(null);
  const urls = $derived(
    refs.map((r, i) => ({ src: blobUrl(store.convId ?? '', r, store.blobToken), alt: `${label} ${i + 1}`, w: r.w, h: r.h })),
  );
</script>

<div class="thumbs">
  {#each urls.slice(0, MAX) as u, i (refs[i]!.blob + i)}
    <button class="thumb" onclick={() => (viewing = i)} aria-label={T.images.open(u.alt)}>
      <img src={u.src} alt="" width={refs[i]!.w} height={refs[i]!.h} loading="lazy" decoding="async" />
      {#if i === MAX - 1 && refs.length > MAX}<span class="more">+{refs.length - MAX}</span>{/if}
    </button>
  {/each}
</div>
{#if viewing !== null}
  <ImageViewer {urls} index={viewing} onclose={() => (viewing = null)} />
{/if}

<style>
  .thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 4px 0;
  }
  .thumb {
    position: relative;
    display: block;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--border);
    background: var(--panel);
  }
  .thumb img {
    display: block;
    width: auto;
    height: 120px;
    max-width: 220px;
    object-fit: contain;
  }
  .more {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 50%);
    color: #fff;
    font-weight: 600;
  }
</style>
