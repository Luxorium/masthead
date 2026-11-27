<script lang="ts">
  import { displayName, modelLabel, type ImageAttachment } from '../../../shared/protocol.ts';
  import FolderPicker from './FolderPicker.svelte';
  import { MAX_PICK_BYTES, MAX_UPLOAD_BYTES, shrinkIfLarge, toBase64, uploadImage } from './images.ts';
  import { shortPath, store } from './store.svelte.ts';
  import { T } from './text.ts';
  import { ui } from './ui.svelte.ts';

  const MAX_IMAGES = 8;
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
  /** Pictures still uploading, or that failed: sending waits for the first and needs the second removed. */
  const imagesBusy = $derived(draft.images.some((i) => i.uploading || i.error));
  const canSend = $derived((draft.text.trim().length > 0 || draft.images.length > 0) && !imagesBusy && store.connected && !store.creating && store.canRun);
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
      const name = file.name || T.composer.thatImage;
      if (!TYPES.includes(file.type)) {
        store.fail(T.composer.notImage(file.name || T.composer.thatFile));
        continue;
      }
      if (file.size > MAX_PICK_BYTES) {
        store.fail(T.composer.tooBigToShrink(name));
        continue;
      }
      if (draft.images.length >= MAX_IMAGES) {
        store.fail(T.composer.tooMany(MAX_IMAGES));
        break;
      }
      // Large photos are made smaller here first; the server takes at most 5 MB per picture.
      let shrunk: Awaited<ReturnType<typeof shrinkIfLarge>>;
      try {
        shrunk = await shrinkIfLarge(file);
      } catch {
        store.fail(T.composer.unreadable(name));
        continue;
      }
      if (shrunk.blob.size > MAX_UPLOAD_BYTES) {
        store.fail(T.composer.tooBig(name));
        continue;
      }
      // Checked again: another paste or drop may have added images while this one was prepared.
      if (draft.images.length >= MAX_IMAGES) {
        store.fail(T.composer.tooMany(MAX_IMAGES));
        break;
      }
      const convId = store.convId;
      if (!convId && totalBytes() + shrunk.blob.size > MAX_TOTAL_BYTES) {
        store.fail(T.composer.tooMuch(name));
        continue;
      }
      const base = { mediaType: shrunk.mediaType, data: '', url: URL.createObjectURL(shrunk.blob), name, size: shrunk.blob.size };
      if (convId) {
        // An existing chat: upload now, so sending is instant and carries only references.
        draft.images.push({ ...base, uploading: true });
        const entry = draft.images[draft.images.length - 1]!;
        uploadImage(convId, shrunk.blob, shrunk.mediaType).then(
          (ref) => {
            entry.ref = ref;
            entry.uploading = false;
          },
          (e: Error) => {
            entry.uploading = false;
            entry.error = e.message;
          },
        );
      } else {
        // A new chat has no conversation to upload into yet: the first message carries the picture.
        try {
          draft.images.push({ ...base, data: await toBase64(shrunk.blob) });
        } catch {
          URL.revokeObjectURL(base.url);
          store.fail(T.composer.unreadable(name));
        }
      }
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
        <div class="thumb" class:busy={img.uploading} class:bad={!!img.error} title={img.error ?? ''}>
          <img src={img.url} alt={img.name} />
          {#if img.uploading}<span class="state">{T.images.uploading}</span>{:else if img.error}<span class="state">{T.images.failed}</span>{/if}
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
  .thumb.busy img {
    opacity: 0.5;
  }
  .thumb.bad img {
    outline: 2px solid var(--bad);
  }
  .thumb .state {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 1px 3px;
    font-size: 10.5px;
    text-align: center;
    background: color-mix(in srgb, var(--raised) 85%, transparent);
    color: var(--text);
    border-radius: 0 0 8px 8px;
  }
  .thumb.bad .state {
    color: var(--bad);
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
