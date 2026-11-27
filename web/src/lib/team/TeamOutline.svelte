<script lang="ts">
  // The team as an outline that scrolls only up and down: one row per agent, helpers indented under
  // whoever started them, joined by thin neutral guide lines (a vertical under each open parent, a tick
  // to each child, the last child's tick turning the corner). Each parent's children sit in one group,
  // and every child draws its own piece of the guide with no gap to the next, so two-line rows,
  // previews and folded rows cannot break the line. The level's colour is on the model badge only. A row says who, which model, the
  // job and what it is doing now; live helpers have Stop at the right. Finished ones stay, dimmed;
  // failed ones keep the bad colour. A tree for the keyboard: ↑ ↓ move, → opens or goes in, ← closes or
  // goes up, Enter opens the chat. Hovering or focusing a row shows its latest lines below it.
  import { displayName, modelLabel, type AgentInfo, type Item } from '../../../../shared/protocol.ts';
  import StopControl from '../StopControl.svelte';
  import { statusWords, store } from '../store.svelte.ts';
  import { T } from '../text.ts';
  import { tierClass } from '../tiers.ts';
  import { toolLine } from '../tools.ts';
  import { ui } from '../ui.svelte.ts';
  import Expander from './Expander.svelte';
  import { outlineRows, outlineTree, type OutlineNode, type OutlineRow } from './outline.ts';

  /** Measures where an open parent's line ends: at its last child's top (plus the tick's y, in CSS). The
      line is one element drawn once per group, so its pieces cannot round differently row to row. */
  function guide(group: HTMLElement, _count: number) {
    const node = group.parentElement as HTMLElement;
    const set = () => {
      const last = group.lastElementChild as HTMLElement | null;
      if (last) node.style.setProperty('--vend', `${last.offsetTop}px`);
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(set);
    ro?.observe(node);
    ro?.observe(group);
    set();
    return { update: set, destroy: () => ro?.disconnect() };
  }

  $effect(() => ui.teamOf(store.convId));

  const opts = $derived({ collapsed: ui.collapsed, hideFinished: ui.hideFinished, openGroups: ui.openGroups });
  /** Rows in order, for the keyboard; the same rows as nested nodes, for drawing. */
  const rows = $derived(outlineRows(store.agentList, opts));
  const tree$ = $derived(outlineTree(store.agentList, opts));
  const keyOf = (r: OutlineRow) => (r.kind === 'agent' ? r.agent.id : r.key);
  const isLive = (a: AgentInfo) => a.status === 'queued' || a.status === 'running' || a.status === 'waiting';
  const ended = (a: AgentInfo) => a.status === 'done' || a.status === 'stopped';

  /** The row that holds the keyboard focus (one tab stop for the whole tree). */
  let current = $state<string | null>(null);
  /** Whether the "Archived helpers" list is open. */
  let archivedOpen = $state(false);
  const focusKey = $derived(rows.some((r) => keyOf(r) === current) ? current : rows[0] ? keyOf(rows[0]) : null);
  let tree = $state<HTMLDivElement | null>(null);

  function focusRow(key: string) {
    current = key;
    queueMicrotask(() => tree?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus());
  }

  function activate(r: OutlineRow) {
    if (r.kind === 'agent') store.viewOf(r.agent.id);
    else ui.toggleGroup(r.parentId);
  }

  function onKey(e: KeyboardEvent) {
    const i = rows.findIndex((r) => keyOf(r) === focusKey);
    const r = rows[i];
    if (!r) return;
    const go = (j: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (next) focusRow(keyOf(next));
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (e.key === 'ArrowRight' && r.kind === 'agent' && r.hasChildren) {
      if (!r.expanded) ui.toggleBranch(r.agent.id, true);
      else go(i + 1);
    } else if (e.key === 'ArrowLeft') {
      if (r.kind === 'agent' && r.hasChildren && r.expanded) ui.toggleBranch(r.agent.id, false);
      else {
        const parent = r.kind === 'agent' ? r.parentId : r.parentId;
        if (parent) focusRow(parent);
      }
    } else if (e.key === 'Enter' || e.key === ' ') activate(r);
    else return;
    e.preventDefault();
  }

  // ---- preview of an agent's latest lines, below its row ----
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
    }, 300);
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

  const flat = (text: string, max: number) => {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };

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
      if (item.kind === 'user') lines.push({ id: item.id, who: T.team.you, text: flat(item.text, 160), kind: item.kind });
      else if (item.kind === 'text') lines.push({ id: item.id, who: displayName(a.name), text: flat(item.text, 200), kind: item.kind });
      else if (item.kind === 'tool') {
        const l = toolLine(item.name, item.input, !item.done);
        lines.push({ id: item.id, who: '', text: flat(`${l.verb} ${l.target ?? ''}`, 110), kind: item.kind });
      } else if (item.kind === 'inbound' && item.via !== 'task') {
        const via = item.via === 'report' ? T.map.reportFrom : T.map.messageFrom;
        lines.push({ id: item.id, who: via(displayName(item.from)), text: flat(item.text, 140), kind: item.kind });
      } else if (item.kind === 'notice') lines.push({ id: item.id, who: '', text: flat(item.text, 120), kind: item.kind });
    }
    return lines.slice(-4);
  }
</script>

<div class="bar">
  <label class="hide-finished">
    <input type="checkbox" checked={ui.hideFinished} onchange={(e) => ui.setHideFinished(e.currentTarget.checked)} />
    <span>{T.team.hideFinished}</span>
  </label>
</div>

<!-- Focus moves between rows (one tab stop, roving tabindex), so the tree itself takes none. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_interactive_supports_focus -->
<div class="outline" role="tree" aria-label={T.team.title} bind:this={tree} onkeydown={onKey}>
  {#each tree$ as node (keyOf(node as OutlineRow))}
    {@render branch(node, true)}
  {/each}
</div>

{#if store.archivedAgents.length > 0}
  <!-- Helpers a tidy-up archived: one row that opens the list; each opens read-only, with Restore. -->
  <div class="archived">
    <button class="archived-toggle" aria-expanded={archivedOpen} onclick={() => (archivedOpen = !archivedOpen)}>
      <Expander open={archivedOpen} />
      {T.compact.archivedRow(store.archivedAgents.length)}
    </button>
    {#if archivedOpen}
      <ul class="archived-list">
        {#each store.archivedAgents as a (a.id)}
          <li class:viewing={store.viewAgent?.id === a.id}>
            <button class="archived-open" onclick={() => store.viewOf(a.id)}>
              <span class="name">{displayName(a.name)}</span>
              <span class="tier-badge {tierClass(store.settings, a.tier)}">{modelLabel(a.model)}</span>
              <span class="title">{a.title}</span>
              <span class="when">{T.compact.archivedWhen(new Date(a.archived ?? 0).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</span>
            </button>
            {#if store.mayAct}
              <button class="btn ghost restore" title={T.compact.restoreTitle} onclick={() => store.restoreAgent(a.id)}>{T.compact.restore}</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

{#snippet branch(node: OutlineNode, last: boolean)}
  {#if node.kind === 'agent'}
    {@const a = node.agent}
    {@const open = node.hasChildren && node.expanded}
    <div
      class="node"
      class:open
      class:last
      class:child={node.depth > 1}
      role="treeitem"
      aria-level={node.depth}
      aria-expanded={node.hasChildren ? node.expanded : undefined}
      aria-selected={store.viewAgent?.id === a.id}
      aria-label={`${displayName(a.name)}, ${modelLabel(a.model)}${a.title ? `, ${a.title}` : ''}: ${statusWords(a)}`}
      tabindex={focusKey === a.id ? 0 : -1}
      data-key={a.id}
      onfocus={(e) => {
        if (e.target !== e.currentTarget) return;
        current = a.id;
        enter(a.id);
      }}
      onblur={(e) => e.target === e.currentTarget && leave()}
    >
      {#if node.depth > 1}<span class="tick" class:leaf={!node.hasChildren} aria-hidden="true"></span>{/if}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="row"
        class:ended={ended(a)}
        class:failed={a.status === 'failed'}
        class:viewing={store.viewAgent?.id === a.id}
        onclick={() => store.viewOf(a.id)}
        onmouseenter={() => enter(a.id)}
        onmouseleave={leave}
      >
        {#if open}<span class="vline" aria-hidden="true"></span>{/if}
        <div class="main">
          {#if node.hasChildren}
            <button
              class="twisty"
              tabindex="-1"
              aria-label={node.expanded ? T.team.collapse(displayName(a.name)) : T.team.expand(displayName(a.name))}
              onclick={(e) => {
                e.stopPropagation();
                ui.toggleBranch(a.id);
              }}><Expander open={node.expanded} /></button
            >
          {:else}
            <span class="twisty-space" aria-hidden="true"></span>
          {/if}
          <span class="dot {a.status}" aria-hidden="true"></span>
          <span class="name">{displayName(a.name)}</span>
          <span class="tier-badge {tierClass(store.settings, a.tier)}">{modelLabel(a.model)}</span>
          <span class="title">{a.title || (!a.parentId ? T.team.mainAssistant : '')}</span>
          {#if isLive(a) && a.parentId}
            <span class="stop-slot" role="none" onclick={(e) => e.stopPropagation()}>
              <StopControl agent={a} placement="row" />
            </span>
          {/if}
        </div>
        <div class="doing">{statusWords(a)}</div>
        {#if previewId === a.id}
          {@const lines = previewLines(a)}
          {@const draft = store.drafts[a.id]}
          <div class="preview" aria-hidden="true">
            {#if a.task}<div class="p-task"><b>{T.team.task}</b> {flat(a.task, 200)}</div>{/if}
            {#if lines === null}
              <div class="p-empty">{T.team.loading}</div>
            {:else if lines.length === 0 && !draft?.text}
              <div class="p-empty">{T.team.nothingYet}</div>
            {:else}
              {#each lines as l (l.id)}
                <div class="p-line {l.kind}">{#if l.who}<b>{l.who}</b> {/if}{l.text}</div>
              {/each}
              {#if draft?.text}
                <div class="p-line live">{#if draft.kind === 'thinking'}{T.map.thinking}{:else}<b>{displayName(a.name)}</b>{/if} {flat(draft.text.slice(-160), 160)}</div>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
      {#if open}
        <div class="group" role="group" use:guide={node.children.length}>
          {#each node.children as c, i (keyOf(c as OutlineRow))}
            {@render branch(c, i === node.children.length - 1)}
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div
      class="node child folded-node"
      class:last
      role="treeitem"
      aria-level={node.depth}
      aria-expanded={false}
      aria-selected={false}
      aria-label={T.team.finishedGroup(node.agents.length, node.agents.map((x) => displayName(x.name)).join(', '))}
      tabindex={focusKey === node.key ? 0 : -1}
      data-key={node.key}
      onfocus={() => (current = node.key)}
    >
      <span class="tick leaf" aria-hidden="true"></span>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="row" onclick={() => ui.toggleGroup(node.parentId)}>
        <div class="main">
          <span class="twisty-space" aria-hidden="true"></span>
          <span class="folded">{T.team.finishedGroup(node.agents.length, node.agents.map((x) => displayName(x.name)).join(', '))}</span>
        </div>
      </div>
    </div>
  {/if}
{/snippet}

<style>
  .bar {
    display: flex;
    justify-content: flex-end;
    padding: 6px 12px 2px;
  }
  .hide-finished {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    line-height: 20px;
    color: var(--muted);
  }
  .hide-finished input {
    accent-color: var(--accent);
  }
  /*
   * Geometry, exact by construction: every value is a whole number of CSS pixels and every guide is a
   * 1 px element, so lines meet at any zoom or pixel ratio.
   *   --tw   indent per level, and the expander column's width
   *   --gx   the guide's x: the middle pixel of the 13 px expander box, which sits at --gx - 6
   *   --pad  the row's top padding; --line the first line's height; --bt the box's top in that line
   *   --ty   the tick's y, through the box's middle pixel: --pad + --bt + 6
   *   --r    the last child's corner radius
   * An open parent's line (.vline) is drawn once, from just under its box to its last child's corner;
   * --vend, the last child's top, is measured by guide(). Each child draws only its tick.
   */
  .outline {
    --tw: 20px;
    --gx: 9px;
    --pad: 4px;
    --line: 24px;
    --bt: 5px;
    --ty: calc(var(--pad) + var(--bt) + 6px);
    --r: 4px;
    --guide: var(--border-strong);
    padding: 4px 8px 8px;
    min-width: 0;
  }
  .node {
    position: relative;
    min-width: 0;
    outline: none;
  }
  .node.child {
    padding-left: var(--tw);
  }
  .vline {
    position: absolute;
    left: var(--gx);
    top: calc(var(--ty) + 7px);
    width: 1px;
    height: calc(var(--vend, 0px) - var(--r) - 7px);
    background: var(--guide);
    pointer-events: none;
  }
  /* A middle child's tick (├): from the guide to its box, or on towards its dot for a leaf. */
  .tick {
    position: absolute;
    left: var(--gx);
    top: var(--ty);
    width: calc(var(--tw) - 6px);
    height: 1px;
    background: var(--guide);
    pointer-events: none;
  }
  .tick.leaf {
    width: calc(2 * var(--tw) - var(--gx) - 4px);
  }
  /* The last child's corner (└): it takes over from the line --r above the tick. */
  .node.last > .tick {
    top: calc(var(--ty) - var(--r));
    height: calc(var(--r) + 1px);
    box-sizing: border-box;
    border-left: 1px solid var(--guide);
    border-bottom: 1px solid var(--guide);
    border-bottom-left-radius: var(--r);
    background: none;
  }
  .row {
    position: relative;
    padding: var(--pad) 6px 4px 0;
    border-radius: 6px;
    min-width: 0;
    cursor: pointer;
  }
  .row:hover,
  .row.viewing {
    background: color-mix(in srgb, var(--text) 6%, transparent);
  }
  .node:focus-visible > .row {
    box-shadow: 0 0 0 2px var(--accent);
  }
  /* Finished and stopped: dimmed by colour, not opacity, so the words keep AA contrast. */
  .row.ended .name {
    color: var(--muted);
    font-weight: 500;
  }
  .row.ended .title,
  .row.ended .doing {
    color: var(--faint);
  }
  .row.ended .tier-badge {
    color: var(--muted);
    background: color-mix(in srgb, var(--text) 7%, var(--raised));
  }
  .row.failed .doing {
    color: var(--bad);
  }
  /* The first line has a fixed whole-pixel height (it holds the 24 px Stop), so nothing in it can make
     the row a fraction of a pixel taller. */
  .main {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: var(--line);
    line-height: 20px;
  }
  /* The expander column: the box is placed, not centred, so it lands on whole pixels. */
  .twisty,
  .twisty-space {
    flex: none;
    align-self: flex-start;
    width: var(--tw);
    height: var(--line);
    padding: 0;
    /* A button centres its content; flex-start keeps the box where --bt puts it. */
    display: flex;
    align-items: flex-start;
  }
  .twisty :global(.expander) {
    margin: var(--bt) 0 0 calc(var(--gx) - 6px);
  }
  .twisty:hover :global(.expander) {
    color: var(--text);
    border-color: var(--muted);
  }
  .dot {
    flex: none;
  }
  .name {
    flex: none;
    font-weight: 600;
    font-size: 13.5px;
  }
  .tier-badge {
    flex: none;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 13px;
    color: var(--muted);
  }
  .stop-slot {
    flex: none;
    margin-left: auto;
  }
  .doing,
  .preview {
    margin-left: calc(var(--tw) + 6px);
  }
  .doing {
    margin-top: 1px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 12.5px;
    line-height: 18px;
    color: var(--muted);
  }
  .folded {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 12.5px;
    color: var(--muted);
  }
  /* The preview sits below the row, inside the panel, so it never makes anything scroll sideways. */
  .preview {
    margin-top: 6px;
    margin-bottom: 2px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--raised);
    font-size: 12.5px;
    line-height: 18px;
    overflow-wrap: anywhere;
    cursor: default;
  }
  .p-task {
    margin-bottom: 4px;
    color: var(--muted);
  }
  .p-line + .p-line {
    margin-top: 3px;
  }
  .p-line.tool,
  .p-line.notice {
    color: var(--muted);
  }
  .p-empty {
    color: var(--faint);
  }
  .archived {
    margin: 4px 8px 0;
    padding-top: 6px;
    border-top: 1px solid var(--border);
  }
  .archived-toggle {
    display: flex;
    align-items: flex-start;
    line-height: 20px;
    gap: 8px;
    width: 100%;
    padding: 6px 4px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--muted);
    text-align: left;
  }
  .archived-toggle:hover {
    background: color-mix(in srgb, var(--text) 6%, transparent);
    color: var(--text);
  }
  /* The same expander as the tree, placed on whole pixels in the 20 px line. */
  .archived-toggle :global(.expander) {
    margin-top: 3px;
  }
  .archived-list {
    margin: 2px 0 0;
    padding: 0 0 0 22px;
    list-style: none;
  }
  .archived-list li {
    display: flex;
    align-items: center;
    gap: 4px;
    border-radius: 6px;
    min-width: 0;
  }
  .archived-list li:hover,
  .archived-list li.viewing {
    background: color-mix(in srgb, var(--text) 6%, transparent);
  }
  .archived-open {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 5px 4px;
    text-align: left;
  }
  .archived-open .name {
    color: var(--muted);
    font-weight: 500;
  }
  .when {
    flex: none;
    font-size: 12px;
    color: var(--faint);
  }
  /* On the selected row's tint --faint falls under AA. */
  .archived-list li.viewing .when {
    color: var(--muted);
  }
  .restore {
    flex: none;
    padding: 2px 8px;
    font-size: 12.5px;
  }
  @media (pointer: coarse) {
    .archived-toggle {
      padding-top: 12px;
      padding-bottom: 12px;
    }
    .archived-open,
    .restore {
      min-height: 44px;
    }
  }
  @media (max-width: 599px) {
    .archived-open .title {
      display: none;
    }
  }
  /* Touch: a 44 px first line (it holds the 44 px Stop); the box and tick move with it. */
  @media (pointer: coarse) {
    .outline {
      --line: 44px;
      --bt: 15px;
    }
  }
  /* Phones: a tighter indent, and the job title gives way to the name and what it is doing. */
  @media (max-width: 599px) {
    .outline {
      --tw: 16px;
      --gx: 7px;
    }
    .title {
      display: none;
    }
  }
</style>
