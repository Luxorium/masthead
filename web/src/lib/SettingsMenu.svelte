<script lang="ts">
  // The ⚙ button at the foot of the chat list: opens the settings view (SettingsView.svelte).
  import { T } from './text.ts';
  import { ui } from './ui.svelte.ts';
</script>

<button
  id="settings-gear"
  class="btn ghost icon"
  onclick={() => (ui.settingsOpen ? ui.closeSettings() : ui.openSettings())}
  title={T.settings.title}
  aria-label={T.settings.title}
  aria-expanded={ui.settingsOpen}>⚙</button
>

<style>
  .icon {
    padding: 4px 8px;
    font-size: 16px;
  }
</style>
