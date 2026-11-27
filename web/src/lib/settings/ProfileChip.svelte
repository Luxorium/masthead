<script lang="ts">
  // The new-chat team picker: "Team: Claude" opens a small menu of the teams that can start now.
  // Mounted by the composer when more than one usable team exists, or when the only one is not the default.
  import { store } from '../store.svelte.ts';
  import { usableProfiles } from './logic.ts';
  import { ST } from './text.ts';
  import { readBackends } from './types.ts';

  let { value, onchange }: { value: string; onchange: (id: string) => void } = $props();

  const teams = $derived(usableProfiles(store.settings?.profiles ?? [], readBackends(store.backends)));
  const current = $derived(teams.find((p) => p.id === value) ?? teams[0]);
  // When the asked-for team cannot start now (e.g. the default team's program is not ready), the chip
  // shows the first one that can; pick it too, so the new chat starts with the team the chip names.
  $effect(() => {
    if (current && current.id !== value) onchange(current.id);
  });
  let open = $state(false);
  let button: HTMLButtonElement | undefined = $state();
  let menu: HTMLUListElement | undefined = $state();
  const menuId = `team-menu-${Math.random().toString(36).slice(2, 8)}`;

  function toggle(): void {
    open = !open;
    if (open) queueMicrotask(() => (menu?.querySelector('[aria-checked="true"]') as HTMLElement | null ?? menu?.querySelector('[role="menuitemradio"]') as HTMLElement | null)?.focus());
  }

  function close(focusButton = true): void {
    open = false;
    if (focusButton) button?.focus();
  }

  function pick(id: string): void {
    onchange(id);
    close();
  }

  function keys(e: KeyboardEvent): void {
    const items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') close(false);
  }
</script>

{#if current}
  <div class="chip-wrap">
    <button
      bind:this={button}
      type="button"
      class="chip"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={menuId}
      onclick={toggle}
    >
      {ST.chip.label(current.label)}
    </button>
    {#if open}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <ul bind:this={menu} id={menuId} class="menu" role="menu" aria-label={ST.chip.menu} tabindex="-1" onkeydown={keys}>
        {#each teams as p (p.id)}
          <li role="none">
            <button type="button" role="menuitemradio" aria-checked={p.id === current.id} class="item" onclick={() => pick(p.id)}>
              <span class="label">{p.label}</span>
              <span class="levels" aria-hidden="true">
                {#each p.tiers as t (t.id)}<span class="dot pal-{t.colour}"></span>{/each}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .chip-wrap {
    position: relative;
    display: inline-block;
  }
  .chip {
    font: inherit;
    font-size: 12px;
    color: var(--muted);
    background: var(--raised);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 10px;
    cursor: pointer;
  }
  .chip:hover,
  .chip:focus-visible {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .menu {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    z-index: 20;
    min-width: 180px;
    max-width: min(320px, 90vw);
    margin: 0;
    padding: 4px;
    list-style: none;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .item {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font: inherit;
    font-size: 13px;
    color: var(--text);
    background: none;
    border: 0;
    border-radius: calc(var(--radius) - 2px);
    padding: 6px 8px;
    text-align: left;
    cursor: pointer;
  }
  .item:hover,
  .item:focus-visible {
    background: var(--accent-soft);
  }
  .item[aria-checked='true'] .label {
    font-weight: 600;
  }
  .levels {
    display: inline-flex;
    gap: 3px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tier);
  }
  @media (pointer: coarse) {
    .chip,
    .item {
      min-height: 44px;
      font-size: 16px;
    }
  }
</style>
