<script lang="ts">
  import { tick } from 'svelte';
  import type { Item } from '../../../shared/protocol.ts';
  import { handleCopyClick } from './markdown.ts';
  import { store } from './store.svelte.ts';
  import DraftView from './transcript/DraftView.svelte';
  import InboundItem from './transcript/InboundItem.svelte';
  import NoticeItem from './transcript/NoticeItem.svelte';
  import StatusLine from './transcript/StatusLine.svelte';
  import TextItem from './transcript/TextItem.svelte';
  import ThinkingItem from './transcript/ThinkingItem.svelte';
  import ToolItem from './transcript/ToolItem.svelte';
  import UserItem from './transcript/UserItem.svelte';

  let scroller = $state<HTMLDivElement | null>(null);
  let pinned = $state(true);

  const items = $derived(store.viewItems);
  const draft = $derived(store.viewDraft);
  const agent = $derived(store.viewAgent);
  // A tool that is still running already says what the agent is doing.
  const toolRunning = $derived(items.some((i) => i.kind === 'tool' && !i.done));

  function onScroll() {
    if (!scroller) return;
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }

  // Follow new output only while the reader is at the bottom.
  $effect(() => {
    void items.length;
    void draft?.text;
    void agent?.id;
    void agent?.status;
    if (pinned && scroller) {
      const el = scroller;
      void tick().then(() => (el.scrollTop = el.scrollHeight));
    }
  });

  // Opening another agent or conversation starts at the bottom.
  $effect(() => {
    void store.viewAgentId;
    void store.convId;
    pinned = true;
  });

  function toBottom() {
    pinned = true;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  const key = (item: Item) => item.id;
</script>

<div class="scroll" bind:this={scroller} onscroll={onScroll}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="column" onclick={handleCopyClick}>
    {#if store.convId === null}
      <div class="hello">
        <h1>What are we working on?</h1>
        <p class="muted">You talk to the lead. It brings in more agents when the work calls for it.</p>
      </div>
    {:else if items.length === 0 && !draft && agent && agent.status !== 'running' && agent.status !== 'queued'}
      <p class="muted center">Nothing here yet.</p>
    {/if}

    {#each items as item (key(item))}
      {#if item.kind === 'user'}
        <UserItem {item} />
      {:else if item.kind === 'text'}
        <TextItem {item} />
      {:else if item.kind === 'thinking'}
        <ThinkingItem {item} />
      {:else if item.kind === 'tool'}
        <ToolItem {item} />
      {:else if item.kind === 'inbound'}
        <InboundItem {item} />
      {:else if item.kind === 'notice'}
        <NoticeItem {item} />
      {/if}
    {/each}

    {#if draft}
      <DraftView {draft} />
    {/if}

    {#if agent && !draft && store.convId !== null}
      <StatusLine {agent} {toolRunning} />
    {/if}
    {#if store.creating}
      <div class="working"><span class="dot running"></span>Starting…</div>
    {/if}
  </div>
</div>
{#if !pinned}
  <button class="jump" onclick={toBottom} aria-label="Jump to latest">↓</button>
{/if}

<style>
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px 20px 12px;
    scroll-behavior: auto;
  }
  .column {
    max-width: 768px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .hello {
    margin: 18vh 0 8px;
    text-align: center;
  }
  .hello h1 {
    margin: 0 0 8px;
    font-family: var(--serif);
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .center {
    text-align: center;
    margin-top: 12vh;
  }
  /* The "Starting…" line; StatusLine.svelte has the same rule for its lines. */
  .working {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13.5px;
    color: var(--muted);
    min-height: 22px;
  }
  .jump {
    position: absolute;
    left: 50%;
    bottom: 120px;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    background: var(--raised);
    box-shadow: var(--shadow);
    transform: translateX(-50%);
  }
</style>
