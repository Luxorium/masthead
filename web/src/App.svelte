<script lang="ts">
  import { onMount } from 'svelte';
  import Composer from './lib/Composer.svelte';
  import PermissionCard from './lib/PermissionCard.svelte';
  import SettingsMenu from './lib/SettingsMenu.svelte';
  import Sidebar from './lib/Sidebar.svelte';
  import TeamMap from './lib/TeamMap.svelte';
  import TeamPanel from './lib/TeamPanel.svelte';
  import Transcript from './lib/Transcript.svelte';
  import { displayName } from '../../shared/protocol.ts';
  import { shortPath, store } from './lib/store.svelte.ts';

  let showSidebar = $state(true);
  let showPanel = $state(true);
  let renaming = $state(false);
  let titleDraft = $state('');

  onMount(() => {
    store.connect();
    const onHash = () => {
      const m = /^#\/c\/([A-Za-z0-9_-]+)$/.exec(location.hash);
      if (m && m[1] !== store.convId && store.conversations.some((c) => c.id === m[1])) store.open(m[1]!);
    };
    window.addEventListener('hashchange', onHash);
    if (window.innerWidth < 1100) showPanel = false;
    if (window.innerWidth < 760) showSidebar = false;
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

  const path = $derived(store.viewAgent && store.viewAgent.tier !== 'lead' ? store.pathTo(store.viewAgent.id) : []);
</script>

{#if store.signedOut}
  <div class="signed-out">
    <div class="signed-out-box">
      <h1>Masthead</h1>
      <p>Open Masthead with the <code>masthead</code> command (or its launcher entry) to sign this browser in.</p>
      {#if store.signedOut === 'refused'}
        <p class="muted small">Masthead refused this browser's key, or is not running. A key from an earlier start no longer works.</p>
        <button class="btn primary" onclick={() => store.retryConnect()}>Try again</button>
      {/if}
    </div>
  </div>
{:else}
<div class="shell" class:no-sidebar={!showSidebar} class:no-panel={!showPanel}>
  {#if showSidebar}
    <Sidebar onhide={() => (showSidebar = false)} />
  {/if}

  <main>
    <header>
      {#if !showSidebar}
        <button class="btn ghost icon" onclick={() => (showSidebar = true)} title="Show conversations" aria-label="Show conversations">☰</button>
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
            <button class="title-btn" onclick={startRename} title="Rename">{store.conv.title}</button>
          {/if}
          <span class="cwd mono" title={store.conv.cwd}>{shortPath(store.conv.cwd, store.app?.home)}</span>
        {:else}
          <span class="title-text">New conversation</span>
        {/if}
      </div>
      {#if store.conv}
        <div class="seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={store.view === 'chat'} class:on={store.view === 'chat'} onclick={() => (store.view = 'chat')}>Chat</button>
          <button role="tab" aria-selected={store.view === 'map'} class:on={store.view === 'map'} onclick={() => (store.view = 'map')}>
            Team map{#if store.liveCount > 0}<span class="count">{store.liveCount}</span>{/if}
          </button>
        </div>
      {/if}
      <SettingsMenu />
      <button class="btn ghost icon" onclick={() => (showPanel = !showPanel)} title={showPanel ? 'Hide team panel' : 'Show team panel'} aria-label="Toggle team panel">◧</button>
    </header>

    {#if store.app?.claude.error}
      <div class="banner bad">{store.app.claude.error}</div>
    {/if}
    {#if !store.connected && store.app}
      <div class="banner">Lost the connection to Masthead. Reconnecting…</div>
    {/if}
    {#if store.rateLimit}
      <div class="banner" class:bad={store.rateLimit.status === 'rejected'}>
        {store.rateLimit.status === 'rejected' ? 'Your Claude usage limit has been reached.' : 'You are close to your Claude usage limit.'}
        {#if store.rateLimit.resetsAt}Resets {new Date(store.rateLimit.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.{/if}
        <button class="btn ghost" onclick={() => (store.rateLimit = null)}>Dismiss</button>
      </div>
    {/if}

    {#if store.view === 'map' && store.conv}
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
        <nav class="crumbs" aria-label="Agent">
          {#each path as a, i (a.id)}
            {#if i > 0}<span class="sep">/</span>{/if}
            <button class:current={i === path.length - 1} onclick={() => store.viewOf(a.id)}>{displayName(a.name)}{#if a.title && i === path.length - 1}<span class="crumb-title"> · {a.title}</span>{/if}</button>
          {/each}
          <button class="btn ghost back" onclick={() => store.lead && store.viewOf(store.lead.id)}>Back to {displayName(store.lead?.name ?? 'lead')}</button>
        </nav>
      {/if}
      <Transcript />
      <div class="dock">
        <div class="column">
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

  {#if store.error}
    <div class="toast" role="alert">{store.error}</div>
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
  .shell {
    display: grid;
    grid-template-columns: 264px minmax(0, 1fr) 316px;
    height: 100%;
  }
  .shell.no-sidebar {
    grid-template-columns: minmax(0, 1fr) 316px;
  }
  .shell.no-panel {
    grid-template-columns: 264px minmax(0, 1fr);
  }
  .shell.no-sidebar.no-panel {
    grid-template-columns: minmax(0, 1fr);
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
  .cwd {
    color: var(--faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .icon {
    padding: 4px 8px;
    font-size: 16px;
  }
  .seg {
    display: flex;
    padding: 2px;
    border-radius: 8px;
    background: var(--panel);
    border: 1px solid var(--border);
  }
  .seg button {
    padding: 3px 12px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--muted);
  }
  .seg button.on {
    background: var(--raised);
    color: var(--text);
    box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
  }
  .count {
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--bg);
    font-size: 11px;
    font-weight: 600;
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
  @media (max-width: 900px) {
    .shell,
    .shell.no-sidebar,
    .shell.no-panel {
      grid-template-columns: minmax(0, 1fr);
    }
    .shell :global(aside) {
      position: fixed;
      top: 0;
      bottom: 0;
      z-index: 20;
      box-shadow: var(--shadow);
    }
    .shell :global(aside.right) {
      right: 0;
    }
  }
</style>
