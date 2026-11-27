<script lang="ts">
  // The "Remote access" part of the settings, on the local page only: the switch and Tailscale's
  // state, the command when Tailscale refuses, the address for the other device, the allowed devices
  // and the recent activity.
  import { onDestroy } from 'svelte';
  import { store } from '../store.svelte.ts';
  import { RT } from './text.ts';
  import type { AuditEntry, RemoteRole, RemoteState } from './types.ts';

  const remote = $derived(store.remote as unknown as RemoteState | null);
  let switching = $state(false);
  let copied = $state(false);
  let audit = $state<AuditEntry[] | null>(null);
  let portDraft = $state('');
  let box = $state<HTMLInputElement | null>(null);
  const ROLES: RemoteRole[] = ['read', 'approve', 'full'];

  const offAudit = store.listen('remote_audit', (m) => (audit = ((m.entries as AuditEntry[]) ?? []).slice().reverse()));
  // A refused switch comes back as an error; the state carries the problem and command anyway.
  const offError = store.listen('error', () => settle());
  onDestroy(() => {
    offAudit();
    offError();
  });
  /** The box follows the real state: after a refusal `remote.enabled` has not changed, so Svelte would
      leave the box as the click left it (ticked while the status says "Off"). */
  function settle() {
    switching = false;
    if (box && remote) box.checked = remote.enabled;
  }
  $effect(() => {
    // The switch settles when the state says so.
    void remote?.enabled;
    void remote?.problem;
    settle();
  });
  $effect(() => {
    if (remote && !portDraft) portDraft = String(remote.port);
  });

  function toggle(on: boolean) {
    switching = true;
    if (!store.request({ t: 'remote_settings', enabled: on })) switching = false;
  }
  function setPort() {
    const p = Number(portDraft);
    if (remote && p !== remote.port) store.request({ t: 'remote_settings', port: p });
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      store.fail(text);
    }
  }
</script>

{#if remote}
  <section class="remote" aria-labelledby="remote-title">
    <h2 id="remote-title">{RT.section.title}</h2>
    <p class="muted">{RT.section.intro}</p>

    <label class="switch">
      <input type="checkbox" bind:this={box} checked={remote.enabled} disabled={switching || (!remote.available && !remote.enabled)} onchange={(e) => toggle(e.currentTarget.checked)} />
      <span>{RT.section.switch}</span>
    </label>

    <p role="status" class="state">
      {#if switching}{RT.section.pending}
      {:else if !remote.available && !remote.enabled}{remote.problem ?? RT.section.noTailscale}
      {:else if remote.enabled && remote.url}{RT.section.on(remote.url)}
      {:else}{RT.section.off}{/if}
    </p>
    {#if remote.enabled && remote.url}
      <p class="url"><span class="mono">{remote.url}</span> <button class="btn ghost" onclick={() => copy(remote.url!)} aria-label="{RT.section.copy} {remote.url}">{copied ? RT.section.copied : RT.section.copy}</button></p>
    {/if}
    {#if remote.problem && remote.available}<p class="problem">{remote.problem}</p>{/if}
    {#if remote.command}
      <p>{RT.section.command}</p>
      <div class="command">
        <code class="mono">{remote.command}</code>
        <button class="btn" onclick={() => copy(remote.command!)} aria-label="{RT.section.copy}: {remote.command}">{copied ? RT.section.copied : RT.section.copy}</button>
      </div>
    {/if}
    {#if remote.warning}<p class="warning">{remote.warning}</p>{/if}

    <div class="options">
      <label class="field">
        <span>{RT.section.port}</span>
        <input class="mono" inputmode="numeric" bind:value={portDraft} disabled={remote.enabled} onchange={setPort} aria-describedby={remote.enabled ? 'remote-port-locked' : undefined} />
      </label>
      {#if remote.enabled}<p id="remote-port-locked" class="muted small">{RT.section.portLocked}</p>{/if}
      <label class="switch">
        <input type="checkbox" checked={remote.allowOtherTailnets} onchange={(e) => store.request({ t: 'remote_settings', allowOtherTailnets: e.currentTarget.checked })} />
        <span>{RT.section.otherTailnets}</span>
      </label>
      <label class="switch">
        <input type="checkbox" checked={remote.allowTagged} onchange={(e) => store.request({ t: 'remote_settings', allowTagged: e.currentTarget.checked })} />
        <span>{RT.section.tagged}</span>
      </label>
    </div>

    <h3>{RT.section.devices}</h3>
    {#if remote.devices.length === 0}
      <p class="muted">{RT.section.noDevices}</p>
    {:else}
      <ul class="devices">
        {#each remote.devices as d (d.nodeId)}
          <li aria-label={RT.section.device(d.nodeName)}>
            <div class="who">
              <b>{d.nodeName}</b>
              <span class="muted small">{[d.os, d.user?.login, d.address].filter(Boolean).join(' · ')}</span>
              <span class="muted small">{RT.section.seen(d.lastSeen)} · {RT.section.expires(d.expiresAt)}</span>
            </div>
            <div class="controls">
              <select aria-label={RT.section.deviceRole(d.nodeName)} value={d.role} onchange={(e) => store.request({ t: 'device_role', nodeId: d.nodeId, role: e.currentTarget.value })}>
                {#each ROLES as r (r)}<option value={r}>{RT.role[r]}</option>{/each}
              </select>
              <button class="btn danger" aria-label={RT.section.revokeLabel(d.nodeName)} onclick={() => store.request({ t: 'device_revoke', nodeId: d.nodeId })}>{RT.section.revoke}</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    <h3>{RT.section.audit}</h3>
    {#if audit === null}
      <button class="btn ghost" onclick={() => store.request({ t: 'remote_audit' })}>{RT.section.loadAudit}</button>
    {:else if audit.length === 0}
      <p class="muted">{RT.section.noAudit}</p>
    {:else}
      <ol class="audit">
        {#each audit.slice(0, 50) as e, i (i)}
          <li><span class="muted small">{RT.when(e.ts)}</span> {RT.event(e)}</li>
        {/each}
      </ol>
    {/if}
  </section>
{/if}

<style>
  .remote h2 {
    font-family: var(--serif);
    font-weight: 600;
    font-size: 18px;
    margin: 0 0 4px;
  }
  .remote h3 {
    font-family: var(--serif);
    font-weight: 600;
    font-size: 15px;
    margin: 18px 0 6px;
  }
  .switch {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
  }
  .state {
    margin: 6px 0;
  }
  .url,
  .command {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .url .mono,
  .command code {
    overflow-wrap: anywhere;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
  }
  .problem {
    color: var(--bad);
  }
  .warning {
    color: var(--warn);
    border-left: 3px solid var(--warn);
    padding-left: 10px;
  }
  .field {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .field input {
    width: 7ch;
  }
  .small {
    font-size: 13px;
  }
  .devices,
  .audit {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .devices li {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .controls {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .audit li {
    padding: 3px 0;
  }
  @media (pointer: coarse) {
    .btn,
    select,
    input:not([type='checkbox']) {
      min-height: 44px;
      font-size: 16px;
    }
    input[type='checkbox'] {
      width: 24px;
      height: 24px;
    }
    .switch {
      min-height: 44px;
    }
  }
</style>
