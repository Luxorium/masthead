#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../shared/protocol.js';
import { App } from './app.js';
import { UsageError, openSignedIn, parseCommand, parseDevWebPort, parsePort, serverProves, signInDir, signInUrl, unitPortFrom, type Opener } from './cli.js';
import { DATA_DIR, DEFAULT_PORT, SECRET_FILE, loadSecret, readSecret } from './config.js';
import { serve } from './http.js';

// Masthead approves its own tools ahead of the permission callback on purpose; the SDK's notice about that is noise here.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const first = rest[0] as { code?: string } | string | undefined;
  const code = typeof first === 'object' && first ? first.code : rest[1];
  if (code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') return;
  (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');

function port(): number {
  try {
    return parsePort(process.argv.slice(2), process.env);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(e.message);
    process.exit(2);
  }
}

const url = (p: number) => `http://127.0.0.1:${p}`;

async function health(p: number): Promise<{ version: string; pid: number } | null> {
  try {
    const res = await fetch(`${url(p)}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { name?: string; version: string; pid: number };
    return body.name === 'masthead' ? body : null;
  } catch {
    return null;
  }
}

/** What to say when the server on `p` did not prove it knows this data folder's secret. It was never sent the secret. */
function notOurs(p: number): string {
  return `Another Masthead (or another program) is using port ${p}: it did not prove it knows ${SECRET_FILE}, so it was not sent the key. If it is a Masthead started with another XDG_DATA_HOME, use that one; if it is an older Masthead, restart it; otherwise use another port.`;
}

/** Whether the installed user service is the one that serves port `p`. Any other port is a server of its own. */
function unitServes(p: number): boolean {
  const r = spawnSync('systemctl', ['--user', 'show', '-p', 'LoadState', '-p', 'Environment', 'masthead.service'], { encoding: 'utf8' });
  return r.status === 0 && unitPortFrom(r.stdout ?? '') === p;
}

/** The real opener: xdg-open or gio, found with `command -v`. */
const systemOpener: Opener = {
  has: (cmd) => spawnSync('sh', ['-c', 'command -v "$1"', 'sh', cmd], { stdio: 'ignore' }).status === 0,
  run: (cmd, args) =>
    new Promise((resolve) => {
      // Detached and unreferenced: an opener that runs the browser in the foreground must not keep `masthead` waiting.
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.unref();
      child.on('error', () => resolve(null));
      child.on('exit', (code) => resolve(code));
    }),
  detach: (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(),
  log: (line) => console.log(line),
};

function secretOrExit(): string {
  try {
    return loadSecret();
  } catch (e) {
    console.error(`Could not read or create ${SECRET_FILE}: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function runServer(): Promise<void> {
  const p = port();
  const app = new App();
  const dev = process.env.MASTHEAD_DEV === '1';
  let devWeb = 7718;
  try {
    devWeb = parseDevWebPort(process.env);
  } catch (e) {
    console.error((e as Error).message.replace('Invalid port', 'Invalid MASTHEAD_DEV_WEB_PORT'));
    process.exit(2);
  }
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    app.shutdown();
    // Give the Claude Code processes a moment to end before the server does.
    setTimeout(() => process.exit(0), 300);
  };
  const secret = secretOrExit();
  try {
    await serve(app, { port: p, webDir, secret, extraOrigins: dev ? [`http://localhost:${devWeb}`, `http://127.0.0.1:${devWeb}`] : [], onShutdown: shutdown });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.error(err.code === 'EADDRINUSE' ? `Port ${p} is already in use. Is Masthead already running?` : `Could not start: ${err.message}`);
    process.exit(1);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Once serving, a stray rejected promise is logged and the server keeps running for the agents that
  // are working. Errors during start-up above still end the process. Uncaught exceptions keep Node's
  // default (exit; the service restarts it): after one, the state cannot be trusted.
  process.on('unhandledRejection', (reason) => {
    console.error(`Masthead: unhandled rejection: ${(reason as Error)?.stack ?? String(reason)}`);
  });
  console.log(`Masthead ${VERSION} is running at ${url(p)}`);
  if (dev) {
    // The dev page keeps the key in its own storage and forwards the socket here. Printed to this
    // terminal only; start Vite with MASTHEAD_PORT=${p} so it forwards to this server.
    console.log(`Development page (Vite, MASTHEAD_PORT=${p} MASTHEAD_DEV_WEB_PORT=${devWeb} npm run dev:web):\n  ${signInUrl(`http://localhost:${devWeb}`, secret)}`);
  } else {
    console.log(`Open it with \`masthead${p === DEFAULT_PORT ? '' : ` --port ${p}`}\` to sign the browser in.`);
  }
}

async function start(p: number): Promise<boolean> {
  if (await health(p)) return true;
  if (unitServes(p)) {
    spawnSync('systemctl', ['--user', 'start', 'masthead.service'], { stdio: 'inherit' });
  } else {
    const child = spawn(process.execPath, ['--disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED', fileURLToPath(import.meta.url), 'serve', '--port', String(p)], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }
  for (let i = 0; i < 40; i++) {
    if (await health(p)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main(): Promise<void> {
  const cmd = parseCommand(process.argv.slice(2));
  const p = port();
  switch (cmd) {
    case 'serve':
      await runServer();
      return;
    case 'open': {
      if (!existsSync(join(webDir, 'index.html'))) {
        console.error('The web page has not been built. Run: npm run build');
        process.exit(1);
      }
      if (!(await start(p))) {
        console.error('Masthead did not start. Try `masthead serve` to see why.');
        process.exit(1);
      }
      const secret = secretOrExit();
      // The key goes only to a server that proves it knows it (never to whatever else holds the port).
      if (!(await serverProves(url(p), p, secret))) {
        console.error(notOurs(p));
        process.exit(1);
      }
      console.log(`Masthead is at ${url(p)}`);
      // The key signs the browser in: the page keeps it for this address and removes it from the address bar.
      if (!process.argv.includes('--no-browser')) {
        await openSignedIn({ base: url(p), secret, dir: signInDir(process.env, DATA_DIR), opener: systemOpener, tty: process.stdout.isTTY === true });
      }
      else if (process.stdout.isTTY) console.log(`Sign-in address (keep it private):\n  ${signInUrl(url(p), secret)}`);
      return;
    }
    case 'status': {
      const h = await health(p);
      console.log(h ? `Masthead ${h.version} is running at ${url(p)} (pid ${h.pid})` : 'Masthead is not running.');
      process.exit(h ? 0 : 3);
      return;
    }
    case 'stop': {
      if (!(await health(p))) {
        console.log('Masthead is not running.');
        return;
      }
      if (unitServes(p)) spawnSync('systemctl', ['--user', 'stop', 'masthead.service'], { stdio: 'inherit' });
      if (await health(p)) {
        const key = readSecret();
        if (!key) {
          console.error(`There is no local secret (${SECRET_FILE}) for this data folder, so the Masthead on port ${p} cannot be stopped from here. Use the XDG_DATA_HOME it was started with.`);
          process.exit(1);
        }
        if (!(await serverProves(url(p), p, key))) {
          console.error(notOurs(p));
          process.exit(1);
        }
        const res = await fetch(`${url(p)}/api/shutdown`, { method: 'POST', headers: { 'x-masthead': '1', 'x-masthead-key': key } }).catch(() => null);
        if (res?.status === 403) {
          console.error(`Masthead on port ${p} refused to stop: it was started with a secret other than ${SECRET_FILE} (another XDG_DATA_HOME?).`);
          process.exit(1);
        }
      }
      for (let i = 0; i < 20 && (await health(p)); i++) await new Promise((r) => setTimeout(r, 250));
      if (await health(p)) {
        console.error('Masthead is still running.');
        process.exit(1);
      }
      console.log('Masthead stopped.');
      return;
    }
    case 'version':
    case '--version':
      console.log(VERSION);
      return;
    default:
      console.log(`Masthead ${VERSION}

  masthead            start Masthead if needed and open it in the browser
  masthead serve      run the server in this terminal
  masthead status     say whether it is running
  masthead stop       stop it (agents that are working are stopped too)

  --port N            use a port other than ${DEFAULT_PORT} (or set MASTHEAD_PORT)
  --no-browser        with the default command: do not open the browser; print the
                      sign-in address instead (when run in a terminal)`);
      process.exit(cmd === 'help' || cmd === '--help' ? 0 : 2);
  }
}

if (process.argv.includes('--version')) console.log(VERSION);
else if (process.argv.includes('--help') || process.argv.includes('-h')) process.argv.splice(2, process.argv.length, 'help'), void main();
else void main();
