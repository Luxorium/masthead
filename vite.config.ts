import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  root: 'web',
  plugins: [svelte({ configFile: '../svelte.config.js' })],
  build: { outDir: '../dist/web', emptyOutDir: true, target: 'es2022' },
  server: { port: 7718, proxy: { '/ws': { target: 'ws://127.0.0.1:7717', ws: true }, '/api': 'http://127.0.0.1:7717' } },
});
