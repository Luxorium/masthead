<script lang="ts">
  import { EFFORT_LABEL, displayName, modelLabel, type ImageAttachment } from '../../../shared/protocol.ts';
  import FolderPicker from './FolderPicker.svelte';
  import { shortPath, store } from './store.svelte.ts';

  const MAX_IMAGES = 8;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  let text = $state('');
  let images = $state<Array<ImageAttachment & { url: string; name: string }>>([]);
  let area = $state<HTMLTextAreaElement | null>(null);
  let picker = $state<HTMLInputElement | null>(null);
  let choosingFolder = $state(false);
  let dragging = $state(false);

  const agent = $derived(store.viewAgent);
  const isNew = $derived(store.convId === null);
  const direct = $derived(!isNew && agent !== null && agent.tier !== 'lead');
  const leadBusy = $derived(store.lead?.status === 'running');
  const anyLive = $derived(store.liveCount > 0);
  const canSend = $derived((text.trim().length > 0 || images.length > 0) && store.connected && !store.creating && !!store.app?.claude.path);
  const placeholder = $derived(
    isNew
      ? 'Ask for anything'
      : direct
        ? `Message ${displayName(agent?.name ?? '')} directly`
        : leadBusy
          ? `Add to what ${displayName(store.lead?.name ?? 'the lead')} is doing`
          : `Reply to ${displayName(store.lead?.name ?? 'the lead')}`,
  );
  const modeLabel: Record<string, string> = {
    inherit: 'Claude settings',
    default: 'Ask first',
    acceptEdits: 'Accept edits',
    auto: 'Auto',
    bypassPermissions: 'Bypass',
  };

  function resize() {
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 260)}px`;
  }

  $effect(() => {
    void text;
    resize();
  });

  // Typing anywhere starts in the box when a conversation or agent is opened.
  $effect(() => {
    void store.convId;
    void store.viewAgentId;
    area?.focus();
  });

  function submit() {
    if (!canSend) return;
    const ok = store.sendMessage(
      text.trim(),
      images.map(({ mediaType, data }) => ({ mediaType, data })),
    );
    if (!ok) return;
    text = '';
    for (const img of images) URL.revokeObjectURL(img.url);
    images = [];
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  async function addFiles(files: Iterable<File>) {
    for (const file of files) {
      if (!TYPES.includes(file.type)) {
        store.fail(`${file.name || 'That file'} is not a PNG, JPEG, GIF or WebP image. For other files, give the lead the path.`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        store.fail(`${file.name} is larger than 5 MB.`);
        continue;
      }
      if (images.length >= MAX_IMAGES) {
        store.fail(`At most ${MAX_IMAGES} images per message.`);
        break;
      }
      const data = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] ?? '');
        r.onerror = () => rej(r.error);
        r.readAsDataURL(file);
      });
      images.push({ mediaType: file.type as ImageAttachment['mediaType'], data, url: URL.createObjectURL(file), name: file.name || 'image' });
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
    const [gone] = images.splice(i, 1);
    if (gone) URL.revokeObjectURL(gone.url);
  }
</script>

<div
  class="composer"
  class:dragging
  role="group"
  aria-label="Message"
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  {#if images.length > 0}
    <div class="images">
      {#each images as img, i (img.url)}
        <div class="thumb">
          <img src={img.url} alt={img.name} />
          <button onclick={() => removeImage(i)} aria-label="Remove image">×</button>
        </div>
      {/each}
    </div>
  {/if}
  <div class="row">
    <button class="round" onclick={() => picker?.click()} title="Attach images" aria-label="Attach images">+</button>
    <input bind:this={picker} type="file" accept={TYPES.join(',')} multiple hidden onchange={(e) => {
      void addFiles(e.currentTarget.files ?? []);
      e.currentTarget.value = '';
    }} />
    <textarea bind:this={area} bind:value={text} rows="1" {placeholder} onkeydown={onKey} onpaste={onPaste}></textarea>
    {#if leadBusy && !direct && !text.trim() && images.length === 0}
      <button class="round stop" onclick={() => store.convId && store.send({ t: 'interrupt', convId: store.convId })} title="Stop this turn" aria-label="Stop this turn">■</button>
    {:else}
      <button class="round send" disabled={!canSend} onclick={submit} title="Send (Enter)" aria-label="Send">↑</button>
    {/if}
  </div>
</div>

<div class="under">
  {#if isNew}
    <div class="folder">
      <button class="chip" onclick={() => (choosingFolder = !choosingFolder)} title="Folder the agents work in">
        <span class="muted">Folder</span>
        <span class="mono">{shortPath(store.newCwd, store.app?.home)}</span>
      </button>
      {#if choosingFolder}
        <FolderPicker onclose={() => (choosingFolder = false)} />
      {/if}
    </div>
  {:else if anyLive}
    <button class="chip danger" onclick={() => store.convId && store.send({ t: 'stop_all', convId: store.convId })}>Stop everything</button>
  {/if}
  <span class="spacer"></span>
  {#if store.settings}
    <span class="meta">
      {#if direct && agent}
        <b>{modelLabel(agent.model)}</b> {EFFORT_LABEL[agent.effort]}
      {:else}
        <b>{modelLabel(store.settings.tiers.lead.model)}</b> {EFFORT_LABEL[store.lead?.effort ?? (store.settings.autoEffort ? 'low' : store.settings.tiers.lead.effort)]}{store.settings.autoEffort ? ' · auto' : ''}
      {/if}
      <span class="sep">·</span>
      {modeLabel[store.settings.permissionMode]}
    </span>
  {/if}
</div>

<style>
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
  .meta {
    flex: none;
    white-space: nowrap;
  }
  .chip:hover {
    border-color: var(--border-strong);
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
