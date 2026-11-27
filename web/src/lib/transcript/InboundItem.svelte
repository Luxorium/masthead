<script lang="ts">
  import { T } from '../text.ts';
  import { displayName, type Item } from '../../../../shared/protocol.ts';
  import { renderMarkdown } from '../markdown.ts';
  import { STATUS_LABEL, store } from '../store.svelte.ts';

  type Inbound = Extract<Item, { kind: 'inbound' }>;
  let { item }: { item: Inbound } = $props();

  /** Set once the reader opens or shuts this item; until then it follows startsOpen(). */
  let open = $state<boolean | undefined>(undefined);
  const isOpen = $derived(open ?? startsOpen(item));


  /** Whether an inbound item starts open: tasks start shut, reports too when the setting says so. */
  function startsOpen(item: Inbound): boolean {
    if (item.via === 'task') return false;
    if (item.via === 'report' && store.settings?.collapseReports) return false;
    return true;
  }

  function firstWords(text: string, max = 100): string {
    const t = text.replace(/[#*_`>\[\]]+/g, '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  function openAgent(name: string) {
    const a = store.agentList.find((x) => x.name === name);
    if (a) store.viewOf(a.id);
  }
</script>

<div class="inbound {item.via}">
  <div class="inbound-head">
    <!-- "Asked by Alpha" / "Bravo finished" / "Bravo says": the name opens that agent's chat. -->
    {#if item.via === 'task'}<span>{T.transcript.askedBy}</span>{/if}
    <button class="who" onclick={() => openAgent(item.from)}>{displayName(item.from)}</button>
    {#if item.via === 'report'}<span>{T.transcript.finished('').trim()}</span>{:else if item.via === 'message'}<span>{T.transcript.says('').trim()}</span>{/if}
    {#if item.via === 'report' && item.status && item.status !== 'done'}<span class="state">{STATUS_LABEL[item.status].toLowerCase()}</span>{/if}
    {#if item.via === 'report' && !isOpen}
      <button class="gist" onclick={() => (open = true)} aria-expanded="false" title={T.transcript.showReport}>{firstWords(item.text)}</button>
    {/if}
    <button class="toggle" onclick={() => (open = !isOpen)} aria-expanded={isOpen}>
      {isOpen ? T.transcript.hide : T.transcript.show}
    </button>
  </div>
  {#if isOpen}
    <div class="md inbound-body">{@html renderMarkdown(item.text)}</div>
  {/if}
</div>

<style>
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
</style>
