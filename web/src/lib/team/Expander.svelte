<script lang="ts">
  // The small − / + box used by the team outline and the Archived helpers row. Drawn with 1 px bars, not
  // a text character, so font metrics cannot move it: 13 px square, so its middle is a whole pixel.
  let { open }: { open: boolean } = $props();
</script>

<span class="expander" aria-hidden="true"><i class="h"></i>{#if !open}<i class="v"></i>{/if}</span>

<style>
  .expander {
    position: relative;
    display: block;
    flex: none;
    box-sizing: border-box;
    width: 13px;
    height: 13px;
    border: 1px solid var(--guide, var(--border-strong));
    border-radius: 3px;
    background: var(--bg);
    color: var(--muted);
  }
  /* Inside the border the box is 11 px: the bars cross on pixel 5, the middle one. */
  i {
    position: absolute;
    background: currentColor;
  }
  .h {
    left: 2px;
    top: 5px;
    width: 7px;
    height: 1px;
  }
  .v {
    left: 5px;
    top: 2px;
    width: 1px;
    height: 7px;
  }
</style>
