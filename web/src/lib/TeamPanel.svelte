<script lang="ts">
  import {
    EFFORTS,
    EFFORT_LABEL,
    MAX_PER_TIER,
    TIER_LABEL,
    displayName,
    modelLabel,
    type AgentInfo,
    type Effort,
    type RateLimitNotice,
    type Settings,
    type Tier,
  } from '../../../shared/protocol.ts';
  import StopControl from './StopControl.svelte';
  import { fmtTokens, shortPath, statusWords, store } from './store.svelte.ts';

  const WORKERS: Tier[] = ['opus', 'sonnet', 'haiku'];
  const ABOVE: Record<Tier, Tier | null> = { lead: null, opus: 'lead', sonnet: 'opus', haiku: 'sonnet' };

  function under(tier: Tier, s: Settings): string {
    const above = ABOVE[tier];
    if (!above) return 'The one you talk to';
    const name = modelLabel(s.tiers[above].model).split(' ')[0];
    return above === 'lead' ? `Started by ${name}` : `Started by ${name} agents`;
  }
  const update = (change: (s: Settings) => void) => store.updateSettings(change);

  // Names for Claude Code's `rateLimitType` values (sdk.d.ts, SDKRateLimitInfo).
  const LIMIT_NAME: Record<string, string> = {
    five_hour: 'Current session (5 hours)',
    seven_day: 'Weekly, all models',
    seven_day_opus: 'Weekly, Opus',
    seven_day_sonnet: 'Weekly, Sonnet',
    seven_day_overage_included: 'Weekly, with extra usage',
    overage: 'Extra usage',
  };
  const LIMIT_ORDER = Object.keys(LIMIT_NAME);

  const limits = $derived(
    Object.values(store.usage).sort((a, b) => {
      const ia = LIMIT_ORDER.indexOf(a.type ?? ''), ib = LIMIT_ORDER.indexOf(b.type ?? '');
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    }),
  );

  function limitName(n: RateLimitNotice): string {
    if (!n.type) return 'Usage limit';
    return LIMIT_NAME[n.type] ?? n.type.replace(/_/g, ' ');
  }

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

  function step(tier: Tier, by: number) {
    update((s) => (s.tiers[tier].max = Math.max(0, Math.min(MAX_PER_TIER, s.tiers[tier].max + by))));
  }

  function running(tier: Tier): number {
    return store.agentList.filter((a) => a.tier === tier && (a.status === 'running' || a.status === 'waiting')).length;
  }

  function queued(tier: Tier): number {
    return store.agentList.filter((a) => a.tier === tier && a.status === 'queued').length;
  }

  const lead = $derived(store.lead);
  const pct = $derived(lead && lead.usage.contextMax > 0 ? Math.min(100, Math.round((lead.usage.context / lead.usage.contextMax) * 100)) : 0);
  const workers = $derived(store.agentList.filter((a) => a.tier !== 'lead'));
  const totalOut = $derived(store.agentList.reduce((n, a) => n + a.usage.output, 0));
  const isLive = (a: AgentInfo) => a.status === 'queued' || a.status === 'running' || a.status === 'waiting';
</script>

{#snippet branch(parentId: string, depth: number)}
  {#each store.childrenOf(parentId) as a (a.id)}
    <div class="agent" class:viewing={store.viewAgent?.id === a.id} style:padding-left="{8 + depth * 14}px">
      <button class="agent-main" onclick={() => store.viewOf(a.id)} title={a.task}>
        <span class="dot {a.status}"></span>
        <span class="agent-text">
          <span class="agent-name">{displayName(a.name)} <span class="tier-badge tier-{a.tier}">{modelLabel(a.model).split(' ')[0]}</span>{#if a.title}<span class="agent-title"> {a.title}</span>{/if}</span>
          <span class="agent-sub">{statusWords(a)}</span>
        </span>
      </button>
      {#if isLive(a)}
        <StopControl agent={a} placement="row" />
      {/if}
    </div>
    {@render branch(a.id, depth + 1)}
  {/each}
{/snippet}

<aside class="right">
  {#if store.settings}
    {@const s = store.settings}
    <section>
      <h2>Team</h2>
      <div class="tier tier-lead">
        <div class="tier-head">
          <span class="tier-badge tier-lead">{modelLabel(s.tiers.lead.model)}</span>
          <span class="under">{under('lead', s)}</span>
        </div>
        <label class="line">
          <span>{s.autoEffort ? 'Effort up to' : 'Effort'}</span>
          <select value={s.tiers.lead.effort} onchange={(e) => update((n) => (n.tiers.lead.effort = e.currentTarget.value as Effort))}>
            {#each EFFORTS as e (e)}<option value={e}>{EFFORT_LABEL[e]}</option>{/each}
          </select>
        </label>
      </div>

      {#each WORKERS as tier (tier)}
        <div class="tier tier-{tier}" class:off={s.tiers[tier].max === 0}>
          <div class="tier-head">
            <span class="tier-badge tier-{tier}">{modelLabel(s.tiers[tier].model)}</span>
            <span class="under">{under(tier, s)}</span>
          </div>
          <div class="line">
            <span>At once{#if running(tier) > 0}<span class="now"> · {running(tier)} now</span>{/if}{#if queued(tier) > 0}<span class="queued"> · {queued(tier)} queued</span>{/if}</span>
            <span class="stepper">
              <button onclick={() => step(tier, -1)} disabled={s.tiers[tier].max <= 0} aria-label="Fewer {TIER_LABEL[tier]} agents">−</button>
              <output aria-live="polite">{s.tiers[tier].max === 0 ? 'Off' : s.tiers[tier].max}</output>
              <button onclick={() => step(tier, 1)} disabled={s.tiers[tier].max >= MAX_PER_TIER} aria-label="More {TIER_LABEL[tier]} agents">+</button>
            </span>
          </div>
          <label class="line">
            <span>{s.autoEffort ? 'Effort up to' : 'Effort'}</span>
            <select value={s.tiers[tier].effort} onchange={(e) => update((n) => (n.tiers[tier].effort = e.currentTarget.value as Effort))}>
              {#each EFFORTS as e (e)}<option value={e}>{EFFORT_LABEL[e]}</option>{/each}
            </select>
          </label>
        </div>
      {/each}

      {#if s.permissionMode === 'bypassPermissions'}
        <p class="warn">Permissions are set to bypass: every agent can run any command without asking.</p>
      {/if}
    </section>
  {/if}

  <section>
    <h2>Usage</h2>
    {#if limits.length === 0}
      <p class="small muted">No usage reported yet; it appears once an agent has run.</p>
    {:else}
      {#each limits as n (n.type ?? '')}
        {@const p = percent(n)}
        {@const r = resets(n)}
        <div class="limit">
          <div class="limit-head">
            <span>{limitName(n)}</span>
            {#if n.status === 'rejected'}<span class="limit-hit">limit reached</span>{:else if p !== null}<span class="pct">{p}% used</span>{/if}
          </div>
          {#if p !== null}
            <div class="bar" class:hot={n.status !== 'allowed'} role="progressbar" aria-valuenow={p} aria-valuemin="0" aria-valuemax="100" aria-label="{limitName(n)} used"><i style:width="{p}%"></i></div>
          {/if}
          {#if r}<div class="small muted">Resets {r}</div>{/if}
        </div>
      {/each}
    {/if}
  </section>

  {#if store.conv && lead}
    <section>
      <h2>Context</h2>
      <div class="ctx">
        <div class="bar" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100" aria-label="Lead context used"><i style:width="{pct}%"></i></div>
        <span>{pct}%</span>
      </div>
      <p class="small muted">Lead: {fmtTokens(lead.usage.context)} of {fmtTokens(lead.usage.contextMax)} tokens. All agents have written {fmtTokens(totalOut)}.</p>
    </section>

    <section class="grow">
      <h2>
        Agents
        {#if workers.length > 0}<button class="link" onclick={() => (store.view = 'map')}>Open map</button>{/if}
      </h2>
      {#if workers.length === 0}
        <p class="small muted">Only the lead so far. It starts others when the work splits up.</p>
      {:else}
        <div class="agent" class:viewing={store.viewAgent?.id === lead.id} style:padding-left="8px">
          <button class="agent-main" onclick={() => store.viewOf(lead.id)}>
            <span class="dot {lead.status}"></span>
            <span class="agent-text">
              <span class="agent-name">{displayName(lead.name)} <span class="tier-badge tier-lead">{modelLabel(lead.model).split(' ')[0]}</span></span>
              <span class="agent-sub">{statusWords(lead)}</span>
            </span>
          </button>
        </div>
        {@render branch(lead.id, 1)}
      {/if}
    </section>

    <section>
      <h2>Folder</h2>
      <p class="small mono path" title={store.conv.cwd}>{shortPath(store.conv.cwd, store.app?.home)}</p>
    </section>
  {/if}
</aside>

<style>
  aside {
    display: flex;
    flex-direction: column;
    width: 316px;
    min-height: 0;
    overflow-y: auto;
    border-left: 1px solid var(--border);
    background: var(--bg);
  }
  section {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  section.grow {
    flex: 1;
  }
  h2 {
    display: flex;
    align-items: center;
    margin: 0 0 10px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .link {
    margin-left: auto;
    font-size: 12px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--accent);
  }
  .link:hover {
    text-decoration: underline;
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
  .warn {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--bad);
  }
  .limit + .limit {
    margin-top: 10px;
  }
  .limit-head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 13px;
  }
  .pct {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .limit-hit {
    color: var(--bad);
  }
  .limit .small {
    margin-top: 3px;
  }
  .ctx {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    flex: 1;
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
    margin: 6px 0 0;
    font-size: 12.5px;
  }
  .path {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .agent {
    display: flex;
    align-items: center;
    border-radius: 6px;
    padding-right: 4px;
  }
  .agent:hover,
  .agent.viewing {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .agent-main {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 5px 0;
    text-align: left;
  }
  .agent-main .dot {
    margin-top: 7px;
  }
  .agent-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .agent-name {
    font-size: 13.5px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .agent-title {
    font-weight: 400;
    color: var(--muted);
  }
  .agent-sub {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
