<script lang="ts">
  import { tick } from 'svelte';
  import { displayName, type Item } from '../../../shared/protocol.ts';
  import { handleCopyClick, renderMarkdown } from './markdown.ts';
  import { STATUS_LABEL, store } from './store.svelte.ts';
  import { toolLine } from './tools.ts';

  let scroller = $state<HTMLDivElement | null>(null);
  let pinned = $state(true);
  let open = $state<Record<string, boolean>>({});

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

  function pretty(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function openAgent(name: string) {
    const a = store.agentList.find((x) => x.name === name);
    if (a) store.viewOf(a.id);
  }

  const VIA: Record<string, string> = { task: 'Task from', report: 'Report from', message: 'Message from' };

  /** Whether an inbound item starts open: tasks start shut, reports too when the setting says so. */
  function startsOpen(item: Extract<Item, { kind: 'inbound' }>): boolean {
    if (item.via === 'task') return false;
    if (item.via === 'report' && store.settings?.collapseReports) return false;
    return true;
  }

  function firstWords(text: string, max = 100): string {
    const t = text.replace(/[#*_`>\[\]]+/g, '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
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
        <div class="user">
          <div class="bubble">
            {#if item.images}<div class="attached">{item.images} image{item.images > 1 ? 's' : ''} attached</div>{/if}
            {item.text}
          </div>
        </div>
      {:else if item.kind === 'text'}
        <div class="md assistant">{@html renderMarkdown(item.text)}</div>
      {:else if item.kind === 'thinking'}
        <details class="thinking">
          <summary>Thought</summary>
          <div class="md">{@html renderMarkdown(item.text)}</div>
        </details>
      {:else if item.kind === 'tool'}
        {@const line = toolLine(item.name, item.input, !item.done)}
        <div class="tool" class:err={item.isError}>
          <button class="tool-line" onclick={() => (open[item.id] = !open[item.id])} aria-expanded={!!open[item.id]}>
            {#if !item.done}<span class="dot running"></span>{/if}
            <span class="verb">{line.verb}</span>
            {#if line.target}<span class="target mono">{line.target}</span>{/if}
            {#if item.isError}<span class="failed">failed</span>{/if}
            <span class="chev">{open[item.id] ? '▾' : '›'}</span>
          </button>
          {#if open[item.id]}
            <div class="tool-body">
              <div class="tool-label">Input</div>
              <pre>{pretty(item.input)}</pre>
              {#if item.result !== undefined}
                <div class="tool-label">Result</div>
                <pre>{item.result || '(empty)'}</pre>
              {/if}
            </div>
          {/if}
        </div>
      {:else if item.kind === 'inbound'}
        <div class="inbound {item.via}">
          <div class="inbound-head">
            <span>{VIA[item.via]}</span>
            <button class="who" onclick={() => openAgent(item.from)}>{displayName(item.from)}</button>
            {#if item.via === 'report' && item.status && item.status !== 'done'}<span class="state">{STATUS_LABEL[item.status].toLowerCase()}</span>{/if}
            {#if item.via === 'report' && !(open[item.id] ?? startsOpen(item))}
              <button class="gist" onclick={() => (open[item.id] = true)} aria-expanded="false" title="Show the report">{firstWords(item.text)}</button>
            {/if}
            <button class="toggle" onclick={() => (open[item.id] = !(open[item.id] ?? startsOpen(item)))} aria-expanded={open[item.id] ?? startsOpen(item)}>
              {(open[item.id] ?? startsOpen(item)) ? 'Hide' : 'Show'}
            </button>
          </div>
          {#if open[item.id] ?? startsOpen(item)}
            <div class="md inbound-body">{@html renderMarkdown(item.text)}</div>
          {/if}
        </div>
      {:else if item.kind === 'notice'}
        <div class="notice" class:error={item.level === 'error'}>{item.text}</div>
      {/if}
    {/each}

    {#if draft}
      {#if draft.kind === 'text'}
        <div class="md assistant streaming">{@html renderMarkdown(draft.text)}</div>
      {:else if draft.text}
        <div class="thinking-live muted">Thinking… {draft.text.slice(-140)}</div>
      {/if}
    {/if}

    {#if agent && !draft && store.convId !== null}
      {#if agent.status === 'running' && !toolRunning}
        <div class="working"><span class="dot running"></span>{agent.activity ?? 'Working…'}</div>
      {:else if agent.status === 'queued'}
        <div class="working"><span class="dot queued"></span>Waiting for a free slot…</div>
      {:else if agent.status === 'waiting'}
        <div class="working"><span class="dot waiting"></span>Waiting on {store.childrenOf(agent.id).filter((c) => c.status === 'running' || c.status === 'queued' || c.status === 'waiting').length} agent(s)</div>
      {/if}
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
  .streaming::after {
    content: '';
    display: inline-block;
    width: 7px;
    height: 15px;
    margin-left: 2px;
    vertical-align: text-bottom;
    background: var(--accent);
    animation: pulse 1s steps(2) infinite;
  }
  .thinking summary,
  .thinking-live {
    font-size: 13.5px;
    color: var(--muted);
    cursor: pointer;
  }
  .thinking-live {
    cursor: default;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .thinking .md {
    margin-top: 6px;
    padding-left: 12px;
    border-left: 2px solid var(--border);
    color: var(--muted);
    font-size: 14px;
  }
  .tool {
    margin: -6px 0;
  }
  .tool-line {
    display: flex;
    align-items: center;
    gap: 7px;
    max-width: 100%;
    padding: 2px 0;
    font-size: 13.5px;
    color: var(--muted);
    text-align: left;
  }
  .tool-line:hover {
    color: var(--text);
  }
  .verb {
    flex: none;
  }
  .target {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    opacity: 0.85;
  }
  .failed {
    flex: none;
    color: var(--bad);
  }
  .chev {
    flex: none;
    color: var(--faint);
  }
  .tool-body {
    margin: 4px 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--raised);
    overflow: hidden;
  }
  .tool-label {
    padding: 6px 12px 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .tool-body pre {
    margin: 0;
    padding: 6px 12px 10px;
    max-height: 320px;
    overflow: auto;
    font: 12.5px/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .inbound {
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius);
    background: var(--raised);
  }
  .inbound.task {
    border-left-color: var(--border-strong);
  }
  .inbound-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    font-size: 13px;
    color: var(--muted);
  }
  .who {
    font-weight: 600;
    color: var(--text);
  }
  .who:hover {
    text-decoration: underline;
  }
  .state {
    color: var(--warn);
  }
  .gist {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: left;
    color: var(--faint);
  }
  .gist:hover {
    color: var(--text);
  }
  .toggle {
    flex: none;
    margin-left: auto;
    font-size: 12.5px;
    color: var(--faint);
  }
  .toggle:hover {
    color: var(--text);
  }
  .inbound-body {
    padding: 2px 12px 12px;
    font-size: 14.5px;
  }
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
