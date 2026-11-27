<script lang="ts">
  import { displayName, type AgentInfo } from '../../../shared/protocol.ts';
  import { store } from './store.svelte.ts';

  /** The ■ that stops a live sub-agent and everything under it. Shared by the team map and the team panel. */
  let { agent, placement }: { agent: AgentInfo; placement: 'map' | 'row' } = $props();

  function press() {
    if (store.convId) store.send({ t: 'stop_agent', convId: store.convId, agentId: agent.id });
  }
</script>

<button class="stop {placement}" onclick={press} title="Stop this agent and everything under it" aria-label="Stop {displayName(agent.name)}">
  <span class="label" aria-hidden="true">Stop</span><span class="glyph" aria-hidden="true">■</span>
</button>

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
  .stop.map {
    position: absolute;
    right: 6px;
    bottom: 6px;
  }
  .glyph {
    font-size: 11px;
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
</style>
