<script lang="ts">
  // "Agents on this computer": each agent program the server looked for, with one plain next step.
  import { store } from '../store.svelte.ts';
  import { ST } from './text.ts';
  import { readBackends, type BackendEntry } from './types.ts';

  const backends = $derived(readBackends(store.backends));
  let checking = $state(false);

  $effect(() => {
    // The `backends` reply updates store.backends by itself; this only ends the "Checking…" state.
    const off = store.listen('backends', () => (checking = false));
    return off;
  });

  function check(): void {
    if (store.request({ t: 'check_backends' })) checking = true;
  }

  /** The one next step for a program that is not ready, in plain words. */
  function nextStep(b: BackendEntry): string {
    if (!b.path) return ST.backends.install(b.label);
    if (b.signedIn === false) return ST.backends.signIn(b.label);
    if (b.minVersion && b.version && b.error && /old|version/i.test(b.error)) return ST.backends.tooOld(b.label, b.minVersion);
    return b.error ?? ST.backends.install(b.label);
  }

  function stateOf(b: BackendEntry): string {
    if (b.available) return ST.backends.found;
    return b.path ? ST.backends.notReady : ST.backends.notFound;
  }
</script>

<section class="backends" aria-labelledby="backends-h">
  <h3 id="backends-h" class="section-label">{ST.backends.heading}</h3>
  <p class="muted intro">{ST.backends.intro}</p>
  {#if backends.length === 0}
    <p class="muted">{ST.backends.none}</p>
  {/if}
  <ul class="list">
    {#each backends as b (b.id)}
      <li class="entry" class:ready={b.available}>
        <div class="row">
          <span class="name">{b.label}</span>
          <span class="state" class:ok={b.available} class:bad={!b.available}>{stateOf(b)}</span>
        </div>
        {#if b.version || b.available}
          <div class="meta muted">
            {#if b.version}<span>{ST.backends.version(b.version)}</span>{/if}
            {#if b.available && b.models.length}<span>{ST.backends.models(b.models.length)}</span>{/if}
          </div>
        {/if}
        {#if !b.available}
          <p class="step">{nextStep(b)}</p>
        {/if}
        {#if b.warning}
          <p class="note" role="note"><strong>{ST.backends.note}:</strong> {b.warning}</p>
        {/if}
      </li>
    {/each}
  </ul>
  <button type="button" class="btn" onclick={check} disabled={checking} aria-busy={checking}>
    {checking ? ST.backends.checking : ST.backends.checkAgain}
  </button>
</section>

<style>
  .section-label {
    margin: 0 0 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .intro {
    margin: 0 0 10px;
    font-size: 13px;
  }
  .list {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .entry {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    padding: 10px 12px;
  }
  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .name {
    font-weight: 600;
  }
  .state {
    font-size: 12px;
  }
  .state.ok {
    color: var(--ok);
  }
  .state.bad {
    color: var(--bad);
  }
  .meta {
    display: flex;
    gap: 12px;
    font-size: 12px;
    margin-top: 2px;
    flex-wrap: wrap;
  }
  .step,
  .note {
    margin: 6px 0 0;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .note {
    color: var(--warn);
  }
  @media (pointer: coarse) {
    .btn {
      min-height: 44px;
    }
  }
</style>
