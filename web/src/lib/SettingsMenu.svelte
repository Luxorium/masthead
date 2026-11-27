<script lang="ts">
  import { tick } from 'svelte';
  import { PERMISSION_CHOICES, type PermissionChoice } from '../../../shared/protocol.ts';
  import { shortPath, store } from './store.svelte.ts';
  import { T } from './text.ts';
  import { ui, type Theme } from './ui.svelte.ts';

  /** Choices for the longest a helper may work, in minutes; 0 is no limit. */
  const RUN_LIMITS = [0, 15, 30, 60, 120, 240];
  const runLabel = (m: number) => (m === 0 ? T.settings.noLimit : T.settings.minutes(m));
  let open = $state(false);
  let gear = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLDivElement | null>(null);

  async function toggle() {
    open = !open;
    if (open) {
      await tick();
      panel?.querySelector<HTMLElement>('select, input, button')?.focus();
    }
  }

  function close(refocus: boolean) {
    if (!open) return;
    open = false;
    if (refocus) gear?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      e.preventDefault();
      close(true);
    }
  }

  function onPointer(e: PointerEvent) {
    const t = e.target as Node | null;
    if (open && t && !panel?.contains(t) && !gear?.contains(t)) close(false);
  }
</script>

<svelte:window onkeydown={onKey} onpointerdown={onPointer} />

<div class="wrap">
  <button
    bind:this={gear}
    class="btn ghost icon"
    onclick={toggle}
    title={T.settings.title}
    aria-label={T.settings.title}
    aria-haspopup="dialog"
    aria-expanded={open}>⚙</button
  >
  {#if open && store.settings}
    {@const s = store.settings}
    <div bind:this={panel} class="panel" role="dialog" aria-label={T.settings.title}>
      <button class="close" onclick={() => close(true)} aria-label={T.settings.close}>×</button>
      <h2>{T.settings.title}</h2>
      <label class="check">
        <input type="checkbox" checked={ui.advanced} onchange={(e) => ui.setAdvanced(e.currentTarget.checked)} />
        <span><b>{T.settings.advanced}</b><small>{T.settings.advancedHelp}</small></span>
      </label>
      <label class="mode">
        <span>{T.settings.ask}</span>
        <select value={s.permissionMode} onchange={(e) => store.updateSettings((n) => (n.permissionMode = e.currentTarget.value as PermissionChoice))}>
          {#each PERMISSION_CHOICES as m (m)}<option value={m}>{T.settings.askChoices[m]}</option>{/each}
        </select>
      </label>
      {#if s.permissionMode === 'bypassPermissions'}
        <p class="warn">{T.settings.bypassWarning}</p>
      {/if}
      <label class="check">
        <input type="checkbox" checked={s.collapseReports} onchange={(e) => store.updateSettings((n) => (n.collapseReports = e.currentTarget.checked))} />
        <span><b>{T.settings.fold}</b><small>{T.settings.foldHelp}</small></span>
      </label>
      <label class="mode run">
        <span>{T.settings.runLimit}</span>
        <select value={s.maxRunMinutes ?? 0} onchange={(e) => store.updateSettings((n) => (n.maxRunMinutes = Number(e.currentTarget.value)))}>
          {#each RUN_LIMITS.includes(s.maxRunMinutes ?? 0) ? RUN_LIMITS : [...RUN_LIMITS, s.maxRunMinutes].sort((a, b) => a - b) as m (m)}<option value={m}>{runLabel(m)}</option>{/each}
        </select>
        <small>{T.settings.runLimitHelp}</small>
      </label>
      {#if ui.advanced}
        <label class="check">
          <input type="checkbox" checked={s.autoEffort} onchange={(e) => store.updateSettings((n) => (n.autoEffort = e.currentTarget.checked))} />
          <span><b>{T.settings.autoEffort}</b><small>{T.settings.autoEffortHelp}</small></span>
        </label>
        <label class="check">
          <input type="checkbox" checked={s.leanOpus} onchange={(e) => store.updateSettings((n) => (n.leanOpus = e.currentTarget.checked))} />
          <span><b>{T.settings.leanOpus}</b><small>{T.settings.leanOpusHelp}</small></span>
        </label>
        <label class="check">
          <input type="checkbox" checked={s.leanSubagents} onchange={(e) => store.updateSettings((n) => (n.leanSubagents = e.currentTarget.checked))} />
          <span><b>{T.settings.leanSub}</b><small>{T.settings.leanSubHelp}</small></span>
        </label>
      {/if}
      <label class="mode run">
        <span>{T.settings.theme}</span>
        <select value={ui.theme} onchange={(e) => ui.setTheme(e.currentTarget.value as Theme)}>
          <option value="system">{T.settings.themeSystem}</option>
          <option value="light">{T.settings.themeLight}</option>
          <option value="dark">{T.settings.themeDark}</option>
        </select>
      </label>
      <p class="about">
        {T.app.name} {store.app?.version ?? ''}<br />
        {#if store.app?.claude.path}
          {T.settings.claude(store.app.claude.version ?? '')}<br />
          <span class="mono" title={store.app.claude.path}>{shortPath(store.app.claude.path, store.app.home)}</span>
        {:else}
          {T.settings.claudeMissing}{store.app?.claude.error ? `: ${store.app.claude.error}` : ''}
        {/if}
      </p>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }
  .icon {
    padding: 4px 8px;
    font-size: 16px;
  }
  .panel {
    position: absolute;
    /* Opens upwards from the gear at the foot of the sidebar. */
    bottom: calc(100% + 6px);
    left: -8px;
    z-index: 25;
    width: 300px;
    max-height: calc(100dvh - 80px);
    overflow-y: auto;
    padding: 14px 16px;
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: var(--raised);
    box-shadow: var(--shadow);
  }
  /* Phones: the settings take the whole screen, with a close button. */
  @media (max-width: 599px) {
    .panel {
      position: fixed;
      inset: 0;
      z-index: 40;
      width: auto;
      max-height: none;
      border: 0;
      border-radius: 0;
      padding: calc(14px + env(safe-area-inset-top)) 18px calc(18px + env(safe-area-inset-bottom));
    }
  }
  .close {
    float: right;
    min-width: 44px;
    min-height: 44px;
    font-size: 20px;
    color: var(--muted);
  }
  h2 {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--faint);
  }
  select {
    max-width: 100%;
    padding: 3px 6px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--raised);
    font-size: 13px;
  }
  .mode {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .run {
    margin-top: 12px;
  }
  .run small {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.4;
  }
  .mode span {
    font-size: 12px;
    color: var(--muted);
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
  .warn {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--bad);
  }
  .about {
    margin: 14px 0 0;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
</style>
