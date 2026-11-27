<script lang="ts">
  // Shown instead of the chat when Masthead cannot find Claude Code: what to do, in plain words.
  import { store } from './store.svelte.ts';
  import { T } from './text.ts';
</script>

<section class="first-run" aria-labelledby="first-run-h">
  <h1 id="first-run-h">{T.firstRun.title}</h1>
  <p>{T.firstRun.body}</p>
  <p>
    {#each T.firstRun.install.split('`') as part, i (i)}{#if i % 2}<code>{part}</code>{:else}{part}{/if}{/each}
  </p>
  {#if store.app?.claude.error}
    <details>
      <summary>{T.firstRun.detail}</summary>
      <p class="mono detail">{store.app.claude.error}</p>
    </details>
  {/if}
  <button class="btn primary" onclick={() => location.reload()}>{T.firstRun.reload}</button>
</section>

<style>
  .first-run {
    max-width: 520px;
    margin: 14vh auto 0;
    padding: 0 24px;
  }
  h1 {
    margin: 0 0 12px;
    font-family: var(--serif);
    font-size: 28px;
    font-weight: 600;
  }
  p {
    line-height: 1.55;
  }
  details {
    margin: 12px 0 18px;
    color: var(--muted);
    font-size: 13.5px;
  }
  .detail {
    overflow-wrap: anywhere;
  }
</style>
