import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/** A port from the environment, or `fallback`; anything but a whole number from 1024 to 65535 stops with a clear error. */
function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`Invalid ${name}: ${raw} (use a number from 1024 to 65535).`);
  return n;
}

// The page's port and the server it forwards to; set both to run beside an installed Masthead.
const webPort = envPort('MASTHEAD_DEV_WEB_PORT', 7718);
const serverPort = envPort('MASTHEAD_PORT', 7717);

export default defineConfig({
  root: 'web',
  plugins: [svelte({ configFile: '../svelte.config.js' })],
  build: { outDir: '../dist/web', emptyOutDir: true, target: 'es2022' },
  server: {
    port: webPort,
    strictPort: true,
    // Every path the server answers besides the page itself (server/transport/http.ts): the socket,
    // /api/* (health, proof, shutdown, remote request and whoami) and /blob (pictures).
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      '/api': `http://127.0.0.1:${serverPort}`,
      '/blob': `http://127.0.0.1:${serverPort}`,
    },
  },
});
