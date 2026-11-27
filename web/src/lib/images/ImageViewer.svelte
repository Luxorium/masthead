<script lang="ts">
  // A picture at full size over the page: Esc or × closes, ← → move between the pictures of the same
  // message, focus returns to the thumbnail that opened it.
  import { onMount, tick } from 'svelte';
  import { T } from '../text.ts';

  let { urls, index = 0, onclose }: { urls: { src: string; alt: string; w: number; h: number }[]; index?: number; onclose: () => void } = $props();
  // Starts at the picture that was clicked; the viewer is mounted afresh for each opening.
  // svelte-ignore state_referenced_locally
  let at = $state(index);
  let box = $state<HTMLDivElement | null>(null);
  const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

  onMount(() => {
    void tick().then(() => box?.focus());
    return () => opener?.focus();
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    } else if (e.key === 'ArrowRight' && at < urls.length - 1) at++;
    else if (e.key === 'ArrowLeft' && at > 0) at--;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="viewer" role="dialog" aria-modal="true" aria-label={T.images.viewer} tabindex="-1" bind:this={box} onkeydown={onKey}>
  <div class="bar">
    <span class="count">{urls.length > 1 ? T.images.of(at + 1, urls.length) : ''} {urls[at]!.w} × {urls[at]!.h}</span>
    <!-- The link carries this socket's blob token into the new tab's history. Accepted: the token is per
         socket and stops working about a minute after that socket closes (security review, 0.2.0). -->
    <a class="btn ghost" href={urls[at]!.src} target="_blank" rel="noopener noreferrer">{T.images.openTab}</a>
    <button class="btn ghost close" onclick={onclose} aria-label={T.images.close}>×</button>
  </div>
  <div class="frame">
    {#if at > 0}<button class="nav prev" onclick={() => at--} aria-label={T.images.prev}>‹</button>{/if}
    <img src={urls[at]!.src} alt={urls[at]!.alt} />
    {#if at < urls.length - 1}<button class="nav next" onclick={() => at++} aria-label={T.images.next}>›</button>{/if}
  </div>
</div>

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    background: rgb(10 12 16 / 92%);
    color: #e7eaf0;
    outline: none;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: calc(8px + env(safe-area-inset-top)) 12px 8px;
  }
  .count {
    flex: 1;
    font-size: 13px;
    color: #b8bfcc;
  }
  .bar .btn {
    color: #e7eaf0;
  }
  .close {
    min-width: 44px;
    font-size: 20px;
  }
  .frame {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    overflow: auto;
    padding: 12px;
  }
  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 44px;
    height: 64px;
    border-radius: 8px;
    background: rgb(255 255 255 / 10%);
    color: #fff;
    font-size: 28px;
  }
  .prev {
    left: 12px;
  }
  .next {
    right: 12px;
  }
</style>
