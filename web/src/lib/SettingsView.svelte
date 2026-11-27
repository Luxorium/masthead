<script lang="ts">
  // Settings as a view in place of the chat (it outgrew the popup): General, Teams, Agents on this
  // computer, Remote access, Appearance, About. The team, agent and remote sections are plugged in from
  // web/src/lib/settings and web/src/lib/remote. Esc or Close goes back to the chat.
  import { onMount, tick } from 'svelte';
  import { PERMISSION_CHOICES, type PermissionChoice } from '../../../shared/protocol.ts';
  import { shortPath, store } from './store.svelte.ts';
  import { T } from './text.ts';
  import { ui, type Theme } from './ui.svelte.ts';
  import { isRemoteDevice } from './signin.ts';
  import RemoteSection from './remote/RemoteSection.svelte';
  import BackendsSection from './settings/BackendsSection.svelte';
  import ProfilesSection from './settings/ProfilesSection.svelte';

  /** Choices for the longest a helper may work, in minutes; 0 is no limit. */
  const RUN_LIMITS = [0, 15, 30, 60, 120, 240];
  const runLabel = (m: number) => (m === 0 ? T.settings.noLimit : T.settings.minutes(m));

  let view = $state<HTMLElement | null>(null);

  onMount(() => {
    void tick().then(() => view?.querySelector<HTMLElement>('input, select, button:not(.close)')?.focus());
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      ui.closeSettings();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="settings" role="dialog" tabindex="-1" aria-modal="false" aria-label={T.settings.title} bind:this={view} onkeydown={onKey}>
  <div class="inner">
    <div class="top">
      <h1>{T.settings.title}</h1>
      <button class="btn ghost close" onclick={() => ui.closeSettings()} aria-label={T.settings.close}>×</button>
    </div>

    {#if isRemoteDevice()}
      <section class="group" aria-labelledby="set-device">
        <h2 id="set-device">{T.device.title}</h2>
        <p class="about">{T.device.staysSignedIn}</p>
        {#if store.deviceRole && store.deviceRole !== 'full'}
          <p class="about">{store.deviceRole === 'approve' ? T.device.roleApprove : T.device.roleRead}</p>
          <p class="about small">{T.device.askMore}</p>
        {/if}
        <button class="btn danger forget" onclick={() => store.forgetThisDevice()}>{T.device.forget}</button>
        <p class="about small">{T.device.forgetHelp}</p>
      </section>
    {/if}

    {#if store.settings}
      {@const s = store.settings}
      <!-- Only server settings sit in the disabled fieldsets: a read-only or approve-only device may still
           change what is kept in this browser alone (Show team controls, Colours). -->
      <section class="group" aria-labelledby="set-general">
        <h2 id="set-general">{T.settings.general}</h2>
        <fieldset class="plain" disabled={!store.mayAct}>
        <label class="mode">
          <span>{T.settings.ask}</span>
          <select value={s.permissionMode} onchange={(e) => store.updateSettings((n) => (n.permissionMode = e.currentTarget.value as PermissionChoice))}>
            {#each PERMISSION_CHOICES as m (m)}<option value={m}>{T.settings.askChoices[m]}</option>{/each}
          </select>
        </label>
        {#if s.permissionMode === 'bypassPermissions'}
          <p class="warn">{T.settings.bypassWarning}</p>
        {/if}
        <label class="mode">
          <span>{T.settings.runLimit}</span>
          <select value={s.maxRunMinutes ?? 0} onchange={(e) => store.updateSettings((n) => (n.maxRunMinutes = Number(e.currentTarget.value)))}>
            {#each RUN_LIMITS.includes(s.maxRunMinutes ?? 0) ? RUN_LIMITS : [...RUN_LIMITS, s.maxRunMinutes].sort((a, b) => a - b) as m (m)}<option value={m}>{runLabel(m)}</option>{/each}
          </select>
          <small>{T.settings.runLimitHelp}</small>
        </label>
        <label class="check">
          <input type="checkbox" checked={s.collapseReports} onchange={(e) => store.updateSettings((n) => (n.collapseReports = e.currentTarget.checked))} />
          <span><b>{T.settings.fold}</b><small>{T.settings.foldHelp}</small></span>
        </label>
        {#if 'autoCompact' in s}
          <label class="check">
            <input type="checkbox" checked={(s as { autoCompact?: boolean }).autoCompact !== false} onchange={(e) => store.updateSettings((n) => ((n as { autoCompact?: boolean }).autoCompact = e.currentTarget.checked))} />
            <span><b>{T.compact.setting}</b><small>{T.compact.settingHelp}</small></span>
          </label>
        {/if}
        {#if 'keepAwake' in s}
          <label class="check">
            <input type="checkbox" checked={s.keepAwake} onchange={(e) => store.updateSettings((n) => (n.keepAwake = e.currentTarget.checked))} />
            <span><b>{T.settings.keepAwake}</b><small>{T.settings.keepAwakeHelp}</small></span>
          </label>
        {/if}
        </fieldset>
        <label class="check">
          <input type="checkbox" checked={ui.advanced} onchange={(e) => ui.setAdvanced(e.currentTarget.checked)} />
          <span><b>{T.settings.advanced}</b><small>{T.settings.advancedHelp}</small></span>
        </label>
        {#if ui.advanced}
          <fieldset class="plain" disabled={!store.mayAct}>
          <label class="check">
            <input type="checkbox" checked={s.autoEffort} onchange={(e) => store.updateSettings((n) => (n.autoEffort = e.currentTarget.checked))} />
            <span><b>{T.settings.autoEffort}</b><small>{T.settings.autoEffortHelp}</small></span>
          </label>
          </fieldset>
        {/if}
      </section>

      <fieldset class="plain" disabled={!store.mayAct}>

      <!-- Teams and the agents on this computer (bravo, web/src/lib/settings). -->
      <section class="group plug"><ProfilesSection /></section>
      <section class="group plug"><BackendsSection /></section>

      {#if store.remote}
        <!-- Remote access (golf, web/src/lib/remote): only on this computer's own page. -->
        <section class="group plug">
          <RemoteSection />
        </section>
      {/if}
      </fieldset>

      <section class="group" aria-labelledby="set-look">
        <h2 id="set-look">{T.settings.theme}</h2>
        <label class="mode">
          <span>{T.settings.themeLabel}</span>
          <select value={ui.theme} onchange={(e) => ui.setTheme(e.currentTarget.value as Theme)}>
            <option value="system">{T.settings.themeSystem}</option>
            <option value="light">{T.settings.themeLight}</option>
            <option value="dark">{T.settings.themeDark}</option>
          </select>
        </label>
      </section>

      <section class="group" aria-labelledby="set-about">
        <h2 id="set-about">{T.settings.about}</h2>
        <p class="about">
          {T.app.name} {store.app?.version ?? ''}<br />
          {#if store.app?.claude.path}
            {T.settings.claude(store.app.claude.version ?? '')}<br />
            <span class="mono" title={store.app.claude.path}>{shortPath(store.app.claude.path, store.app.home)}</span>
          {:else}
            {store.app?.claude.version ?? T.settings.claudeMissing}{store.app?.claude.error ? `: ${store.app.claude.error}` : ''}
          {/if}
        </p>
      </section>
    {/if}
  </div>
</div>

<style>
  .settings {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px 20px calc(24px + env(safe-area-inset-bottom));
    outline: none;
  }
  .inner {
    max-width: 640px;
    margin: 0 auto;
  }
  .top {
    display: flex;
    align-items: center;
    margin-bottom: 8px;
  }
  h1 {
    flex: 1;
    margin: 0;
    font-family: var(--serif);
    font-size: 28px;
    font-weight: 600;
  }
  .close {
    min-width: 44px;
    min-height: 44px;
    font-size: 20px;
  }
  .group {
    padding: 16px 0 18px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0 0 10px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--faint);
  }
  select {
    max-width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--raised);
    font-size: 14px;
  }
  .mode {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    margin-top: 10px;
  }
  .mode span {
    font-size: 13px;
    color: var(--muted);
  }
  .mode small,
  .check small {
    display: block;
    font-size: 12.5px;
    color: var(--muted);
    line-height: 1.45;
  }
  .check {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: 14px;
    font-size: 14.5px;
  }
  .check input {
    margin-top: 4px;
    accent-color: var(--accent);
  }
  .check b {
    display: block;
    font-weight: 500;
  }
  .warn {
    margin: 6px 0 0;
    font-size: 13px;
    color: var(--bad);
  }
  .plain {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  .forget {
    margin-top: 12px;
  }
  .small {
    margin-top: 6px;
    font-size: 12.5px;
  }
  .about {
    margin: 0;
    font-size: 13.5px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  @media (pointer: coarse) {
    .check input {
      width: 22px;
      height: 22px;
    }
    select {
      min-height: 44px;
    }
  }
</style>
