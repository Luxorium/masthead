<script lang="ts">
  import { displayName, modelLabel, type ImageAttachment } from '../../../shared/protocol.ts';
  import FolderPicker from './FolderPicker.svelte';
  import { shortPath, store } from './store.svelte.ts';
  import { T } from './text.ts';
  import { ui } from './ui.svelte.ts';

  const MAX_IMAGES = 8;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  /** Base64 grows by a third; this keeps a full message well under the server's 48 MB socket limit. */
  const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
  const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  // The parent remounts this component (in a key block) when the conversation or agent changes, so
  // each keeps its own unsent text and images.
  const key = store.composerKey;
  const draft = store.composerFor(key);
  let area = $state<HTMLTextAreaElement | null>(null);
  let picker = $state<HTMLInputElement | null>(null);
  let choosingFolder = $state(false);
  let dragging = $state(false);

  const agent = $derived(store.viewAgent);
  const isNew = $derived(store.convId === null);
  const direct = $derived(!isNew && agent !== null && agent.tier !== 'lead');
  const leadBusy = $derived(store.lead?.status === 'running');
  const anyLive = $derived(store.liveCount > 0);
  const canSend = $derived((draft.text.trim().length > 0 || draft.images.length > 0) && store.connected && !store.creating && !!store.app?.claude.path);
  const leadName = $derived(displayName(store.lead?.name ?? 'alpha'));
  const placeholder = $derived(
    isNew
      ? T.composer.askAnything
      : direct
        ? T.composer.direct(displayName(agent?.name ?? ''), leadName)
        : leadBusy
          ? T.composer.addTo(leadName)
          : T.composer.reply(leadName),
  );
  /** The very first chat: say once what the folder means. */
  const firstChat = $derived(isNew && store.conversations.length === 0);

  function resize() {
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 260)}px`;
  }

  $effect(() => {
    void draft.text;
    resize();
  });

  // Typing anywhere starts in the box when a conversation or agent is opened (this mounts then).
  $effect(() => {
    area?.focus();
  });

  function submit() {
    if (!canSend) return;
    store.sendMessage(key);
  }

  const totalBytes = () => draft.images.reduce((n, img) => n + img.size, 0);

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  async function addFiles(files: Iterable<File>) {
    for (const file of files) {
      if (!TYPES.includes(file.type)) {
        store.fail(T.composer.notImage(file.name || T.composer.thatFile));
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        store.fail(T.composer.tooBig(file.name || T.composer.thatImage));
        continue;
      }
      if (draft.images.length >= MAX_IMAGES) {
        store.fail(T.composer.tooMany(MAX_IMAGES));
        break;
      }
      if (totalBytes() + file.size > MAX_TOTAL_BYTES) {
        store.fail(T.composer.tooMuch(file.name || T.composer.thatImage));
        continue;
      }
      let data: string;
      try {
        data = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(',')[1] ?? '');
          r.onerror = () => rej(r.error);
          r.readAsDataURL(file);
        });
      } catch {
        store.fail(T.composer.unreadable(file.name || T.composer.thatImage));
        continue;
      }
      // Checked again: another paste or drop may have added images while this one was read.
      if (draft.images.length >= MAX_IMAGES) {
        store.fail(T.composer.tooMany(MAX_IMAGES));
        break;
      }
      if (totalBytes() + file.size > MAX_TOTAL_BYTES) {
        store.fail(T.composer.tooMuch(file.name || T.composer.thatImage));
        continue;
      }
      draft.images.push({ mediaType: file.type as ImageAttachment['mediaType'], data, url: URL.createObjectURL(file), name: file.name || 'image', size: file.size });
    }
  }

  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
  }

  function removeImage(i: number) {
    const [gone] = draft.images.splice(i, 1);
    if (gone) URL.revokeObjectURL(gone.url);
  }
</script>

{#if direct && agent?.status === 'waiting' && agent.waitingFor}
  <p class="hint">{T.composer.waiting(displayName(agent.name), displayName(agent.waitingFor))}</p>
{/if}
{#if direct && agent}
  <!-- Says plainly who the box is pointed at, so nobody types to a sub-agent thinking it is the lead. -->
  <div class="addressee tier-{agent.tier}">
    <span class="to">{T.composer.to} <b>{displayName(agent.name)}</b> · {modelLabel(agent.model)}</span>
    {#if store.lead}
      <button class="back" onclick={() => store.lead && store.viewOf(store.lead.id)}>{T.shell.backTo(displayName(store.lead.name))}</button>
    {/if}
  </div>
{/if}
<div
  class="composer {direct && agent ? `direct tier-${agent.tier}` : ''}"
  class:dragging
  role="group"
  aria-label={direct && agent ? T.composer.labelTo(displayName(agent.name)) : T.composer.label}
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  {#if draft.images.length > 0}
    <div class="images">
      {#each draft.images as img, i (img.url)}
        <div class="thumb">
          <img src={img.url} alt={img.name} />
          <button onclick={() => removeImage(i)} aria-label={T.composer.removeImage}>×</button>
        </div>
      {/each}
    </div>
  {/if}
  <div class="row">
    <button class="round" onclick={() => picker?.click()} title={T.composer.attach} aria-label={T.composer.attach}>+</button>
    <input bind:this={picker} type="file" accept={TYPES.join(',')} multiple hidden onchange={(e) => {
      void addFiles(e.currentTarget.files ?? []);
      e.currentTarget.value = '';
    }} />
    <textarea id="message" bind:this={area} bind:value={draft.text} rows="1" {placeholder} onkeydown={onKey} onpaste={onPaste}></textarea>
    {#if leadBusy && !direct && !draft.text.trim() && draft.images.length === 0}
      <button class="round stop" onclick={() => store.convId && store.send({ t: 'interrupt', convId: store.convId })} title={T.composer.stopTitle} aria-label={T.composer.stop}>■</button>
    {:else}
      <button class="round send" disabled={!canSend} onclick={submit} title={T.composer.sendTitle} aria-label={T.composer.send}>↑</button>
    {/if}
  </div>
</div>

<div class="under">
  {#if isNew}
    <div class="folder">
      <button class="chip" onclick={() => (choosingFolder = !choosingFolder)} title={T.composer.folderTitle} aria-expanded={choosingFolder}>
        <span class="muted">{T.composer.folder}</span>
        <span class="mono">{shortPath(store.newCwd, store.app?.home)}</span>
      </button>
      {#if choosingFolder}
        <FolderPicker onclose={() => (choosingFolder = false)} />
      {/if}
    </div>
    {#if firstChat}<span class="first">{T.composer.folderFirst}</span>{/if}
  {:else}
    {#if store.conv}
      <span class="chip static" title="{T.composer.folderTitle}: {store.conv.cwd}">
        <span class="muted">{T.composer.folder}</span>
        <span class="mono">{shortPath(store.conv.cwd, store.app?.home)}</span>
      </span>
    {/if}
    {#if anyLive}
      <button class="chip danger" onclick={() => store.convId && store.send({ t: 'stop_all', convId: store.convId })}>{T.composer.stopAll}</button>
    {/if}
  {/if}
  <span class="spacer"></span>
  {#if store.settings && ui.advanced}
    <!-- Advanced only: which model answers, its thinking time and when it asks. -->
    <span class="meta">
      {#if direct && agent}
        <b>{modelLabel(agent.model)}</b> {T.effort[agent.effort]}
      {:else}
        <b>{modelLabel(store.settings.tiers.lead.model)}</b> {T.effort[store.lead?.effort ?? (store.settings.autoEffort ? 'low' : store.settings.tiers.lead.effort)]}
      {/if}
      <span class="sep">·</span>
      {T.settings.askShort[store.settings.permissionMode]}
    </span>
  {/if}
</div>

<style>
  .hint {
    margin: 0 6px 6px;
    font-size: 12.5px;
    color: var(--muted);
  }
  .composer {
    border: 1px solid var(--border-strong);
    border-radius: 16px;
    background: var(--raised);
    box-shadow: var(--shadow);
    transition: border-color 0.15s;
  }
  .composer:focus-within {
    border-color: var(--muted);
  }
  .composer.direct,
  .composer.direct:focus-within {
    border-color: var(--tier);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--tier) 35%, transparent), var(--shadow);
  }
  .addressee {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 6px 6px;
    font-size: 13px;
  }
  .to {
    color: var(--tier);
  }
  .to b {
    font-weight: 600;
  }
  .back {
    margin-left: auto;
    padding: 1px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 12.5px;
    color: var(--muted);
  }
  .back:hover {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .composer.dragging {
    border-color: var(--accent);
    border-style: dashed;
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 8px;
  }
  textarea {
    flex: 1;
    min-height: 32px;
    max-height: 260px;
    padding: 5px 4px;
    border: 0;
    outline: 0;
    resize: none;
    background: transparent;
    line-height: 1.5;
  }
  textarea::placeholder {
    color: var(--faint);
  }
  @media (pointer: coarse) {
    .round {
      width: 44px !important;
      height: 44px !important;
    }
    .thumb button {
      width: 32px !important;
      height: 32px !important;
    }
    .back,
    .chip {
      min-height: 44px;
    }
    textarea {
      min-height: 44px;
      padding-top: 10px;
    }
  }
  .round {
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    font-size: 17px;
    line-height: 1;
    color: var(--muted);
  }
  .round:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text) 8%, transparent);
    color: var(--text);
  }
  .round.send {
    background: var(--accent);
    color: #fff;
  }
  .round.send:hover:not(:disabled) {
    background: var(--accent);
    color: #fff;
    opacity: 0.88;
  }
  .round.stop {
    background: var(--text);
    color: var(--bg);
    font-size: 11px;
  }
  .images {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 10px 0;
  }
  .thumb {
    position: relative;
  }
  .thumb img {
    display: block;
    width: 64px;
    height: 64px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid var(--border);
  }
  .thumb button {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--text);
    color: var(--bg);
    font-size: 13px;
    line-height: 1;
  }
  .under {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 26px;
    padding: 0 6px;
    font-size: 12.5px;
    color: var(--muted);
  }
  .spacer {
    flex: 1;
  }
  .folder {
    position: relative;
    min-width: 0;
  }
  .chip {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    max-width: 100%;
    padding: 2px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 12.5px;
    white-space: nowrap;
  }
  .chip .mono {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .first {
    min-width: 0;
    font-size: 12px;
    color: var(--faint);
  }
  .meta {
    flex: none;
    white-space: nowrap;
  }
  .chip:hover:not(.static) {
    border-color: var(--border-strong);
  }
  .chip.static {
    min-width: 0;
    flex: 0 1 auto;
  }
  .chip.danger {
    color: var(--bad);
  }
  .meta b {
    font-weight: 600;
    color: var(--text);
  }
  .sep {
    margin: 0 3px;
    color: var(--faint);
  }
</style>
