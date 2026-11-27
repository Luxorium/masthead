<script lang="ts">
  import { onMount } from 'svelte';
  import Composer from './lib/Composer.svelte';
  import FirstRun from './lib/FirstRun.svelte';
  import PermissionCard from './lib/PermissionCard.svelte';
  import SettingsView from './lib/SettingsView.svelte';
  import DeviceRequestCard from './lib/remote/DeviceRequestCard.svelte';
  import RemoteSignIn from './lib/remote/RemoteSignIn.svelte';
  import type { RemoteState } from './lib/remote/types.ts';
  import Sidebar from './lib/Sidebar.svelte';
  import TeamMap from './lib/TeamMap.svelte';
  import TeamPanel from './lib/TeamPanel.svelte';
  import Transcript from './lib/Transcript.svelte';
  import { displayName } from '../../shared/protocol.ts';
  import { store } from './lib/store.svelte.ts';
  import { T, friendlyError } from './lib/text.ts';
  import { ui } from './lib/ui.svelte.ts';

  let renaming = $state(false);
  let titleDraft = $state('');

  onMount(() => {
    store.connect();
    const onHash = () => {
      // The sign-in address pasted into this tab changes only the fragment: take the key from it.
      store.keyFromAddress();
      const m = /^#\/c\/([A-Za-z0-9_-]+)$/.exec(location.hash);
      if (m && m[1] !== store.convId && store.conversations.some((c) => c.id === m[1])) store.open(m[1]!);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });

  $effect(() => {
    document.title = store.conv ? `${store.conv.title} · Masthead` : 'Masthead';
  });

  function startRename() {
    if (!store.conv) return;
    titleDraft = store.conv.title;
    renaming = true;
  }

  function finishRename(save: boolean) {
    // Escape ends renaming first; the blur that follows when the field goes away must not save.
    if (!renaming) return;
    if (save && store.conv && titleDraft.trim() && titleDraft.trim() !== store.conv.title) {
      store.send({ t: 'rename', convId: store.conv.id, title: titleDraft });
    }
    renaming = false;
  }

  /** Devices asking to be let in (local page only): their cards sit above the message box. */
  const remoteRequests = $derived(((store.remote as RemoteState | null)?.requests ?? []) as RemoteState['requests']);

  /** Helpers exist in the open chat: only then is there a team to show. */
  const hasTeam = $derived(store.agentList.some((a) => a.tier !== 'lead'));
  const showPanel = $derived(hasTeam && ui.teamOpen);

  // Advanced on a wide screen opens the team panel by itself when the first helper starts, unless the
  // person has opened or closed it. Simple leaves it closed: the Team button is enough.
  $effect(() => {
    if (hasTeam && ui.advanced && !ui.teamTouched && ui.wide) ui.teamOpen = true;
  });

  /** On narrow screens the chat list and the team panel are drawers over the chat. */
  const sidebarDrawer = $derived(ui.narrow && ui.sidebarOpen);
  const teamDrawer = $derived(showPanel && !ui.wide);
  const drawerOpen = $derived(sidebarDrawer || teamDrawer);
  const columns = $derived(
    [ui.sidebarOpen && !ui.narrow ? '264px' : '', 'minmax(0, 1fr)', showPanel && ui.wide ? '340px' : ''].filter(Boolean).join(' '),
  );

  function closeDrawers() {
    if (sidebarDrawer) ui.sidebarOpen = false;
    if (teamDrawer) ui.toggleTeam(false);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && drawerOpen && !document.querySelector('[role="dialog"]')) closeDrawers();
  }

  // A polite announcement for screen readers: a finished reply, or a card that needs an answer.
  let announce = $state('');
  let lastLeadStatus: string | undefined;
  let lastPending = 0;
  $effect(() => {
    const status = store.lead?.status;
    if (lastLeadStatus === 'running' && status && status !== 'running' && store.lead) announce = T.shell.replied(displayName(store.lead.name));
    lastLeadStatus = status;
  });
  $effect(() => {
    const n = store.convPending.length;
    if (n > lastPending) {
      const p = store.convPending[n - 1]!;
      announce = p.kind === 'question' ? T.card.question(displayName(p.agentName)) : T.card.permission(displayName(p.agentName));
    }
    lastPending = n;
  });

  const path = $derived(store.viewAgent && store.viewAgent.tier !== 'lead' ? store.pathTo(store.viewAgent.id) : []);
</script>

<svelte:window onkeydown={onKey} />

{#snippet code(text: string)}
  <!-- Backticks in a string from text.ts mark a command, shown in code style. -->
  {#each text.split('`') as part, i (i)}{#if i % 2}<code>{part}</code>{:else}{part}{/if}{/each}
{/snippet}

{#if store.signedOut === 'device' || store.signedOut === 'withdrawn'}
  <!-- A remote device without an approved token: golf's pairing screen (web/src/lib/remote). -->
  <RemoteSignIn withdrawn={store.signedOut === 'withdrawn'} onapproved={(token) => store.deviceApproved(token)} />
{:else if store.signedOut}
  <div class="signed-out">
    <div class="signed-out-box">
      <h1>Masthead</h1>
      <p>{@render code(T.signIn.open)}</p>
      {#if store.signedOut === 'refused'}
        <p class="muted small">{@render code(T.signIn.refused)}</p>
        <button class="btn primary" onclick={() => store.retryConnect()}>{T.signIn.tryAgain}</button>
      {/if}
    </div>
  </div>
{:else}
<a class="skip" href="#message">{T.shell.skip}</a>
<div class="sr-only" aria-live="polite">{announce}</div>
<div class="shell" class:narrow={ui.narrow} class:phone={ui.phone} class:team-col={showPanel && ui.wide} style:grid-template-columns={columns}>
  {#if ui.sidebarOpen}
    <Sidebar onhide={() => (ui.sidebarOpen = false)} onpick={() => {
      ui.settingsOpen = false;
      if (ui.narrow) ui.sidebarOpen = false;
    }} />
  {/if}

  <main inert={drawerOpen}>
    <header>
      {#if !ui.sidebarOpen || ui.narrow}
        <button class="btn ghost icon" onclick={() => (ui.sidebarOpen = true)} title={T.shell.showChats} aria-label={T.shell.showChats}>☰</button>
      {/if}
      <div class="title">
        {#if store.conv}
          {#if renaming}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="rename"
              bind:value={titleDraft}
              autofocus
              maxlength="120"
              onblur={() => finishRename(true)}
              onkeydown={(e) => {
                if (e.key === 'Enter') finishRename(true);
                else if (e.key === 'Escape') finishRename(false);
              }}
            />
          {:else}
            <button class="title-btn" onclick={startRename} title={T.shell.rename}>{store.conv.title}</button>
          {/if}
        {:else}
          <span class="title-text">{T.shell.newChatTitle}</span>
        {/if}
      </div>
      {#if store.conv && hasTeam}
        <button class="team-btn" class:on={showPanel} onclick={() => ui.toggleTeam()} aria-expanded={showPanel} title={T.shell.teamTitle}>
          {ui.phone ? T.shell.teamShort(store.liveCount) : T.shell.team(store.liveCount)}
        </button>
      {/if}
    </header>

    {#if !store.connected && store.app}
      <div class="banner" role="status">{T.shell.reconnecting}</div>
    {/if}
    {#if store.rateLimit}
      <div class="banner" class:bad={store.rateLimit.status === 'rejected'}>
        {store.rateLimit.status === 'rejected' ? T.banner.limitReached : T.banner.limitNear}
        {#if store.rateLimit.resetsAt}{T.banner.resets(new Date(store.rateLimit.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}{/if}
        <button class="btn ghost" onclick={() => store.dismissLimit()}>{T.banner.dismiss}</button>
      </div>
    {/if}

    {#if ui.settingsOpen}
      <SettingsView />
    {:else if store.app && !store.canRun}
      <FirstRun />
    {:else if store.view === 'map' && store.conv && hasTeam && !ui.narrow}
      <TeamMap />
      {#if store.convPending.length > 0}
        <div class="dock">
          <div class="column">
            {#each store.convPending as request (request.id)}
              <PermissionCard {request} />
            {/each}
          </div>
        </div>
      {/if}
    {:else}
      {#if path.length > 1}
        <nav class="crumbs" aria-label={T.shell.breadcrumb}>
          {#each path as a, i (a.id)}
            {#if i > 0}<span class="sep">/</span>{/if}
            <button class:current={i === path.length - 1} onclick={() => store.viewOf(a.id)}>{displayName(a.name)}{#if a.title && i === path.length - 1}<span class="crumb-title"> · {a.title}</span>{/if}</button>
          {/each}
          <button class="btn ghost back" onclick={() => store.lead && store.viewOf(store.lead.id)}>{T.shell.backTo(displayName(store.lead?.name ?? 'lead'))}</button>
        </nav>
      {/if}
      <Transcript />
      <div class="dock">
        <div class="column">
          {#each remoteRequests as request (request.id)}
            <DeviceRequestCard {request} />
          {/each}
          {#each store.convPending as request (request.id)}
            <PermissionCard {request} />
          {/each}
          {#key store.composerKey}
            <Composer />
          {/key}
        </div>
      </div>
    {/if}
  </main>

  {#if showPanel}
    <TeamPanel />
  {/if}

  {#if drawerOpen}
    <!-- Tapping outside a drawer closes it. -->
    <button class="backdrop" onclick={closeDrawers} aria-label={T.shell.closePanel} tabindex="-1"></button>
  {/if}

  {#if store.error}
    <div class="toast" role="alert">{friendlyError(store.error)}</div>
  {/if}
</div>
{/if}

<style>
  .signed-out {
    display: grid;
    place-items: center;
    height: 100%;
    padding: 24px;
  }
  .signed-out-box {
    max-width: 440px;
    text-align: center;
  }
  .signed-out-box h1 {
    margin: 0 0 12px;
    font-family: var(--serif);
    font-size: 28px;
    font-weight: 600;
  }
  .signed-out-box .small {
    font-size: 13px;
  }
  /* Columns come from the script: chat list, chat, and the team panel when there is room for it. */
  .shell {
    display: grid;
    height: 100%;
  }
  main {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 48px;
    flex: none;
    padding: 0 12px 0 16px;
    border-bottom: 1px solid var(--border);
  }
  .title {
    display: flex;
    align-items: baseline;
    gap: 12px;
    min-width: 0;
    flex: 1;
  }
  .title-btn,
  .title-text {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 60%;
    text-align: left;
  }
  .rename {
    flex: 1;
    max-width: 420px;
    padding: 3px 8px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--raised);
    font-weight: 600;
  }
  .team-btn {
    flex: none;
    padding: 4px 12px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    font-size: 13px;
    color: var(--muted);
  }
  @media (pointer: coarse) {
    .team-btn,
    .title-btn {
      min-height: 44px;
    }
  }
  .team-btn:hover,
  .team-btn.on {
    color: var(--text);
    border-color: var(--muted);
  }
  .icon {
    padding: 4px 8px;
    font-size: 16px;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    padding: 8px 16px;
    background: var(--accent-soft);
    border-bottom: 1px solid var(--border);
    font-size: 13.5px;
  }
  .banner.bad {
    color: var(--bad);
  }
  .banner .btn {
    margin-left: auto;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
    padding: 6px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--muted);
  }
  .crumbs button:not(.btn):hover {
    color: var(--text);
    text-decoration: underline;
  }
  .crumbs .current {
    color: var(--text);
    font-weight: 600;
  }
  .crumb-title {
    font-weight: 400;
    color: var(--muted);
  }
  .crumbs .sep {
    color: var(--faint);
  }
  .crumbs .back {
    margin-left: auto;
    padding: 2px 8px;
    font-size: 12.5px;
  }
  .dock {
    flex: none;
    padding: 0 20px 14px;
  }
  .column {
    max-width: 768px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: 96px;
    transform: translateX(-50%);
    max-width: min(560px, 90vw);
    padding: 10px 16px;
    border-radius: 10px;
    background: var(--text);
    color: var(--bg);
    font-size: 13.5px;
    box-shadow: var(--shadow);
    z-index: 30;
  }
  /* Drawers: the chat list on narrow screens, the team panel below 1280 px. */
  .shell.narrow :global(aside.left),
  .shell:not(.team-col) :global(aside.right) {
    position: fixed;
    top: 0;
    bottom: 0;
    z-index: 20;
    max-width: 88vw;
    box-shadow: var(--shadow);
  }
  .shell.narrow :global(aside.left) {
    left: 0;
  }
  .shell:not(.team-col) :global(aside.right) {
    right: 0;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 15;
    background: rgb(0 0 0 / 35%);
  }
  .shell.phone header {
    height: 56px;
    padding: 0 8px;
  }
  .shell.phone .dock {
    padding: 0 10px calc(10px + env(safe-area-inset-bottom));
  }
  .dock {
    padding-bottom: calc(14px + env(safe-area-inset-bottom));
  }
</style>
