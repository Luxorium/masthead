<script lang="ts">
  // What a device on the tailnet sees until it is allowed: who it is to that computer, a request with
  // a code to compare, and a poll until the person decides. The poll secret survives a reload
  // (sessionStorage), because asking again while a request waits is refused.
  import { onDestroy, onMount } from 'svelte';
  import { deviceToken } from '../signin.ts';
  import { RT } from './text.ts';
  import { spacedCode } from './types.ts';

  let { withdrawn, onapproved }: { withdrawn: boolean; onapproved: (token: string) => void } = $props();

  const PENDING_KEY = 'masthead.pairing';
  type Phase = 'checking' | 'ready' | 'waiting' | 'gone' | 'refused' | 'offline';
  let phase = $state<Phase>('checking');
  let device = $state('this device');
  let code = $state('');
  let message = $state('');
  let busy = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  interface Pending {
    requestId: string;
    pollSecret: string;
    code: string;
  }
  function loadPending(): Pending | null {
    try {
      const p = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as Pending | null;
      return p && typeof p.requestId === 'string' && typeof p.pollSecret === 'string' ? p : null;
    } catch {
      return null;
    }
  }
  function savePending(p: Pending | null): void {
    try {
      if (p) sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch {
      // private mode: the request only lives as long as this page
    }
  }

  async function whoami(): Promise<void> {
    phase = 'checking';
    try {
      const token = deviceToken();
      const res = await fetch('/api/remote/whoami', { headers: token ? { 'x-masthead-device': token } : {} });
      const body = (await res.json()) as { state: string; reason?: string; device?: { name?: string } };
      if (body.device?.name) device = body.device.name;
      if (body.state === 'approved' && token) return onapproved(token);
      if (body.state === 'refused') {
        message = RT.signIn.refused(body.reason ?? 'not allowed');
        phase = 'refused';
        return;
      }
      const pending = loadPending();
      if (pending) {
        code = pending.code;
        phase = 'waiting';
        poll(pending);
      } else phase = 'ready';
    } catch {
      phase = 'offline';
    }
  }

  async function ask(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch('/api/remote/request', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { requestId?: string; pollSecret?: string; code?: string; message?: string };
      if (res.status === 429) {
        message = RT.signIn.tooMany;
        phase = 'refused';
      } else if (!res.ok || !body.requestId || !body.pollSecret || !body.code) {
        message = body.message ?? RT.signIn.notAllowed;
        phase = 'refused';
      } else {
        const p = { requestId: body.requestId, pollSecret: body.pollSecret, code: body.code };
        savePending(p);
        code = p.code;
        phase = 'waiting';
        poll(p);
      }
    } catch {
      phase = 'offline';
    } finally {
      busy = false;
    }
  }

  function poll(p: Pending): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/remote/request/${p.requestId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pollSecret: p.pollSecret }) });
        const body = (await res.json()) as { state: string; token?: string };
        if (body.state === 'allowed' && body.token) {
          savePending(null);
          onapproved(body.token);
        } else if (body.state === 'pending') poll(p);
        else {
          savePending(null);
          phase = 'gone';
        }
      } catch {
        poll(p); // a moment offline: keep waiting
      }
    }, 2000);
  }

  onMount(() => void whoami());
  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });
</script>

<main class="signin" aria-labelledby="remote-signin-title">
  <h1 id="remote-signin-title">{RT.signIn.title}</h1>
  {#if withdrawn}<p class="note" role="status">{RT.signIn.withdrawn}</p>{/if}
  {#if phase === 'checking'}
    <p role="status" class="muted">{RT.signIn.checking}</p>
  {:else if phase === 'ready'}
    <p>{RT.signIn.intro(device)}</p>
    <button class="btn primary" onclick={ask} disabled={busy}>{RT.signIn.ask}</button>
  {:else if phase === 'waiting'}
    <p>{RT.signIn.codeLead}</p>
    <p class="code mono" aria-label="Code {code.split('').join(' ')}">{spacedCode(code)}</p>
    <p role="status" class="muted">{RT.signIn.waiting}</p>
  {:else if phase === 'gone'}
    <p role="status">{RT.signIn.notAllowed}</p>
    <button class="btn primary" onclick={ask} disabled={busy}>{RT.signIn.askAgain}</button>
  {:else if phase === 'refused'}
    <p role="status">{message}</p>
    <button class="btn" onclick={whoami}>{RT.signIn.askAgain}</button>
  {:else}
    <p role="status">{RT.signIn.offline}</p>
    <button class="btn" onclick={whoami}>{RT.signIn.askAgain}</button>
  {/if}
</main>

<style>
  .signin {
    max-width: 30rem;
    margin: 12vh auto 0;
    padding: 0 20px;
    text-align: center;
  }
  h1 {
    font-family: var(--serif);
    font-weight: 600;
    font-size: 26px;
    margin: 0 0 16px;
  }
  .note {
    padding: 10px 12px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--raised);
  }
  .code {
    font-size: 40px;
    letter-spacing: 0.08em;
    margin: 12px 0;
    color: var(--text);
  }
  @media (pointer: coarse) {
    .btn {
      min-height: 44px;
    }
  }
</style>
