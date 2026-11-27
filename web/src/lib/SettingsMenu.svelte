<script lang="ts">
  import { tick } from 'svelte';
  import { PERMISSION_CHOICES, type PermissionChoice } from '../../../shared/protocol.ts';
  import { shortPath, store } from './store.svelte.ts';

  const MODE: Record<PermissionChoice, string> = {
    inherit: 'Use my Claude Code settings',
    default: 'Ask me first',
    acceptEdits: 'Accept file edits, ask for the rest',
    auto: 'Auto (a classifier decides)',
    bypassPermissions: 'Bypass all checks',
  };

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
    title="Settings"
    aria-label="Settings"
    aria-haspopup="dialog"
    aria-expanded={open}>⚙</button
  >
  {#if open && store.settings}
    {@const s = store.settings}
    <div bind:this={panel} class="panel" role="dialog" aria-label="Settings">
      <h2>Settings</h2>
      <label class="mode">
        <span>Permissions</span>
        <select value={s.permissionMode} onchange={(e) => store.updateSettings((n) => (n.permissionMode = e.currentTarget.value as PermissionChoice))}>
          {#each PERMISSION_CHOICES as m (m)}<option value={m}>{MODE[m]}</option>{/each}
        </select>
      </label>
      {#if s.permissionMode === 'bypassPermissions'}
        <p class="warn">Every agent can run any command and change any file without asking.</p>
      {/if}
      <label class="check">
        <input type="checkbox" checked={s.autoEffort} onchange={(e) => store.updateSettings((n) => (n.autoEffort = e.currentTarget.checked))} />
        <span>
          <b>Automatic effort</b>
          <small>Everyone starts at Low. The lead raises its own; the others ask the agent above them.</small>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" checked={s.leanOpus} onchange={(e) => store.updateSettings((n) => (n.leanOpus = e.currentTarget.checked))} />
        <span>
          <b>Lean Opus</b>
          <small>Opus agents skip your connected services too.</small>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" checked={s.leanSubagents} onchange={(e) => store.updateSettings((n) => (n.leanSubagents = e.currentTarget.checked))} />
        <span>
          <b>Lean Sonnet and Haiku</b>
          <small>They skip your connected services, which keeps their context small.</small>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" checked={s.collapseReports} onchange={(e) => store.updateSettings((n) => (n.collapseReports = e.currentTarget.checked))} />
        <span>
          <b>Fold agent reports</b>
          <small>Reports show as one line in a chat until you open them.</small>
        </span>
      </label>
      <p class="about">
        Masthead {store.app?.version ?? ''}<br />
        {#if store.app?.claude.path}
          Claude Code {store.app.claude.version ?? ''}<br />
          <span class="mono" title={store.app.claude.path}>{shortPath(store.app.claude.path, store.app.home)}</span>
        {:else}
          Claude Code not found{store.app?.claude.error ? `: ${store.app.claude.error}` : ''}
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
    top: calc(100% + 6px);
    right: 0;
    z-index: 25;
    width: 300px;
    max-height: calc(100vh - 70px);
    overflow-y: auto;
    padding: 14px 16px;
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: var(--raised);
    box-shadow: var(--shadow);
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
