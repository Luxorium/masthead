// Runs the browser test (test/ui.e2e.mjs) against a fresh server on the fake backend, as CI does.
// Plain Node, no shell, so it runs the same on Linux, macOS and Windows. Needs a build (`npm run build`)
// and Playwright's Chromium (`npx playwright-core install chromium`). Never uses port 7717.
// Usage: node scripts/ci-e2e.mjs [screenshot folder]
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shots = resolve(process.argv[2] ?? join(tmpdir(), 'masthead-e2e-shots'));
mkdirSync(shots, { recursive: true });

// A fresh data folder every run: the test checks the empty first load.
const tmp = mkdtempSync(join(tmpdir(), 'masthead-e2e-'));
const data = join(tmp, 'data');
const config = join(tmp, 'config');
const work = join(tmp, 'work');
for (const d of [data, config, work]) mkdirSync(d, { recursive: true });
// Default permission mode, so the fake's approval request shows a card.
writeFileSync(
  join(config, 'settings.json'),
  JSON.stringify({ permissionMode: 'default', defaultCwd: work, tiers: { opus: { max: 3 }, sonnet: { max: 2 }, haiku: { max: 2 } } }),
);

/** A port the system says is free right now (never 7717). */
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => (port === 7717 ? freePort().then(res, rej) : res(port)));
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  MASTHEAD_BACKEND: 'fake',
  MASTHEAD_ALLOW_FAKE: '1',
  // Never the real tailscale (the fake backend implies it; said here too so it cannot be lost).
  MASTHEAD_TAILSCALE: 'off',
  MASTHEAD_DATA_DIR: data,
  MASTHEAD_CONFIG_DIR: config,
};
delete env.XDG_DATA_HOME;
delete env.XDG_CONFIG_HOME;

// Run a copy of the build, so a rebuild in the checkout meanwhile (`npm run build` empties dist/) cannot
// pull the files from under the running server. Its imports find the checkout's node_modules through a
// link next to the copy ('junction' on Windows needs no admin rights).
const app = join(tmp, 'app');
cpSync(join(root, 'dist'), join(app, 'dist'), { recursive: true });
cpSync(join(root, 'package.json'), join(app, 'package.json'));
symlinkSync(join(root, 'node_modules'), join(app, 'node_modules'), 'junction');
const server = spawn(process.execPath, [join(app, 'dist', 'server', 'main.js'), 'serve', '--port', String(port)], {
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});
let serverExited = false;
server.on('exit', (code) => {
  serverExited = true;
  if (code) console.error(`server exited with ${code}`);
});

async function healthy() {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
    return (await r.json()).name === 'masthead';
  } catch {
    return false;
  }
}

let code = 1;
try {
  const until = Date.now() + 30_000;
  while (!(await healthy())) {
    if (serverExited || Date.now() > until) throw new Error('the server did not start');
    await new Promise((r) => setTimeout(r, 250));
  }
  code = await new Promise((res) => {
    const t = spawn(process.execPath, [join(root, 'test', 'ui.e2e.mjs'), base, shots], {
      env: { ...env, MASTHEAD_E2E_BACKEND: 'fake' },
      stdio: 'inherit',
    });
    t.on('exit', (c) => res(c ?? 1));
    t.on('error', () => res(1));
  });
} catch (e) {
  console.error(e.message);
} finally {
  // Stop the server the way `masthead stop` does; kill it if that does not work.
  try {
    const key = readFileSync(join(data, 'secret'), 'utf8').trim();
    await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-masthead': '1', 'x-masthead-key': key }, signal: AbortSignal.timeout(3000) });
  } catch {
    // not running
  }
  // Wait for the server to end (kill it after 3 s), then remove the temporary folders.
  await new Promise((res) => {
    if (serverExited) return res();
    const t = setTimeout(() => {
      server.kill();
      res();
    }, 3000);
    server.once('exit', () => {
      clearTimeout(t);
      res();
    });
  });
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // a file still held open (Windows); the system's temp clean-up gets it later
  }
}
console.log(code === 0 ? 'browser test passed' : `browser test failed (${code}); screenshots in ${shots}`);
process.exitCode = code;
