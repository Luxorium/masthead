<script lang="ts">
  // How much of the person's Claude usage is spent: one quiet line that opens into every window.
  import type { RateLimitNotice } from '../../../shared/protocol.ts';
  import { store } from './store.svelte.ts';
  import { T } from './text.ts';

  let open = $state(false);
  const ORDER = Object.keys(T.usage.names);

  const limits = $derived(
    Object.values(store.usage ?? {}).filter((n): n is RateLimitNotice => !!n && typeof n === 'object').sort((a, b) => {
      const ia = ORDER.indexOf(a.type ?? ''), ib = ORDER.indexOf(b.type ?? '');
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    }),
  );

  const name = (n: RateLimitNotice) => (n.type ? (T.usage.names[n.type] ?? n.type.replace(/_/g, ' ')) : T.usage.other);

  /**
   * Percent used, or null when not reported. sdk.d.ts does not say the scale of this field (its
   * /usage endpoint uses 0-100), so a value of 1 or less is read as a fraction.
   */
  function percent(n: RateLimitNotice): number | null {
    if (typeof n.utilization !== 'number' || !Number.isFinite(n.utilization)) return null;
    const p = n.utilization <= 1 ? n.utilization * 100 : n.utilization;
    return Math.max(0, Math.min(100, Math.round(p)));
  }

  function resets(n: RateLimitNotice): string | null {
    if (!n.resetsAt) return null;
    const d = new Date(n.resetsAt * 1000);
    const soon = d.getTime() - Date.now() < 20 * 3600 * 1000;
    return d.toLocaleString([], soon ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  /** The line shown when closed: the window closest to its limit. */
  const top = $derived(
    limits.reduce<{ n: RateLimitNotice; p: number } | null>((best, n) => {
      const p = n.status === 'rejected' ? 100 : (percent(n) ?? -1);
      return !best || p > best.p ? { n, p } : best;
    }, null),
  );
</script>

<section class="usage">
  <button class="summary" onclick={() => (open = !open)} aria-expanded={open}>
    <span class="label">{T.usage.title}</span>
    {#if top && top.p >= 0}
      <span class="value" class:hot={top.n.status !== 'allowed'}>{top.n.status === 'rejected' ? T.usage.reached : T.usage.used(top.p)}</span>
    {:else if limits.length === 0}
      <span class="value faint">{T.usage.notReported}</span>
    {/if}
    <span class="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
  </button>
  {#if open}
    <div class="list">
      {#if limits.length === 0}
        <p class="small muted">{T.usage.none}</p>
      {:else}
        {#each limits as n (n.type ?? '')}
          {@const p = percent(n)}
          {@const r = resets(n)}
          <div class="limit">
            <div class="limit-head">
              <span>{name(n)}</span>
              {#if n.status === 'rejected'}<span class="limit-hit">{T.usage.reached}</span>{:else if p !== null}<span class="pct">{T.usage.used(p)}</span>{/if}
            </div>
            {#if p !== null}
              <div class="bar" class:hot={n.status !== 'allowed'} role="progressbar" aria-valuenow={p} aria-valuemin="0" aria-valuemax="100" aria-label={name(n)}><i style:width="{p}%"></i></div>
            {/if}
            {#if r}<div class="small muted">{T.usage.resets(r)}</div>{/if}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</section>

<style>
  .usage {
    padding: 4px 10px;
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 32px;
    padding: 4px 6px;
    border-radius: 6px;
    font-size: 12.5px;
    color: var(--muted);
    text-align: left;
  }
  .summary:hover {
    background: color-mix(in srgb, var(--text) 6%, transparent);
  }
  .value {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .value.hot {
    color: var(--warn);
  }
  .value.faint {
    color: var(--faint);
  }
  .chev {
    color: var(--faint);
  }
  .list {
    padding: 6px 6px 8px;
  }
  .limit + .limit {
    margin-top: 10px;
  }
  .limit-head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 12.5px;
  }
  .pct {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .limit-hit {
    color: var(--bad);
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--border);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .bar.hot i {
    background: var(--warn);
  }
  .small {
    margin: 3px 0 0;
    font-size: 12px;
  }
</style>
