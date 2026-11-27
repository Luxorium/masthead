<script lang="ts">
  // Advanced only: the levels of this chat's team (its profile), each with how many helpers may work at
  // a time and how long they may think. Levels come from the profile in the settings, 1 to 5 of them.
  import { EFFORTS, MAX_PER_TIER, modelLabel, type Effort, type Settings } from '../../../../shared/protocol.ts';
  import { store } from '../store.svelte.ts';
  import { T } from '../text.ts';
  import { profileById, tierClass } from '../tiers.ts';

  const profile = $derived(profileById(store.settings, store.conv?.profileId ?? store.settings?.defaultProfile));

  /** Changes one level of this profile and saves (the whole profile list goes, as the server expects). */
  function change(index: number, edit: (t: Settings['profiles'][number]['tiers'][number]) => void) {
    const id = profile?.id;
    if (!id) return;
    store.updateSettings((s) => {
      const p = s.profiles.find((x) => x.id === id);
      if (p?.tiers[index]) edit(p.tiers[index]!);
    });
  }

  const count = (tier: string, live: (a: { status: string }) => boolean) => store.agentList.filter((a) => a.tier === tier && live(a)).length;
  const running = (tier: string) => count(tier, (a) => a.status === 'running' || a.status === 'waiting');
  const queued = (tier: string) => count(tier, (a) => a.status === 'queued');
  const label = (t: { label: string; model: string }) => t.label || modelLabel(t.model);
</script>

{#if store.settings && profile}
  {@const s = store.settings}
  {@const thinking = s.autoEffort ? T.team.thinkingUpTo : T.team.thinking}
  <section class="levels" aria-labelledby="levels-h">
    <h2 id="levels-h">{T.team.levels}</h2>
    <p class="help">{T.team.levelsHelp}</p>
    {#each profile.tiers as t, i (t.id)}
      <div class="tier tier-{t.id} {tierClass(s, t.id)}" class:off={i > 0 && t.max === 0}>
        <div class="tier-head">
          <span class="tier-badge {tierClass(s, t.id)}">{label(t)}</span>
          <span class="under">{i === 0 ? T.team.theOne : T.team.startedBy(label(profile.tiers[i - 1]!))}</span>
        </div>
        {#if i > 0}
          <div class="line">
            <span>
              {T.team.atATime}
              {#if running(t.id) > 0}<span class="now"> · {T.team.working(running(t.id))}</span>{/if}
              {#if queued(t.id) > 0}<span class="queued"> · {T.team.queued(queued(t.id))}</span>{/if}
            </span>
            <span class="stepper">
              <button onclick={() => change(i, (x) => (x.max = Math.max(0, x.max - 1)))} disabled={t.max <= 0} aria-label={T.team.fewer(label(t))}>−</button>
              <output aria-live="polite">{t.max === 0 ? T.team.off : t.max}</output>
              <button onclick={() => change(i, (x) => (x.max = Math.min(MAX_PER_TIER, x.max + 1)))} disabled={t.max >= MAX_PER_TIER} aria-label={T.team.more(label(t))}>+</button>
            </span>
          </div>
        {/if}
        <label class="line">
          <span>{thinking}</span>
          <select value={t.effort} onchange={(e) => change(i, (x) => (x.effort = e.currentTarget.value as Effort))}>
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
