<script lang="ts" module>
  // When the person last pressed a key anywhere, so a new card does not take focus mid-typing.
  let lastKey = 0;
  if (typeof window !== 'undefined') window.addEventListener('keydown', () => (lastKey = Date.now()), true);
</script>

<script lang="ts">
  import { T } from '../text.ts';
  // A device on the tailnet asks to use Masthead: the person compares the code and decides.
  import { onMount } from 'svelte';
  import { store } from '../store.svelte.ts';
  import { RT } from './text.ts';
  import { spacedCode, type RemoteRequest, type RemoteRole } from './types.ts';

  let { request }: { request: RemoteRequest } = $props();
  // The most limited level is chosen until the person picks more.
  let role = $state<RemoteRole>('read');
  let card = $state<HTMLDivElement | null>(null);
  const ROLES: RemoteRole[] = ['read', 'approve', 'full'];

  // Takes focus when it appears, unless the person is typing (the PermissionCard rule).
  onMount(() => {
    const active = document.activeElement as HTMLElement | null;
    const field = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active.value.trim().length > 0 : !!active?.isContentEditable;
    const onCard = !!active?.closest('[role="alertdialog"]');
    if (Date.now() - lastKey >= 1500 && !field && !onCard) card?.focus({ preventScroll: true });
  });

  function decide(decision: 'allow' | 'deny') {
    store.request({ t: 'device_decision', requestId: request.id, decision, ...(decision === 'allow' ? { role } : {}) });
  }
</script>

<div bind:this={card} class="card" role="alertdialog" tabindex="-1" aria-label={RT.request.label(request.nodeName)} aria-describedby="dr-{request.id}">
  <h3>{RT.request.heading(request.nodeName)}</h3>
  <p class="muted small">{RT.request.from(request.os, request.user?.login, request.address)}</p>
  <p id="dr-{request.id}">{RT.request.codeLead}</p>
  <p class="code mono" aria-label={T.images.code(request.code)}>{spacedCode(request.code)}</p>
  <fieldset class="roles">
    <legend>{RT.request.role}</legend>
    {#each ROLES as r (r)}
      <label class="choice">
        <input type="radio" name="dr-role-{request.id}" value={r} checked={role === r} onchange={() => (role = r)} aria-describedby="dr-{request.id}-{r}" />
        <span><b>{RT.role[r]}</b><small id="dr-{request.id}-{r}">{RT.request.roleHelp[r]}</small></span>
      </label>
    {/each}
  </fieldset>
  {#if role === 'full'}<p class="warn">{RT.request.warning}</p>{/if}
  <div class="actions">
    <button class="btn danger" onclick={() => decide('deny')}>{RT.request.deny}</button>
    <button class="btn primary" onclick={() => decide('allow')}>{RT.request.allow(role)}</button>
  </div>
</div>

<style>
  .card {
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--raised);
    box-shadow: var(--shadow);
    padding: 14px 16px;
    margin-bottom: 10px;
  }
  .card:focus {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  h3 {
    margin: 0 0 4px;
    font-family: var(--serif);
    font-weight: 600;
    font-size: 16px;
  }
  .small {
    font-size: 13px;
    margin: 0 0 8px;
  }
  .code {
    font-size: 28px;
    letter-spacing: 0.08em;
    margin: 4px 0 8px;
  }
  .warn {
    color: var(--warn);
    font-size: 14px;
  }
  .roles {
    border: 0;
    margin: 8px 0;
    padding: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 4px;
    font-weight: 600;
  }
  .choice {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 4px 0;
    cursor: pointer;
  }
  .choice input {
    margin-top: 3px;
  }
  .choice span {
    display: flex;
    flex-direction: column;
  }
  .choice small {
    color: var(--muted);
    font-size: 13px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  @media (pointer: coarse) {
    .btn,
    .choice {
      min-height: 44px;
      font-size: 16px;
    }
    .choice input {
      width: 20px;
      height: 20px;
    }
  }
</style>
