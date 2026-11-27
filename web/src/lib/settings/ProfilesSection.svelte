<script lang="ts">
  // "Teams": the team for new chats, each team with its levels, an editor, copies, removal and reset
  // of a built-in team, and the generated Codex team shown as a proposal until the person decides.
  import { CLAUDE_PROFILE, type TeamProfile } from '../../../../shared/protocol.ts';
  import { store } from '../store.svelte.ts';
  import { copyOf, usable } from './logic.ts';
  import TeamEditor from './TeamEditor.svelte';
  import { ST } from './text.ts';
  import { readBackends } from './types.ts';

  const CODEX = 'codex';
  const profiles = $derived(store.settings?.profiles ?? []);
  const backends = $derived(readBackends(store.backends));
  const defaultId = $derived(store.settings?.defaultProfile ?? CLAUDE_PROFILE);
  let editing = $state<string | null>(null);
  let proposalSeen = $state(false);
  const proposal = $derived(!proposalSeen && defaultId !== CODEX ? profiles.find((p) => p.id === CODEX && p.builtIn && usable(p, backends)) : undefined);

  function save(p: TeamProfile): void {
    store.updateSettings((s) => {
      s.profiles = s.profiles.map((x) => (x.id === p.id ? p : x));
      if (!s.profiles.some((x) => x.id === p.id)) s.profiles.push(p);
    });
    editing = null;
    if (p.id === CODEX) proposalSeen = true;
  }

  function duplicate(p: TeamProfile): void {
    const copy = copyOf(p, profiles);
    store.updateSettings((s) => void s.profiles.push(copy));
    editing = copy.id;
  }

  function remove(p: TeamProfile): void {
    if (p.builtIn || !confirm(ST.teams.removeConfirm(p.label))) return;
    store.updateSettings((s) => {
      s.profiles = s.profiles.filter((x) => x.id !== p.id);
      if (s.defaultProfile === p.id) s.defaultProfile = CLAUDE_PROFILE;
    });
  }

  function reset(p: TeamProfile): void {
    if (store.request({ t: 'reset_profile', id: p.id })) editing = null;
  }

  function setDefault(id: string): void {
    store.updateSettings((s) => void (s.defaultProfile = id));
  }

  function useProposal(): void {
    setDefault(CODEX);
    proposalSeen = true;
  }
</script>

<section class="teams" aria-labelledby="teams-h">
  <h3 id="teams-h" class="section-label">{ST.teams.heading}</h3>
  <p class="muted intro">{ST.teams.intro}</p>

  {#if proposal}
    <div class="proposal" role="region" aria-label={ST.teams.proposalTitle}>
      <strong>{ST.teams.proposalTitle}</strong>
      <p>{ST.teams.proposalBody}</p>
      <ol class="mini">
        {#each proposal.tiers as t, i (t.id)}
          <li class="pal-{t.colour}"><span class="dot" aria-hidden="true"></span>{ST.level.title(i + 1, t.label)}</li>
        {/each}
      </ol>
      <div class="actions">
        <button type="button" class="btn primary" onclick={useProposal}>{ST.teams.useIt}</button>
        <button type="button" class="btn" onclick={() => (editing = CODEX)}>{ST.teams.changeFirst}</button>
      </div>
    </div>
  {/if}

  {#if profiles.length > 1}
    <label class="field default">
      <span>{ST.teams.forNewChats}</span>
      <select value={defaultId} onchange={(e) => setDefault(e.currentTarget.value)}>
        {#each profiles as p (p.id)}
          <option value={p.id} disabled={!usable(p, backends)}>{p.label}</option>
        {/each}
      </select>
    </label>
  {/if}

  <ul class="list">
    {#each profiles as p (p.id)}
      {@const ok = usable(p, backends)}
      <li class="team">
        <div class="row">
          <span class="name">{p.label}</span>
          {#if p.builtIn}<span class="tag muted">{ST.teams.builtIn}</span>{/if}
        </div>
        {#if p.description}<p class="muted desc">{p.description}</p>{/if}
        {#if !ok}
          <p class="warn">{ST.teams.unusable(backends.find((b) => b.id === p.tiers[0]?.backend)?.label ?? p.tiers[0]?.backend ?? '')}</p>
        {/if}
        {#if editing === p.id}
          <TeamEditor profile={p} all={profiles} {backends} onsave={save} oncancel={() => (editing = null)} />
        {:else}
          <ol class="mini">
            {#each p.tiers as t, i (t.id)}
              <li class="pal-{t.colour}"><span class="dot" aria-hidden="true"></span>{ST.level.title(i + 1, t.label || t.model)}</li>
            {/each}
          </ol>
          <div class="actions">
            <button type="button" class="btn" onclick={() => (editing = p.id)} aria-label={ST.teams.edit(p.label)}>{ST.teams.edit(p.label)}</button>
            <button type="button" class="btn ghost" onclick={() => duplicate(p)}>{ST.teams.duplicate}</button>
            {#if p.builtIn}
              <button type="button" class="btn ghost" onclick={() => reset(p)}>{ST.teams.reset}</button>
            {:else}
              <button type="button" class="btn ghost danger" onclick={() => remove(p)}>{ST.teams.remove}</button>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
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
  .proposal {
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    border-radius: var(--radius);
    padding: 10px 12px;
    margin-bottom: 12px;
  }
  .proposal p {
    margin: 4px 0 8px;
    font-size: 13px;
  }
  .field {
    display: grid;
    gap: 3px;
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 12px;
    max-width: 320px;
  }
  .field select {
    font: inherit;
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: calc(var(--radius) - 2px);
    padding: 5px 7px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  .team {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--raised);
    padding: 10px 12px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .name {
    font-weight: 600;
  }
  .tag {
    font-size: 11px;
  }
  .desc,
  .warn {
    margin: 4px 0 0;
    font-size: 12px;
  }
  .warn {
    color: var(--warn);
  }
  .mini {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: grid;
    gap: 3px;
    font-size: 13px;
  }
  .mini li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tier);
    flex: none;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  @media (pointer: coarse) {
    .field select {
      font-size: 16px;
      min-height: 44px;
    }
    .btn {
      min-height: 44px;
    }
  }
</style>
