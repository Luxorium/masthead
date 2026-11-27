<script lang="ts" module>
  // When the person last pressed a key anywhere, so a new card does not take focus mid-typing.
  let lastKey = 0;
  if (typeof window !== 'undefined') window.addEventListener('keydown', () => (lastKey = Date.now()), true);
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { displayName, type PermissionRequest } from '../../../shared/protocol.ts';
  import { store } from './store.svelte.ts';
  import { toolLine } from './tools.ts';

  let { request }: { request: PermissionRequest } = $props();

  // For questions: the options ticked per question, and any free-text answer.
  let picked = $state<Record<number, string[]>>({});
  let other = $state<Record<number, string>>({});
  let showDetail = $state(false);
  let card = $state<HTMLDivElement | null>(null);

  // The card takes focus when it appears so the keyboard can reach it, unless the person is typing:
  // a key pressed in the last 1.5 s, text in the field they are in, or focus already on another card.
  // Focus goes to the card itself, not to Allow, so a stray Enter answers nothing.
  onMount(() => {
    const active = document.activeElement as HTMLElement | null;
    const typing = Date.now() - lastKey < 1500;
    const field = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active.value.trim().length > 0 : !!active?.isContentEditable;
    const onCard = !!active?.closest('.card[role="alertdialog"]');
    if (!typing && !field && !onCard) card?.focus({ preventScroll: true });
  });

  const line = $derived(toolLine(request.toolName, request.input));
  const WANTS: Record<string, string> = {
    Bash: 'wants to run a command',
    Write: 'wants to write a file',
    Edit: 'wants to edit a file',
    NotebookEdit: 'wants to edit a notebook',
    Read: 'wants to read a file',
    WebFetch: 'wants to fetch a web page',
    WebSearch: 'wants to search the web',
  };
  const wants = $derived(WANTS[request.toolName] ?? `wants to use ${request.toolName.replace(/^mcp__/, '').replace(/__/g, ' · ')}`);
  const detail = $derived.by(() => {
    const i = (request.input ?? {}) as Record<string, unknown>;
    if (typeof i.command === 'string') return i.command;
    try {
      return JSON.stringify(request.input, null, 2);
    } catch {
      return String(request.input);
    }
  });
  const isCommand = $derived(typeof (request.input as Record<string, unknown> | null)?.command === 'string');

  function toggle(qi: number, label: string, multi: boolean) {
    const now = picked[qi] ?? [];
    if (multi) picked[qi] = now.includes(label) ? now.filter((l) => l !== label) : [...now, label];
    else picked[qi] = [label];
    if (!multi) other[qi] = '';
  }

  const complete = $derived((request.questions ?? []).every((_, qi) => (picked[qi]?.length ?? 0) > 0 || (other[qi] ?? '').trim().length > 0));

  function submitAnswers() {
    const answers: Record<string, string> = {};
    (request.questions ?? []).forEach((q, qi) => {
      const parts = [...(picked[qi] ?? [])];
      const free = (other[qi] ?? '').trim();
      if (free) parts.push(free);
      answers[q.question] = parts.join(', ');
    });
    store.answer(request.id, 'allow', answers);
  }
</script>

<div
  bind:this={card}
  class="card"
  role="alertdialog"
  tabindex="-1"
  aria-label={request.kind === 'question' ? `Question from ${displayName(request.agentName)}` : `Permission request from ${displayName(request.agentName)}`}
>
  {#if request.kind === 'question'}
    <div class="head"><span class="who">{displayName(request.agentName)}</span> <span class="what">asks</span></div>
    {#each request.questions ?? [] as q, qi (qi)}
      <fieldset>
        <legend>{q.question}</legend>
        <div class="options">
          {#each Array.isArray(q.options) ? q.options : [] as opt, oi (oi)}
            <button class="option" class:on={picked[qi]?.includes(opt.label)} onclick={() => toggle(qi, opt.label, !!q.multiSelect)} aria-pressed={!!picked[qi]?.includes(opt.label)}>
              <span class="opt-label">{opt.label}</span>
              {#if opt.description}<span class="opt-desc">{opt.description}</span>{/if}
            </button>
          {/each}
        </div>
        <input class="other" placeholder="Something else…" bind:value={other[qi]} oninput={() => !q.multiSelect && (picked[qi] = [])} />
      </fieldset>
    {/each}
    <div class="actions">
      <button class="btn ghost" onclick={() => store.answer(request.id, 'deny')}>Skip</button>
      <button class="btn primary" disabled={!complete} onclick={submitAnswers}>Answer</button>
    </div>
  {:else}
    <div class="head">
      <span class="who">{displayName(request.agentName)}</span>
      <span class="what">{request.title ?? wants}</span>
    </div>
    {#if isCommand}
      <pre class="detail">{detail}</pre>
    {:else}
      {#if line.target && !request.title}<div class="target mono">{line.target}</div>{/if}
      <button class="more" onclick={() => (showDetail = !showDetail)}>{showDetail ? 'Hide details' : 'Show details'}</button>
      {#if showDetail}<pre class="detail">{detail}</pre>{/if}
    {/if}
    {#if request.description}<p class="desc">{request.description}</p>{/if}
    <div class="actions">
      <button class="btn danger" onclick={() => store.answer(request.id, 'deny')}>Deny</button>
      {#if request.canAlways}
        <button class="btn" onclick={() => store.answer(request.id, 'always')} title="Allow, and stop asking for this in this session">Always allow</button>
      {/if}
      <button class="btn primary" onclick={() => store.answer(request.id, 'allow')}>Allow</button>
    </div>
  {/if}
</div>

<style>
  .card {
    padding: 12px 14px;
    border: 1px solid var(--accent);
    border-radius: 12px;
    background: var(--raised);
    box-shadow: var(--shadow);
  }
  .card:focus {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .card > .head + fieldset {
    margin-top: 8px;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 14px;
  }
  .who {
    font-weight: 600;
  }
  .target {
    margin-top: 4px;
    overflow-wrap: anywhere;
  }
  .detail {
    margin: 8px 0 0;
    padding: 8px 10px;
    max-height: 200px;
    overflow: auto;
    border-radius: 8px;
    background: var(--code-bg);
    color: #e3e7ee;
    font: 12.5px/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .more {
    margin-top: 4px;
    font-size: 12.5px;
    color: var(--muted);
    text-decoration: underline;
  }
  .desc {
    margin: 8px 0 0;
    font-size: 13px;
    color: var(--muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  fieldset {
    margin: 0 0 12px;
    padding: 0;
    border: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 8px;
    font-weight: 600;
  }
  .options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 6px;
  }
  .option {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    text-align: left;
  }
  .option:hover {
    border-color: var(--muted);
  }
  .option.on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .opt-label {
    font-size: 14px;
    font-weight: 500;
  }
  .opt-desc {
    font-size: 12.5px;
    color: var(--muted);
  }
  .other {
    width: 100%;
    margin-top: 6px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    font-size: 13.5px;
  }
</style>
