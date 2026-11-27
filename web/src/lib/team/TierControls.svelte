<script lang="ts">
  // Advanced only: per level, how many helpers may work at a time and how long they may think.
  import { EFFORTS, MAX_PER_TIER, modelLabel, type Effort, type Settings, type Tier } from '../../../../shared/protocol.ts';
  import { store } from '../store.svelte.ts';
  import { T } from '../text.ts';

  const WORKERS: Tier[] = ['opus', 'sonnet', 'haiku'];
  const ABOVE: Record<Tier, Tier | null> = { lead: null, opus: 'lead', sonnet: 'opus', haiku: 'sonnet' };

  function under(tier: Tier, s: Settings): string {
    const above = ABOVE[tier];
    return above ? T.team.startedBy(modelLabel(s.tiers[above].model)) : T.team.theOne;
  }

  function step(tier: Tier, by: number) {
    store.updateSettings((s) => (s.tiers[tier].max = Math.max(0, Math.min(MAX_PER_TIER, s.tiers[tier].max + by))));
  }

  const count = (tier: Tier, live: (a: { status: string }) => boolean) => store.agentList.filter((a) => a.tier === tier && live(a)).length;
  const running = (tier: Tier) => count(tier, (a) => a.status === 'running' || a.status === 'waiting');
  const queued = (tier: Tier) => count(tier, (a) => a.status === 'queued');
</script>

{#if store.settings}
  {@const s = store.settings}
  {@const thinking = s.autoEffort ? T.team.thinkingUpTo : T.team.thinking}
  <section class="levels" aria-labelledby="levels-h">
    <h2 id="levels-h">{T.team.levels}</h2>
    <p class="help">{T.team.levelsHelp}</p>
    {#each ['lead', ...WORKERS] as tier (tier)}
      {@const t = tier as Tier}
      <div class="tier tier-{t}" class:off={t !== 'lead' && s.tiers[t].max === 0}>
        <div class="tier-head">
          <span class="tier-badge tier-{t}">{modelLabel(s.tiers[t].model)}</span>
          <span class="under">{under(t, s)}</span>
        </div>
        {#if t !== 'lead'}
          <div class="line">
            <span>
              {T.team.atATime}
              {#if running(t) > 0}<span class="now"> · {T.team.working(running(t))}</span>{/if}
              {#if queued(t) > 0}<span class="queued"> · {T.team.queued(queued(t))}</span>{/if}
            </span>
            <span class="stepper">
              <button onclick={() => step(t, -1)} disabled={s.tiers[t].max <= 0} aria-label={T.team.fewer(modelLabel(s.tiers[t].model))}>−</button>
              <output aria-live="polite">{s.tiers[t].max === 0 ? T.team.off : s.tiers[t].max}</output>
              <button onclick={() => step(t, 1)} disabled={s.tiers[t].max >= MAX_PER_TIER} aria-label={T.team.more(modelLabel(s.tiers[t].model))}>+</button>
            </span>
          </div>
        {/if}
        <label class="line">
          <span>{thinking}</span>
          <select value={s.tiers[t].effort} onchange={(e) => store.updateSettings((n) => (n.tiers[t].effort = e.currentTarget.value as Effort))}>
            {#each EFFORTS as e (e)}<option value={e}>{T.effort[e]}</option>{/each}
          </select>
        </label>
      </div>
    {/each}
  </section>
{/if}

<style>
  section {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0 0 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .help {
    margin: 0 0 10px;
    font-size: 12px;
    color: var(--muted);
  }
  .tier {
    margin-bottom: 8px;
    padding: 9px 10px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--tier);
    border-radius: var(--radius);
    background: var(--raised);
  }
  .tier.off {
    opacity: 0.6;
  }
  .tier-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .under {
    font-size: 12px;
    color: var(--faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 30px;
    font-size: 13.5px;
  }
  .queued {
    color: var(--muted);
  }
  .now {
    color: var(--accent);
  }
  select {
    max-width: 100%;
    padding: 3px 6px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--raised);
    font-size: 13px;
  }
  .stepper {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    overflow: hidden;
  }
  .stepper button {
    width: 26px;
    height: 24px;
    font-size: 15px;
    line-height: 1;
  }
  .stepper button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
  .stepper output {
    min-width: 30px;
    text-align: center;
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  @media (pointer: coarse) {
    .stepper button {
      width: 44px;
      height: 44px;
    }
  }
</style>
