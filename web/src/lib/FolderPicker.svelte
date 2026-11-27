<script lang="ts">
  import { onMount } from 'svelte';
  import { shortPath, store } from './store.svelte.ts';

  let { onclose }: { onclose: () => void } = $props();
  let typed = $state(store.newCwd);

  onMount(() => {
    store.send({ t: 'dirs', path: store.newCwd });
  });

  $effect(() => {
    if (store.dirs) typed = store.dirs.path;
  });

  function go(path: string) {
    store.send({ t: 'dirs', path });
  }

  function choose() {
    if (!store.dirs || store.dirs.error) return;
    store.newCwd = store.dirs.path;
    onclose();
  }
</script>

<div class="picker" role="dialog" aria-label="Choose a folder">
  <form
    onsubmit={(e) => {
      e.preventDefault();
      go(typed);
    }}
  >
    <input class="mono" bind:value={typed} spellcheck="false" aria-label="Folder path" />
  </form>
  <div class="list">
    {#if store.dirs?.parent}
      <button onclick={() => go(store.dirs!.parent!)}>‹ Up to {shortPath(store.dirs.parent, store.app?.home)}</button>
    {/if}
    {#if store.dirs?.error}
      <p class="err">{store.dirs.error}</p>
    {:else}
      {#each store.dirs?.entries ?? [] as name (name)}
        <button onclick={() => go(`${store.dirs!.path === '/' ? '' : store.dirs!.path}/${name}`)}>{name}</button>
      {:else}
        <p class="muted">No folders inside.</p>
      {/each}
    {/if}
  </div>
  <div class="actions">
    <button class="btn ghost" onclick={onclose}>Cancel</button>
    <button class="btn primary" disabled={!store.dirs || !!store.dirs.error} onclick={choose}>Use this folder</button>
  </div>
</div>

<style>
  .picker {
    position: absolute;
    left: 0;
    bottom: 32px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    width: 380px;
    max-width: 86vw;
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: var(--raised);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  form {
    padding: 8px;
    border-bottom: 1px solid var(--border);
  }
  input {
    width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    font-size: 12.5px;
  }
  .list {
    max-height: 260px;
    overflow-y: auto;
    padding: 4px;
  }
  .list button {
    display: block;
    width: 100%;
    padding: 5px 10px;
    border-radius: 6px;
    text-align: left;
    font-size: 13.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .list button:hover {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .list p {
    margin: 0;
    padding: 6px 10px;
    font-size: 13px;
  }
  .err {
    color: var(--bad);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--border);
  }
</style>
