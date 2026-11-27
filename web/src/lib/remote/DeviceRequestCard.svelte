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
  let role = $state<RemoteRole>('full');
  let card = $state<HTMLDivElement | null>(null);
  const ROLES: RemoteRole[] = ['full', 'approve', 'read'];

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
  <p class="warn">{RT.request.warning}</p>
  <label class="role">
    <span>{RT.request.role}</span>
    <select value={role} onchange={(e) => (role = e.currentTarget.value as RemoteRole)}>
      {#each ROLES as r (r)}<option value={r}>{RT.role[r]}</option>{/each}
    </select>
  </label>
  <div class="actions">
    <button class="btn danger" onclick={() => decide('deny')}>{RT.request.deny}</button>
    <button class="btn primary" onclick={() => decide('allow')}>{RT.request.allow}</button>
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
  .role {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin: 8px 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  @media (pointer: coarse) {
    .btn,
    select {
      min-height: 44px;
      font-size: 16px;
    }
  }
</style>
