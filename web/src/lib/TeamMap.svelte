<script lang="ts">
  import { EFFORT_LABEL, displayName, modelLabel, type AgentInfo, type Item } from '../../../shared/protocol.ts';
  import { STATUS_LABEL, fmtTokens, store } from './store.svelte.ts';
  import { toolLine } from './tools.ts';

  const isLive = (a: AgentInfo) => a.status === 'queued' || a.status === 'running' || a.status === 'waiting';

  function doing(a: AgentInfo): string {
    if (a.status === 'running') return a.activity ?? 'Working';
    if (a.status === 'failed') return a.error ? `Failed: ${a.error}` : 'Failed';
    return STATUS_LABEL[a.status];
  }

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  function elapsed(a: AgentInfo): string {
    const secs = Math.max(0, Math.round(((a.endedAt ?? now) - a.createdAt) / 1000));
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
    return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  }

  // Hovering an agent shows the tail of its chat without leaving the map.
  let previewId = $state<string | null>(null);
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  /** The transcript the current preview fetched itself, dropped again when the preview closes. */
  let fetchedFor: string | null = null;

  function enter(id: string) {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      forget();
      previewId = id;
      if (!store.items[id]) {
        fetchedFor = id;
        store.loadItems(id);
      }
    }, 220);
  }

  function forget() {
    if (fetchedFor) store.dropItems(fetchedFor);
    fetchedFor = null;
  }

  function leave() {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
    previewId = null;
    forget();
  }

  function flat(text: string, max: number): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  interface Line {
    id: string;
    who: string;
    text: string;
    kind: Item['kind'];
  }

  function previewLines(a: AgentInfo): Line[] | null {
    const items = store.items[a.id];
    if (!items) return null;
    const lines: Line[] = [];
    for (const item of items.slice(-14)) {
      if (item.kind === 'user') lines.push({ id: item.id, who: 'You', text: flat(item.text, 160), kind: item.kind });
      else if (item.kind === 'text') lines.push({ id: item.id, who: displayName(a.name), text: flat(item.text, 220), kind: item.kind });
      else if (item.kind === 'tool') {
        const l = toolLine(item.name, item.input, !item.done);
        lines.push({ id: item.id, who: '', text: flat(`${l.verb} ${l.target ?? ''}`, 110), kind: item.kind });
      } else if (item.kind === 'inbound' && item.via !== 'task') {
        // The task itself is shown at the top of the preview.
        const via = item.via === 'report' ? 'Report from' : 'Message from';
        lines.push({ id: item.id, who: `${via} ${displayName(item.from)}`, text: flat(item.text, 140), kind: item.kind });
      } else if (item.kind === 'notice') lines.push({ id: item.id, who: '', text: flat(item.text, 120), kind: item.kind });
    }
    return lines.slice(-6);
  }
</script>

{#snippet node(a: AgentInfo)}
  {@const kids = store.childrenOf(a.id)}
  <li>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="card tier-{a.tier}"
      class:live={isLive(a)}
      class:ended={a.status === 'done' || a.status === 'stopped' || a.status === 'failed'}
      onmouseenter={() => enter(a.id)}
      onmouseleave={leave}
    >
      <button class="open" onclick={() => store.viewOf(a.id)} onfocus={() => enter(a.id)} onblur={leave} aria-label="Open {displayName(a.name)}'s chat">
        <span class="top">
          <span class="dot {a.status}"></span>
          <span class="name">{displayName(a.name)}</span>
          <span class="tier-badge tier-{a.tier}">{modelLabel(a.model)}</span>
        </span>
        {#if a.title}<span class="title">{a.title}</span>{:else if a.tier === 'lead'}<span class="title lead">The one you talk to</span>{/if}
        <span class="doing" class:bad={a.status === 'failed'}>{doing(a)}</span>
        <span class="meta">
          {EFFORT_LABEL[a.effort]} effort · {fmtTokens(a.usage.context)} context{#if a.tier !== 'lead'} · {elapsed(a)}{/if}
        </span>
      </button>
      {#if isLive(a) && a.tier !== 'lead'}
        <button class="stop" onclick={() => store.convId && store.send({ t: 'stop_agent', convId: store.convId, agentId: a.id })} title="Stop this agent and everything under it" aria-label="Stop {displayName(a.name)}">■</button>
      {/if}
      {#if previewId === a.id}
        {@const lines = previewLines(a)}
        {@const draft = store.drafts[a.id]}
        <div class="preview" role="tooltip">
          {#if a.task}<div class="p-task"><b>Task</b> {flat(a.task, 260)}</div>{/if}
          {#if lines === null}
            <div class="p-empty">Loading…</div>
          {:else if lines.length === 0 && !draft}
            <div class="p-empty">Nothing yet.</div>
          {:else}
            {#each lines as l (l.id)}
              <div class="p-line {l.kind}">{#if l.who}<b>{l.who}</b> {/if}{l.text}</div>
            {/each}
            {#if draft?.text}<div class="p-line text live"><b>{displayName(a.name)}</b> {flat(draft.text.slice(-220), 220)}</div>{/if}
          {/if}
          <div class="p-foot">Click to open the chat</div>
        </div>
      {/if}
    </div>
    {#if kids.length > 0}
      <ul>
        {#each kids as k (k.id)}
          {@render node(k)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<div class="map">
  {#if store.lead}
    <ul class="tree root">
      {@render node(store.lead)}
    </ul>
    {#if store.agentList.length === 1}
      <p class="muted hint">Only {displayName(store.lead.name)} so far. Agents it starts appear under it here, with what each one is doing.</p>
    {/if}
  {/if}
</div>

<style>
  .map {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 28px 24px 240px;
  }
  .hint {
    text-align: center;
    margin-top: 20px;
    font-size: 13.5px;
  }
  /* A top-down tree: each list is a row of siblings joined to its parent by hairlines. */
  ul {
    display: flex;
    justify-content: center;
    gap: 14px;
    margin: 0;
    padding: 22px 0 0;
    list-style: none;
    position: relative;
  }
  ul.root {
    padding-top: 0;
    width: max-content;
    min-width: 100%;
  }
  li {
    display: flex;
    flex-direction: column;
    align-items: center;
    position: relative;
  }
  /* the line down from a parent to its row of children */
  ul:not(.root)::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    height: 11px;
    border-left: 1px solid var(--border-strong);
  }
  /* the bar across the siblings and the drop to each one */
  ul:not(.root) > li::before {
    content: '';
    position: absolute;
    top: -11px;
    left: -7px;
    right: -7px;
    height: 11px;
    border-top: 1px solid var(--border-strong);
  }
  ul:not(.root) > li::after {
    content: '';
    position: absolute;
    top: -11px;
    left: 50%;
    height: 11px;
    border-left: 1px solid var(--border-strong);
  }
  ul:not(.root) > li:first-child::before {
    left: 50%;
  }
  ul:not(.root) > li:last-child::before {
    right: 50%;
  }
  ul:not(.root) > li:only-child::before {
    display: none;
  }
  .card {
    position: relative;
    width: 232px;
    border: 1px solid var(--border);
    border-top: 3px solid var(--tier);
    border-radius: var(--radius);
    background: var(--raised);
    box-shadow: 0 1px 2px rgb(0 0 0 / 5%);
  }
  .card.live {
    border-color: color-mix(in srgb, var(--tier) 55%, var(--border));
    border-top-color: var(--tier);
    box-shadow: var(--shadow);
  }
  .card.ended:not(:hover) {
    opacity: 0.72;
  }
  .open {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    padding: 9px 11px 10px;
    text-align: left;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .name {
    flex: 1;
    min-width: 0;
    font-weight: 650;
    font-size: 15px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .title {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 13px;
    line-height: 1.35;
  }
  .title.lead {
    color: var(--muted);
  }
  .doing {
    font-size: 12.5px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card.live .doing {
    color: var(--accent);
  }
  .doing.bad {
    color: var(--bad);
  }
  .meta {
    font-size: 11.5px;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
  .stop {
    position: absolute;
    right: 6px;
    bottom: 6px;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    font-size: 9px;
    color: var(--muted);
  }
  .stop:hover {
    background: color-mix(in srgb, var(--bad) 15%, transparent);
    color: var(--bad);
  }
  .preview {
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    z-index: 15;
    width: 340px;
    max-width: 80vw;
    transform: translateX(-50%);
    padding: 10px 12px;
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    background: var(--raised);
    box-shadow: var(--shadow);
    font-size: 12.5px;
    line-height: 1.45;
    text-align: left;
    pointer-events: none;
  }
  .p-task {
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
  }
  .p-line {
    margin-top: 4px;
    overflow-wrap: anywhere;
  }
  .p-line.tool,
  .p-line.notice {
    color: var(--muted);
  }
  .p-line.live::after {
    content: '▍';
    color: var(--accent);
  }
  .p-line b,
  .p-task b {
    margin-right: 4px;
    font-weight: 600;
    color: var(--text);
  }
  .p-empty {
    color: var(--faint);
  }
  .p-foot {
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--faint);
  }
</style>
