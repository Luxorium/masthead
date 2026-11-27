<script lang="ts">
  // The tidy-up proposal, when "Tidy the team automatically" is off: who stays (ticked), who is
  // archived; helpers that must stay are ticked and cannot be unticked. Confirm or Not now.
  import { displayName } from '../../../../shared/protocol.ts';
  import { store } from '../store.svelte.ts';
  import { T } from '../text.ts';

  const c = $derived(store.compact);
  // Names the person ticks to keep, starting with the proposal's keeps.
  let keep = $state<Set<string>>(new Set());
  let seeded = '';
  $effect(() => {
    if (c && c.phase === 'proposed' && seeded !== c.id) {
      seeded = c.id;
      keep = new Set(c.keep.map((k) => k.name));
    }
  });
  const forced = $derived(new Set((c?.keep ?? []).filter((k) => k.forced).map((k) => k.name)));
  const why = $derived(Object.fromEntries((c?.keep ?? []).map((k) => [k.name, k.why])));
  const everyone = $derived(c ? [...c.keep.map((k) => k.name), ...c.archive] : []);
  /** Each helper's job, so the person knows who is who. */
  const job = $derived(Object.fromEntries(Object.values(store.agents).map((a) => [a.name, a.title])));

  function toggle(name: string, on: boolean) {
    const next = new Set(keep);
    if (on) next.add(name);
    else if (!forced.has(name)) next.delete(name);
    keep = next;
  }
</script>

{#if c && c.phase === 'proposed'}
  <div class="card" role="alertdialog" tabindex="-1" aria-labelledby="tidy-h" aria-describedby="tidy-intro">
    <h2 id="tidy-h">{T.compact.cardTitle}</h2>
    <p id="tidy-intro" class="intro">{T.compact.cardIntro(keep.size, everyone.length - keep.size)}</p>
    {#if c.note}
      <p class="note"><b>{T.compact.noteFrom(displayName(store.lead?.name ?? 'alpha'))}</b> {c.note}</p>
    {/if}
    <ul>
      {#each everyone as name (name)}
        <li>
          <label class:locked={forced.has(name)}>
            <input type="checkbox" checked={keep.has(name)} disabled={forced.has(name) || !store.mayAnswer} onchange={(e) => toggle(name, e.currentTarget.checked)} />
            <span class="who">{displayName(name)}</span>
            {#if job[name]}<span class="job">{job[name]}</span>{/if}
            <span class="what">{forced.has(name) ? T.compact.forced : why[name] ? T.compact.why(why[name]!) : ''}</span>
          </label>
        </li>
      {/each}
    </ul>
    {#if store.mayAnswer}
      <div class="actions">
        <button class="btn ghost" onclick={() => store.answerCompact([...keep], false)}>{T.compact.cancel}</button>
        <button class="btn primary" onclick={() => store.answerCompact([...keep], true)}>{T.compact.confirm}</button>
      </div>
    {:else}
      <!-- A read-only device sees the proposal but cannot answer it (the server refuses). -->
      <p class="cannot" role="note">{T.device.cannotTidy}</p>
    {/if}
  </div>
{/if}

<style>
  .card {
    padding: 12px 14px;
    border: 1px solid var(--accent);
    border-radius: 12px;
    background: var(--raised);
    box-shadow: var(--shadow);
  }
  h2 {
    margin: 0 0 4px;
    font-size: 15px;
  }
  .intro,
  .note {
    margin: 0 0 8px;
    font-size: 13.5px;
    color: var(--muted);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 40vh;
    overflow-y: auto;
  }
  label {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 0;
    font-size: 14px;
    min-width: 0;
  }
  label input {
    accent-color: var(--accent);
  }
  .who {
    flex: none;
    font-weight: 600;
  }
  .job {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text);
    font-size: 13px;
  }
  .what {
    min-width: 0;
    color: var(--muted);
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }
  .locked .what {
    font-style: italic;
  }
  .cannot {
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }
  @media (pointer: coarse) {
    label {
      min-height: 44px;
      align-items: center;
    }
    label input {
      width: 22px;
      height: 22px;
    }
  }
</style>
