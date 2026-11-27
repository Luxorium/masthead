<script lang="ts">
  // Edits one team on a copy: 1 to 5 levels, each with its program, model and thinking time from that
  // program's real model list, helpers at a time, colour and the "keep light" switch. Nothing is sent
  // until Save; the problems list says in plain words what stops saving.
  import { MAX_PER_TIER, MAX_TIERS, PALETTE, type TeamProfile, type TierSpec } from '../../../../shared/protocol.ts';
  import { addLevel, backendOf, EFFORT_ORDER, modelOf, problems, removeLevel, withModel } from './logic.ts';
  import { ST } from './text.ts';
  import type { BackendEntry } from './types.ts';

  let {
    profile,
    all,
    backends,
    onsave,
    oncancel,
  }: { profile: TeamProfile; all: TeamProfile[]; backends: BackendEntry[]; onsave: (p: TeamProfile) => void; oncancel: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let draft = $state<TeamProfile>(structuredClone($state.snapshot(profile) as TeamProfile));
  let tried = $state(false);
  const issues = $derived(problems(draft, all, backends));
  const uid = Math.random().toString(36).slice(2, 8);
  const fid = (i: number, what: string) => `lvl-${uid}-${i}-${what}`;

  const programs = $derived(backends.filter((b) => b.models.length > 0 || draft.tiers.some((t) => t.backend === b.id)));

  function setTier(i: number, change: (t: TierSpec) => TierSpec): void {
    draft.tiers[i] = change(draft.tiers[i]!);
  }

  function setModel(i: number, id: string): void {
    const t = draft.tiers[i]!;
    setTier(i, () => withModel(t, modelOf(backends, t.backend, id), modelOf(backends, t.backend, t.model)));
  }

  function setProgram(i: number, id: string): void {
    // One program per team for now: every level follows, each to that program's model at its place.
    const list = backendOf(backends, id)?.models ?? [];
    draft.tiers = draft.tiers.map((t, k) => {
      const m = list[Math.min(k, list.length - 1)];
      return withModel({ ...t, backend: id }, m, undefined);
    });
    void i;
  }

  function move(i: number, by: -1 | 1): void {
    const j = i + by;
    if (i <= 0 || j <= 0 || j >= draft.tiers.length) return; // the main assistant stays first
    const t = [...draft.tiers];
    [t[i], t[j]] = [t[j]!, t[i]!];
    draft.tiers = t;
  }

  function save(): void {
    tried = true;
    if (issues.length > 0) return;
    onsave($state.snapshot(draft) as TeamProfile);
  }

  const efforts = (t: TierSpec) => {
    const m = modelOf(backends, t.backend, t.model);
    return m && m.efforts.length ? EFFORT_ORDER.filter((e) => m.efforts.includes(e)) : EFFORT_ORDER;
  };
</script>

<form class="editor" onsubmit={(e) => (e.preventDefault(), save())} aria-label={ST.teams.edit(draft.label || '…')}>
  <label class="field">
    <span>{ST.teams.teamName}</span>
    <input type="text" bind:value={draft.label} maxlength="40" />
  </label>

  <ol class="levels">
    {#each draft.tiers as t, i (t.id)}
      {@const b = backendOf(backends, t.backend)}
      {@const models = b?.models ?? []}
      <li class="level pal-{t.colour}">
        <div class="head">
          <span class="swatch" aria-hidden="true"></span>
          <span class="title">{ST.level.title(i + 1, t.label || t.model || '…')}</span>
        </div>
        <div class="grid">
          {#if i === 0}
            <label class="field" for={fid(i, 'program')}>
              <span>{ST.level.program}</span>
              <select id={fid(i, 'program')} value={t.backend} onchange={(e) => setProgram(i, e.currentTarget.value)}>
                {#each programs as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
                {#if !b}<option value={t.backend}>{t.backend}</option>{/if}
              </select>
            </label>
          {/if}
          <label class="field" for={fid(i, 'model')}>
            <span>{ST.level.model}</span>
            <select id={fid(i, 'model')} value={t.model} onchange={(e) => setModel(i, e.currentTarget.value)}>
              {#if !models.some((m) => m.id === t.model)}<option value={t.model}>{t.label || t.model || '—'}</option>{/if}
              {#each models as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
            </select>
          </label>
          <label class="field" for={fid(i, 'thinking')}>
            <span>{ST.level.thinking}</span>
            <select id={fid(i, 'thinking')} value={t.effort} onchange={(e) => setTier(i, (x) => ({ ...x, effort: e.currentTarget.value as TierSpec['effort'] }))}>
              {#each efforts(t) as e (e)}<option value={e}>{ST.level.thinkingLevel[e]}</option>{/each}
            </select>
          </label>
          <label class="field" for={fid(i, 'name')}>
            <span>{ST.level.name}</span>
            <input id={fid(i, 'name')} type="text" maxlength="40" value={t.label} oninput={(e) => setTier(i, (x) => ({ ...x, label: e.currentTarget.value }))} />
          </label>
          {#if i > 0}
            <label class="field" for={fid(i, 'helpers')}>
              <span>{ST.level.helpers}</span>
              <input id={fid(i, 'helpers')} type="number" min="0" max={MAX_PER_TIER} step="1" inputmode="numeric" value={t.max}
                oninput={(e) => setTier(i, (x) => ({ ...x, max: Number(e.currentTarget.value) }))} />
            </label>
          {:else}
            <p class="hint muted">{ST.level.helpersNone}</p>
          {/if}
          <label class="field" for={fid(i, 'colour')}>
            <span>{ST.level.colour}</span>
            <select id={fid(i, 'colour')} value={t.colour} onchange={(e) => setTier(i, (x) => ({ ...x, colour: e.currentTarget.value as TierSpec['colour'] }))}>
              {#each PALETTE as c (c)}<option value={c}>{ST.level.colourName[c]}</option>{/each}
            </select>
          </label>
          <label class="check" for={fid(i, 'light')}>
            <input id={fid(i, 'light')} type="checkbox" checked={t.lean} onchange={(e) => setTier(i, (x) => ({ ...x, lean: e.currentTarget.checked }))} aria-describedby={fid(i, 'lighthint')} />
            <span>{ST.level.light}</span>
          </label>
          <p id={fid(i, 'lighthint')} class="hint muted">{ST.level.lightHint}</p>
        </div>
        {#if i > 0}
          <div class="actions">
            <button type="button" class="btn ghost" onclick={() => move(i, -1)} disabled={i <= 1}>{ST.level.moveUp}</button>
            <button type="button" class="btn ghost" onclick={() => move(i, 1)} disabled={i >= draft.tiers.length - 1}>{ST.level.moveDown}</button>
            <button type="button" class="btn ghost danger" onclick={() => (draft = removeLevel(draft, i))}>{ST.level.removeLevel}</button>
          </div>
        {/if}
      </li>
    {/each}
  </ol>

  {#if draft.tiers.length < MAX_TIERS}
    <button type="button" class="btn" onclick={() => (draft = addLevel(draft, backends))}>{ST.level.add}</button>
  {/if}

  {#if tried && issues.length > 0}
    <ul class="problems" role="alert">
      {#each issues as p (p)}<li>{p}</li>{/each}
    </ul>
  {/if}

  <div class="actions end">
    <button type="button" class="btn ghost" onclick={oncancel}>{ST.teams.cancel}</button>
    <button type="submit" class="btn primary">{ST.teams.save}</button>
  </div>
</form>

<style>
  .editor {
    display: grid;
    gap: 10px;
  }
  .levels {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  .level {
    border: 1px solid var(--border);
    border-left: 3px solid var(--tier);
    border-radius: var(--radius);
    background: var(--panel);
    padding: 10px 12px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-weight: 600;
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--tier);
    flex: none;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px 12px;
    align-items: end;
  }
  .field {
    display: grid;
    gap: 3px;
    font-size: 12px;
    color: var(--muted);
  }
  .field input,
  .field select {
    font: inherit;
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: calc(var(--radius) - 2px);
    padding: 5px 7px;
    min-width: 0;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .hint {
    margin: 0;
    font-size: 12px;
    grid-column: 1 / -1;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .actions.end {
    justify-content: flex-end;
  }
  .problems {
    margin: 0;
    padding: 8px 12px 8px 28px;
    border: 1px solid var(--bad);
    border-radius: var(--radius);
    color: var(--bad);
    font-size: 13px;
  }
  @media (pointer: coarse) {
    .field input,
    .field select {
      font-size: 16px;
      min-height: 44px;
    }
    .check input {
      width: 24px;
      height: 24px;
    }
    .check {
      min-height: 44px;
    }
    .btn {
      min-height: 44px;
    }
  }
</style>
