<script lang="ts">
  // The team: one outline of every agent (team/TeamOutline.svelte), which scrolls only up and down.
  // Shown once the main assistant has started a helper. Below it the memory line, and in Advanced the
  // levels (helpers at a time, thinking time).
  import TeamOutline from './team/TeamOutline.svelte';
  import CompactProgress from './team/CompactProgress.svelte';
  import TierControls from './team/TierControls.svelte';
  import { fmtTokens, store } from './store.svelte.ts';
  import { T } from './text.ts';
  import { ui } from './ui.svelte.ts';
  import { profileById } from './tiers.ts';

  const lead = $derived(store.lead);
  const chatTeam = $derived(store.conv ? profileById(store.settings, store.conv.profileId ?? store.settings?.defaultProfile) : undefined);
  const pct = $derived(lead && lead.usage.contextMax > 0 ? Math.min(100, Math.round((lead.usage.context / lead.usage.contextMax) * 100)) : 0);
  const totalOut = $derived(store.agentList.reduce((n, a) => n + a.usage.output, 0));

  /** Dragging the left edge: the column grows as the pointer moves left. */
  function startDrag(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = ui.teamWidth;
    const move = (ev: PointerEvent) => ui.setTeamWidth(startW + (startX - ev.clientX));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }
</script>

<aside class="right" class:column={ui.wide} aria-label={T.team.title}>
  {#if ui.wide}
    <!-- Drag (or arrow keys) to make the column wider or narrower; remembered on this device. A
         focusable separator with a value is the ARIA pattern for a splitter, which Svelte's check
         does not know. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={T.team.resize}
      aria-valuenow={ui.teamWidth}
      aria-valuemin={300}
      aria-valuemax={560}
      tabindex="0"
      onpointerdown={startDrag}
      onkeydown={(e) => {
        if (e.key === 'ArrowLeft') ui.setTeamWidth(ui.teamWidth + 20);
        else if (e.key === 'ArrowRight') ui.setTeamWidth(ui.teamWidth - 20);
        else return;
        e.preventDefault();
      }}
    ></div>
  {/if}
  <div class="head">
    <h2>{T.team.title}</h2>
    <button class="btn ghost close" onclick={() => ui.toggleTeam(false)} aria-label={T.team.close} title={T.team.close}>×</button>
  </div>

  {#if lead}
    <section class="grow">
      <CompactProgress />
      {#if chatTeam && (store.settings?.profiles.length ?? 0) > 1}
        <!-- Simple too: which team this chat uses (its levels are only editable in Advanced). -->
        <p class="small muted chat-team">{T.team.usesTeam(chatTeam.label)}</p>
      {/if}
      <TeamOutline />
      {#if store.conv && store.mayAct}
        <!-- Per chat: the person may switch automatic tidying off here only (the setting covers all chats). -->
        <label class="small chat-tidy">
          <input type="checkbox" checked={store.conv.autoCompact !== false && store.settings?.autoCompact !== false} disabled={store.settings?.autoCompact === false} onchange={(e) => store.request({ t: 'auto_compact', convId: store.conv!.id, on: e.currentTarget.checked })} />
          <span>{T.compact.chatSetting}</span>
        </label>
      {/if}
      <p class="small muted memory" title={T.team.memoryDetail(fmtTokens(lead.usage.context), fmtTokens(lead.usage.contextMax), fmtTokens(totalOut))}>
        {T.team.memory(pct)}{#if ui.advanced} · {T.team.memoryDetail(fmtTokens(lead.usage.context), fmtTokens(lead.usage.contextMax), fmtTokens(totalOut))}{/if}
      </p>
    </section>
  {/if}

  {#if ui.advanced && store.mayAct}
    <TierControls />
  {/if}
</aside>

<style>
  aside {
    position: relative;
    display: flex;
    flex-direction: column;
    /* A drawer on narrower screens; a column (sized by the grid in App.svelte) on wide ones. */
    width: min(400px, 88vw);
    min-height: 0;
    overflow-y: auto;
    border-left: 1px solid var(--border);
    background: var(--bg);
  }
  aside.column {
    width: auto;
  }
  .resize {
    position: absolute;
    left: -3px;
    top: 0;
    bottom: 0;
    z-index: 2;
    width: 7px;
    cursor: col-resize;
  }
  .resize:hover,
  .resize:focus-visible {
    background: color-mix(in srgb, var(--accent) 35%, transparent);
    outline: none;
  }
  section {
    padding: 10px 8px 14px;
    border-bottom: 1px solid var(--border);
  }
  section.grow {
    flex: 1;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    /* A whole-pixel height (32 + 2 × 10 + 1) that never shrinks, so the outline below starts on a whole pixel. */
    flex: none;
    box-sizing: border-box;
    height: 53px;
    padding: 10px 10px 10px 16px;
    border-bottom: 1px solid var(--border);
  }
  .head h2 {
    flex: 1;
  }
  .close {
    min-width: 32px;
    padding: 2px 8px;
    font-size: 16px;
  }
  .chat-team {
    margin: 6px 12px 0;
  }
  .chat-tidy {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 10px 8px 0;
    color: var(--muted);
  }
  .chat-tidy input {
    accent-color: var(--accent);
  }
  @media (pointer: coarse) {
    .chat-tidy {
      min-height: 44px;
    }
    /* Holds the 44 px close button. */
    .head {
      height: 65px;
    }
  }
  .memory {
    margin-top: 12px;
    padding-left: 8px;
  }
  h2 {
    display: flex;
    align-items: center;
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .small {
    margin: 6px 0 0;
    font-size: 12.5px;
  }
</style>
