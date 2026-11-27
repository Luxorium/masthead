<script lang="ts">
  import { T } from '../text.ts';
  import { displayName, type AgentInfo } from '../../../../shared/protocol.ts';
  import AgentSpan from '../AgentSpan.svelte';
  import Expander from '../team/Expander.svelte';
  import { statusWords, store } from '../store.svelte.ts';

  let { agent, toolRunning }: { agent: AgentInfo; toolRunning: boolean } = $props();

  /** Helpers this agent is waiting on, oldest first. */
  const live = $derived(store.childrenOf(agent.id).filter((c) => c.status === 'running' || c.status === 'queued' || c.status === 'waiting'));
  /** Whether the list of what each helper is doing is open. */
  let open = $state(false);
  const listId = $derived(`helpers-${agent.id}`);
</script>

{#if agent.pausedUntil}
  <div class="working"><span class="dot queued"></span>{statusWords(agent)}</div>
{:else if agent.status === 'running' && !toolRunning}
  <div class="working"><span class="dot running"></span>{agent.activity ?? T.transcript.working}</div>
{:else if agent.status === 'queued'}
  <div class="working"><span class="dot queued"></span>{T.transcript.waitingTurn}</div>
{:else if agent.status === 'waiting'}
  {#if !agent.waitingFor && live.length > 0}
    <div class="waiting-on">
      <button
        class="working toggle"
        aria-expanded={open}
        aria-controls={listId}
        title={open ? T.progress.hideHelpers : T.progress.showHelpers}
        onclick={() => (open = !open)}
      >
        <span class="dot waiting"></span>
        <span class="words">{T.progress.waitingNames(T.transcript.waitingOn(live.length), live.map((c) => displayName(c.name)).join(', '))}</span>
        <Expander {open} />
      </button>
      {#if open}
        <ul class="helpers" id={listId}>
          {#each live as c (c.id)}
            <li>
              <button class="name" title={T.progress.openChat(displayName(c.name))} onclick={() => store.viewOf(c.id)}>{displayName(c.name)}</button>
              <span class="what"><span class="doing">{statusWords(c)}</span><AgentSpan agentId={c.id} /></span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else}
    <div class="working"><span class="dot waiting"></span>{statusWords(agent)}</div>
  {/if}
{/if}

<style>
  .working {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13.5px;
    color: var(--muted);
    min-height: 22px;
  }
  .toggle {
    max-width: 100%;
    padding: 0;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .toggle:hover .words {
    color: var(--text);
  }
  .toggle .words {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .helpers {
    list-style: none;
    margin: 6px 0 0;
    padding: 0 0 0 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
    color: var(--muted);
  }
  .helpers li {
    display: flex;
    column-gap: 8px;
    min-width: 0;
    align-items: baseline;
  }
  .name {
    flex: none;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text);
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .name:hover {
    text-decoration-color: currentColor;
  }
  .what {
    display: flex;
    min-width: 0;
  }
  .doing {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  @media (pointer: coarse) {
    .toggle,
    .name {
      min-height: 44px;
    }
  }
</style>
