<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { Item } from '../../../shared/protocol.ts';
  import { handleCopyClick } from './markdown.ts';
  import { progress } from './progress.svelte.ts';
  import { store } from './store.svelte.ts';
  import DraftView from './transcript/DraftView.svelte';
  import InboundItem from './transcript/InboundItem.svelte';
  import NoticeItem from './transcript/NoticeItem.svelte';
  import StatusLine from './transcript/StatusLine.svelte';
  import TextItem from './transcript/TextItem.svelte';
  import ThinkingItem from './transcript/ThinkingItem.svelte';
  import ToolItem from './transcript/ToolItem.svelte';
  import UserItem from './transcript/UserItem.svelte';
  import { T } from './text.ts';

  /** Puts an example in the message box and focuses it, so the person can edit before sending. */
  async function useExample(text: string) {
    store.composerFor(store.composerKey).text = text;
    await tick();
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
  }

  let scroller = $state<HTMLDivElement | null>(null);
  let pinned = $state(true);

  const items = $derived(store.viewItems);
  const draft = $derived(store.viewDraft);
  const agent = $derived(store.viewAgent);
  // A tool that is still running already says what the agent is doing.
  const toolRunning = $derived(items.some((i) => i.kind === 'tool' && !i.done));

  /**
   * Long chats render only their newest items; "Show earlier" adds a page at a time. Together with
   * content-visibility on each item this keeps a chat of thousands of items quick to open.
   */
  const PAGE = 80;
  let limit = $state(PAGE);
  const start = $derived(Math.max(0, items.length - limit));
  const visible = $derived(start > 0 ? items.slice(start) : items);

  /** Shows the previous page, keeping what the reader was looking at in place. */
  async function showEarlier() {
    const el = scroller;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    // Everything loaded is shown already: ask the server for the next older page (protocol v2).
    if (start === 0 && agent) store.loadEarlier(agent.id);
    limit += PAGE;
    await tick();
    if (el) el.scrollTop = el.scrollHeight - fromBottom;
  }
  /** Older items exist on the server that the page has not loaded yet. */
  const moreOnServer = $derived(!!(agent && store.pages[agent.id]?.more));
  const earlierCount = $derived(start > 0 ? start : 0);


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

  // Opening another agent or conversation starts at the bottom, with the newest page only.
  $effect(() => {
    void store.viewAgentId;
    void store.convId;
    pinned = true;
    limit = PAGE;
  });

  // A picture that finishes loading makes the chat taller; stay at the bottom if the reader was there.
  // Load events do not bubble, so this listens in the capture phase.
  $effect(() => {
    const el = scroller;
    if (!el) return;
    const onLoad = (e: Event) => {
      if (pinned && (e.target as HTMLElement).tagName === 'IMG') el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
  });

  function toBottom() {
    pinned = true;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  const key = (item: Item) => item.id;

  /** The item briefly highlighted after "Waiting for your answer" asked to show it. */
  let highlighted = $state<string | null>(null);
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const f = progress.focus;
    if (!f) return;
    untrack(() => {
      progress.focus = null;
      showItem(f.id);
    });
  });
  /** Scrolls to an item (showing earlier ones if it is above the newest page) and highlights it a moment. */
  function showItem(id: string) {
    const i = items.findIndex((it) => it.id === id);
    if (i < 0) return;
    if (i < start) limit = items.length - i;
    void tick().then(() => {
      const el = scroller?.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"]`);
      if (!el) return;
      pinned = false;
      const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView?.({ block: 'center', behavior: still ? 'auto' : 'smooth' });
      // Focus goes to the question too, so a screen reader reads it next.
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
      highlighted = id;
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => (highlighted = null), 2600);
    });
  }
</script>

<div class="scroll" bind:this={scroller} onscroll={onScroll}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="column" onclick={handleCopyClick}>
    {#if store.convId === null}
      <div class="hello">
        <h1>{T.empty.heading}</h1>
        <p class="muted">{T.empty.intro}</p>
        <!-- Example prompts teach by showing; a click puts the text in the box, it does not send. -->
        <div class="examples" role="group" aria-label={T.empty.examplesLabel}>
          {#each T.empty.examples as example (example)}
            <button class="example" onclick={() => useExample(example)}>{example}</button>
          {/each}
        </div>
      </div>
    {:else if items.length === 0 && !draft && agent && agent.status !== 'running' && agent.status !== 'queued'}
      <p class="muted center">{T.empty.nothingYet}</p>
    {/if}

    {#if start > 0 || moreOnServer}
      <button class="earlier" onclick={showEarlier} disabled={!!(agent && store.pages[agent.id]?.loading)}>
        {earlierCount > 0 ? T.transcript.earlier(earlierCount) : T.transcript.earlierMore}
      </button>
    {/if}

    {#each visible as item (key(item))}
      <!-- Off-screen items are skipped by layout and paint (content-visibility), except tool lines,
           whose negative margins need them to stay in normal flow. -->
      <div class="item" class:cv={item.kind !== 'tool'} class:highlight={highlighted === item.id} data-item={item.id}>
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
      </div>
    {/each}

    {#if draft}
      <DraftView {draft} />
    {/if}

    {#if agent && !draft && store.convId !== null}
      <StatusLine {agent} {toolRunning} />
    {/if}
    {#if store.creating}
      <div class="working"><span class="dot running"></span>{T.composer.starting}</div>
    {/if}
  </div>
</div>
{#if !pinned}
  <button class="jump" onclick={toBottom} aria-label={T.transcript.jump}>↓</button>
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
  .item.cv {
    content-visibility: auto;
    contain-intrinsic-size: auto 120px;
  }
  /* The question "Waiting for your answer" points at: a quiet wash that fades. */
  .item.highlight {
    border-radius: var(--radius);
    animation: highlight 2.6s ease-out;
  }
  @keyframes highlight {
    0%,
    40% {
      background: color-mix(in srgb, var(--text) 8%, transparent);
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--text) 8%, transparent);
    }
    100% {
      background: transparent;
      box-shadow: 0 0 0 6px transparent;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .item.highlight {
      animation: none;
      background: color-mix(in srgb, var(--text) 8%, transparent);
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--text) 8%, transparent);
    }
  }
  .earlier {
    align-self: center;
    min-height: 32px;
    padding: 4px 14px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
    font-size: 13px;
  }
  .earlier:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .hello {
    margin: 18vh 0 8px;
    text-align: center;
  }
  .examples {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin-top: 22px;
  }
  .example {
    max-width: 100%;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--raised);
    color: var(--muted);
    font-size: 14px;
    text-align: left;
  }
  @media (pointer: coarse) {
    .example {
      min-height: 44px;
    }
  }
  .example:hover {
    border-color: var(--border-strong);
    color: var(--text);
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
