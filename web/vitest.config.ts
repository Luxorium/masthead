import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Tests for the page: pure helpers, the store driven by fake server messages, and components rendered
// into happy-dom. The browser run (test/ui.e2e.mjs) covers the real page against a real server.
export default defineConfig({
  plugins: [svelte({ configFile: '../svelte.config.js', compilerOptions: { dev: true } })],
  root: 'web',
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
