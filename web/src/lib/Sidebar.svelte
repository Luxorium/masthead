<script lang="ts">
  import SettingsMenu from './SettingsMenu.svelte';
  import UsageMeter from './UsageMeter.svelte';
  import { store } from './store.svelte.ts';
  import { T } from './text.ts';

  /** onpick runs after a chat is chosen or started, so a drawer can close itself on narrow screens. */
  let { onhide, onpick }: { onhide: () => void; onpick?: () => void } = $props();
  let confirming = $state<string | null>(null);

  function remove(id: string) {
    if (confirming !== id) {
      confirming = id;
      setTimeout(() => {
        if (confirming === id) confirming = null;
      }, 3000);
      return;
    }
    confirming = null;
    store.send({ t: 'delete', convId: id });
  }

  function waiting(id: string): number {
    return store.waitingIn(id);
  }
</script>

<aside class="left">
  <div class="top">
    <span class="brand">{T.app.name}</span>
    <button class="btn ghost hide" onclick={onhide} title={T.shell.hideChats} aria-label={T.shell.hideChats}>⟨</button>
  </div>

  {#if store.mayAct}
  <button class="new" onclick={() => { store.newConversation(); onpick?.(); }}>
    <span class="plus">+</span> {T.shell.newChat}
  </button>
  {/if}

  <div class="label" id="chats-label">{T.shell.chats}</div>
  <nav aria-labelledby="chats-label">
    {#each store.conversations as c (c.id)}
      <div class="row" class:active={c.id === store.convId}>
        <button class="open" onclick={() => { store.open(c.id); onpick?.(); }} title={c.title}>
          {#if c.busy}<span class="dot running" role="img" aria-label={T.shell.working}></span>{/if}
          <span class="name">{c.title}</span>
          {#if waiting(c.id) > 0}<span class="needs" title={T.shell.needsAnswer} aria-label={T.shell.needsAnswer}>{waiting(c.id)}</span>{/if}
        </button>
        {#if store.mayAct}
        <button class="del" class:sure={confirming === c.id} onclick={() => remove(c.id)} title={T.shell.deleteChat} aria-label={T.shell.deleteChat}>
          {confirming === c.id ? T.shell.confirmDelete : '×'}
        </button>
        {/if}
      </div>
    {:else}
      <p class="empty">{T.shell.noChats}</p>
    {/each}
  </nav>

  {#if Object.keys(store.usage).length > 0}
    <!-- Only once Claude Code has reported usage: nothing to show before that. -->
    <UsageMeter />
  {/if}
  <div class="foot">
    {#if !store.connected && store.app}
      <span class="dot failed" aria-hidden="true"></span>
      <span class="muted">{T.shell.disconnected}</span>
    {/if}
    <span class="spacer"></span>
    <SettingsMenu />
  </div>
</aside>

<style>
  aside {
    display: flex;
    flex-direction: column;
    min-height: 0;
    width: 264px;
    background: var(--panel);
    border-right: 1px solid var(--border);
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 48px;
    padding: 0 8px 0 16px;
    flex: none;
  }
  .brand {
    font-family: var(--serif);
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
    padding-bottom: 1px;
    border-bottom: 3px double var(--text);
    line-height: 1.25;
  }
  .hide {
    padding: 2px 8px;
  }
  .new {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 8px 8px;
    padding: 7px 10px;
    border-radius: 8px;
    text-align: left;
    font-weight: 500;
  }
  .new:hover {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .plus {
    font-size: 18px;
    line-height: 1;
    color: var(--muted);
  }
  .label {
    padding: 10px 18px 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--faint);
  }
  nav {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 8px;
  }
  .row {
    display: flex;
    align-items: center;
    border-radius: 8px;
  }
  .row:hover,
  .row.active {
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
  .open {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    text-align: left;
    font-size: 14px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .needs {
    margin-left: auto;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--bg);
    font-size: 11px;
    font-weight: 600;
  }
  .del {
    flex: none;
    margin-right: 4px;
    padding: 0 7px;
    border-radius: 6px;
    color: var(--faint);
    font-size: 15px;
    line-height: 22px;
    /* Hidden by opacity, not visibility, so the keyboard can still reach it. */
    opacity: 0;
  }
  .row:hover .del,
  .row:focus-within .del,
  .del.sure {
    opacity: 1;
  }
  /* Touch screens have no hover: always show it, and make it big enough to tap. */
  @media (pointer: coarse) {
    .del {
      opacity: 1;
      min-width: 44px;
      min-height: 44px;
    }
    .open {
      min-height: 44px;
    }
  }
  .del:hover {
    color: var(--bad);
  }
  .del.sure {
    font-size: 12px;
    color: var(--bad);
    font-weight: 600;
  }
  .empty {
    padding: 4px 10px;
    color: var(--faint);
    font-size: 13.5px;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    padding: 6px 10px 8px 16px;
    border-top: 1px solid var(--border);
    font-size: 12.5px;
  }
  .spacer {
    flex: 1;
  }
</style>
