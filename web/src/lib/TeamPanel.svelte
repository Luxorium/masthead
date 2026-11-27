<script lang="ts">
  // The team: who is working on what, with Stop. Shown once the main assistant has started a helper.
  // In Advanced it also holds the levels (helpers at a time, thinking time).
  import { displayName, modelLabel, type AgentInfo } from '../../../shared/protocol.ts';
  import StopControl from './StopControl.svelte';
  import { tierClass } from './tiers.ts';
  import TierControls from './team/TierControls.svelte';
  import { fmtTokens, statusWords, store } from './store.svelte.ts';
  import { T } from './text.ts';
  import { ui } from './ui.svelte.ts';

  const lead = $derived(store.lead);
  const pct = $derived(lead && lead.usage.contextMax > 0 ? Math.min(100, Math.round((lead.usage.context / lead.usage.contextMax) * 100)) : 0);
  const totalOut = $derived(store.agentList.reduce((n, a) => n + a.usage.output, 0));
  const isLive = (a: AgentInfo) => a.status === 'queued' || a.status === 'running' || a.status === 'waiting';
</script>

{#snippet row(a: AgentInfo, depth: number)}
  <div class="agent" class:viewing={store.viewAgent?.id === a.id} style:padding-left="{8 + depth * 14}px">
    <button class="agent-main" onclick={() => store.viewOf(a.id)} title={a.task}>
      <span class="dot {a.status}"></span>
      <span class="agent-text">
        <span class="agent-name">{displayName(a.name)} <span class="tier-badge {tierClass(store.settings, a.tier)}">{modelLabel(a.model)}</span>{#if a.title}<span class="agent-title"> {a.title}</span>{:else if a.tier === 'lead'}<span class="agent-title"> {T.team.mainAssistant}</span>{/if}</span>
        <span class="agent-sub">{statusWords(a)}</span>
      </span>
    </button>
    {#if isLive(a) && a.tier !== 'lead'}
      <StopControl agent={a} placement="row" />
    {/if}
  </div>
{/snippet}

{#snippet branch(parentId: string, depth: number)}
  {#each store.childrenOf(parentId) as a (a.id)}
    {@render row(a, depth)}
    {@render branch(a.id, depth + 1)}
  {/each}
{/snippet}

<aside class="right" aria-label={T.team.title}>
  <div class="head">
    <h2>{T.team.title}</h2>
    {#if store.view === 'map'}
      <button class="link" onclick={() => (store.view = 'chat')}>{T.team.showChat}</button>
    {:else if !ui.narrow}
      <!-- The map needs width; narrow screens keep the list. -->
      <button class="link" onclick={() => (store.view = 'map')}>{T.team.showMap}</button>
    {/if}
    <button class="btn ghost close" onclick={() => { ui.toggleTeam(false); store.view = 'chat'; }} aria-label={T.team.close} title={T.team.close}>×</button>
  </div>

  {#if lead}
    <section class="grow">
      {@render row(lead, 0)}
      {@render branch(lead.id, 1)}
      <p class="small muted memory" title={T.team.memoryDetail(fmtTokens(lead.usage.context), fmtTokens(lead.usage.contextMax), fmtTokens(totalOut))}>
        {T.team.memory(pct)}{#if ui.advanced} · {T.team.memoryDetail(fmtTokens(lead.usage.context), fmtTokens(lead.usage.contextMax), fmtTokens(totalOut))}{/if}
      </p>
    </section>
  {/if}

  {#if ui.advanced && store.mayAct}
    <TierControls />
  {/if}
</aside>

<style>
  aside {
    display: flex;
    flex-direction: column;
    width: 316px;
    min-height: 0;
    overflow-y: auto;
    border-left: 1px solid var(--border);
    background: var(--bg);
  }
  section {
    padding: 10px 8px 14px;
    border-bottom: 1px solid var(--border);
  }
  section.grow {
    flex: 1;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 10px 10px 16px;
    border-bottom: 1px solid var(--border);
  }
  .link {
    margin-left: auto;
    font-size: 12.5px;
    color: var(--accent);
  }
  .link:hover {
    text-decoration: underline;
  }
  .head h2 {
    flex: 1;
  }
  .close {
    min-width: 32px;
    padding: 2px 8px;
    font-size: 16px;
  }
  .memory {
    margin-top: 12px;
    padding-left: 8px;
  }
  h2 {
    display: flex;
    align-items: center;
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .small {
    margin: 6px 0 0;
    font-size: 12.5px;
  }
  .agent {
    display: flex;
    align-items: center;
    border-radius: 6px;
    padding-right: 4px;
  }
  .agent:hover,
  .agent.viewing {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .agent-main {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 5px 0;
    text-align: left;
  }
  .agent-main .dot {
    margin-top: 7px;
  }
  .agent-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .agent-name {
    font-size: 13.5px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .agent-title {
    font-weight: 400;
    color: var(--muted);
  }
  .agent-sub {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
