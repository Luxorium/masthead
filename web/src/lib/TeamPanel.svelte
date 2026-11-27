<script lang="ts">
  import {
    EFFORTS,
    EFFORT_LABEL,
    MAX_PER_TIER,
    PERMISSION_CHOICES,
    TIER_LABEL,
    displayName,
    modelLabel,
    type AgentInfo,
    type Effort,
    type PermissionChoice,
    type Settings,
    type Tier,
  } from '../../../shared/protocol.ts';
  import { STATUS_LABEL, fmtTokens, shortPath, store } from './store.svelte.ts';

  const WORKERS: Tier[] = ['opus', 'sonnet', 'haiku'];
  const ABOVE: Record<Tier, Tier | null> = { lead: null, opus: 'lead', sonnet: 'opus', haiku: 'sonnet' };

  function under(tier: Tier, s: Settings): string {
    const above = ABOVE[tier];
    if (!above) return 'The one you talk to';
    const name = modelLabel(s.tiers[above].model).split(' ')[0];
    return above === 'lead' ? `Started by ${name}` : `Started by ${name} agents`;
  }
  const MODE: Record<PermissionChoice, string> = {
    inherit: 'Use my Claude Code settings',
    default: 'Ask me first',
    acceptEdits: 'Accept file edits, ask for the rest',
    auto: 'Auto (a classifier decides)',
    bypassPermissions: 'Bypass all checks',
  };

  function update(change: (s: Settings) => void) {
    if (!store.settings) return;
    const next = structuredClone($state.snapshot(store.settings)) as Settings;
    change(next);
    store.saveSettings(next);
  }

  function step(tier: Tier, by: number) {
    update((s) => (s.tiers[tier].max = Math.max(0, Math.min(MAX_PER_TIER, s.tiers[tier].max + by))));
  }

  function running(tier: Tier): number {
    return store.agentList.filter((a) => a.tier === tier && (a.status === 'running' || a.status === 'waiting')).length;
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
          <span class="agent-sub">{a.status === 'running' && a.activity ? a.activity : STATUS_LABEL[a.status]}{a.status === 'failed' && a.error ? `: ${a.error}` : ''}</span>
        </span>
      </button>
      {#if isLive(a)}
        <button class="stop" onclick={() => store.convId && store.send({ t: 'stop_agent', convId: store.convId, agentId: a.id })} title="Stop this agent and everything under it" aria-label="Stop {displayName(a.name)}">■</button>
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
            <span>At once{#if running(tier) > 0}<span class="now"> · {running(tier)} now</span>{/if}</span>
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

      <label class="check">
        <input type="checkbox" checked={s.autoEffort} onchange={(e) => update((n) => (n.autoEffort = e.currentTarget.checked))} />
        <span>
          <b>Automatic effort</b>
          <small>Everyone starts at Low. Fable raises its own; the others ask the agent above them.</small>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" checked={s.leanSubagents} onchange={(e) => update((n) => (n.leanSubagents = e.currentTarget.checked))} />
        <span>
          <b>Lean Sonnet and Haiku</b>
          <small>They skip your connected services, which keeps their context small.</small>
        </span>
      </label>
      <label class="line mode">
        <span>Permissions</span>
        <select value={s.permissionMode} onchange={(e) => update((n) => (n.permissionMode = e.currentTarget.value as PermissionChoice))}>
          {#each PERMISSION_CHOICES as m (m)}<option value={m}>{MODE[m]}</option>{/each}
        </select>
      </label>
      {#if s.permissionMode === 'bypassPermissions'}
        <p class="warn">Every agent can run any command and change any file without asking.</p>
      {/if}
    </section>
  {/if}

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
              <span class="agent-sub">{lead.status === 'running' && lead.activity ? lead.activity : STATUS_LABEL[lead.status]}</span>
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
  .check {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: 10px;
    font-size: 13.5px;
  }
  .check input {
    margin-top: 3px;
    accent-color: var(--accent);
  }
  .check b {
    display: block;
    font-weight: 500;
  }
  .check small {
    display: block;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.4;
  }
  .mode {
    margin-top: 10px;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
  .mode span {
    font-size: 12px;
    color: var(--muted);
  }
  .warn {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--bad);
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
  .stop {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    font-size: 9px;
    color: var(--muted);
  }
  .stop:hover {
    background: color-mix(in srgb, var(--bad) 15%, transparent);
    color: var(--bad);
  }
</style>
