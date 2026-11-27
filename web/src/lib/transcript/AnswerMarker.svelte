<script lang="ts">
  // "Waiting for your answer": the lead asked the person something, more came after it, and the person
  // has not written since. A click scrolls the chat to the question and highlights it. It goes when the
  // person sends anything (their message lands after the question).
  import { displayName } from '../../../../shared/protocol.ts';
  import { openQuestion } from '../progress.ts';
  import { progress } from '../progress.svelte.ts';
  import { store } from '../store.svelte.ts';
  import { T } from '../text.ts';

  const lead = $derived(store.lead);
  const question = $derived(lead && store.viewAgent?.id === lead.id ? openQuestion(store.items[lead.id] ?? []) : null);
</script>

{#if question && lead}
  <button class="answer-marker" title={T.progress.awaitingTitle(displayName(lead.name))} onclick={() => progress.showItem(question)}>
    <span class="mark" aria-hidden="true">?</span>{T.progress.awaitingAnswer}
  </button>
{/if}

<style>
  .answer-marker {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin: 0 0 8px;
    padding: 3px 12px 3px 4px;
    min-height: 28px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--raised);
    color: var(--text);
    font-size: 13px;
    cursor: pointer;
  }
  .answer-marker:hover {
    border-color: var(--muted);
  }
  .mark {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    color: var(--muted);
    font-family: var(--serif);
    font-size: 13px;
    font-weight: 600;
  }
  @media (pointer: coarse) {
    .answer-marker {
      min-height: 44px;
    }
  }
</style>
