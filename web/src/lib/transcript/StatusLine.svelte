<script lang="ts">
  import { T } from '../text.ts';
  import type { AgentInfo } from '../../../../shared/protocol.ts';
  import { statusWords, store } from '../store.svelte.ts';

  let { agent, toolRunning }: { agent: AgentInfo; toolRunning: boolean } = $props();
</script>

{#if agent.pausedUntil}
  <div class="working"><span class="dot queued"></span>{statusWords(agent)}</div>
{:else if agent.status === 'running' && !toolRunning}
  <div class="working"><span class="dot running"></span>{agent.activity ?? T.transcript.working}</div>
{:else if agent.status === 'queued'}
  <div class="working"><span class="dot queued"></span>{T.transcript.waitingTurn}</div>
{:else if agent.status === 'waiting'}
  {@const live = store.childrenOf(agent.id).filter((c) => c.status === 'running' || c.status === 'queued' || c.status === 'waiting').length}
  <div class="working"><span class="dot waiting"></span>{agent.waitingFor ? statusWords(agent) : live > 0 ? T.transcript.waitingOn(live) : statusWords(agent)}</div>
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
</style>
