<script lang="ts">
  import { T } from './text.ts';
  import { displayName, type AgentInfo } from '../../../shared/protocol.ts';
  import { store } from './store.svelte.ts';

  /** The ■ that stops a live sub-agent and everything under it. Shown on live helpers' rows in the team outline. */
  let { agent, placement }: { agent: AgentInfo; placement: 'row' } = $props();

  function press() {
    if (store.convId) store.send({ t: 'stop_agent', convId: store.convId, agentId: agent.id });
  }
</script>

{#if store.mayStop}
<button class="stop {placement}" onclick={press} title={T.team.stopTitle} aria-label={T.team.stop(displayName(agent.name))}>
  <span class="label" aria-hidden="true">{T.team.stopWord}</span><span class="glyph" aria-hidden="true">■</span>
</button>
{/if}

<style>
  .stop {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 5px;
    min-width: 24px;
    height: 24px;
    padding: 0 6px;
    border-radius: 6px;
    color: var(--text);
    opacity: 0.8;
  }
  .glyph {
    font-size: 14px;
    line-height: 1;
  }
  /* The word appears on hover and keyboard focus, so the square is never a mystery. */
  .label {
    display: none;
    font-size: 12px;
    font-weight: 500;
  }
  .stop:hover,
  .stop:focus-visible {
    opacity: 1;
    /* Opaque, so the word does not sit on top of the card's text. */
    background: color-mix(in srgb, var(--bad) 14%, var(--raised));
    color: var(--bad);
  }
  .stop:hover .label,
  .stop:focus-visible .label {
    display: inline;
  }
  /* Touch screens have no hover: in a list row the word is always there, and the target is 44 px. */
  @media (pointer: coarse) {
    .stop {
      min-width: 44px;
      min-height: 44px;
    }
    .stop.row .label {
      display: inline;
    }
  }
</style>
