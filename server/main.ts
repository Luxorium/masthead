#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../shared/protocol.js';
import { App } from './app.js';
import { UsageError, parseCommand, parsePort, unitPortFrom } from './cli.js';
import { DEFAULT_PORT, SECRET_FILE, loadSecret, readSecret } from './config.js';
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

/** Whether the installed user service is the one that serves port `p`. Any other port is a server of its own. */
function unitServes(p: number): boolean {
  const r = spawnSync('systemctl', ['--user', 'show', '-p', 'LoadState', '-p', 'Environment', 'masthead.service'], { encoding: 'utf8' });
  return r.status === 0 && unitPortFrom(r.stdout ?? '') === p;
}

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
    await serve(app, { port: p, webDir, secret, extraOrigins: dev ? ['http://localhost:7718', 'http://127.0.0.1:7718'] : [], onShutdown: shutdown });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.error(err.code === 'EADDRINUSE' ? `Port ${p} is already in use. Is Masthead already running?` : `Could not start: ${err.message}`);
    process.exit(1);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(`Masthead ${VERSION} is running at ${url(p)}`);
  if (dev) {
    // The dev page on 7718 keeps the key in its own storage and forwards the socket here.
    console.log(`Development page: http://localhost:7718/?key=${secret}`);
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

function openBrowser(target: string): void {
  const opener = ['xdg-open', 'gio'].find((c) => spawnSync('sh', ['-c', `command -v ${c}`], { stdio: 'ignore' }).status === 0);
  if (!opener) {
    console.log(`Open ${target} in your browser.`);
    return;
  }
  spawn(opener, opener === 'gio' ? ['open', target] : [target], { detached: true, stdio: 'ignore' }).unref();
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
      console.log(`Masthead is at ${url(p)}`);
      // The key signs the browser in: the page keeps it for this address and removes it from the address bar.
      if (!process.argv.includes('--no-browser')) openBrowser(`${url(p)}/?key=${secretOrExit()}`);
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
        const res = await fetch(`${url(p)}/api/shutdown`, { method: 'POST', headers: { 'x-masthead': '1', 'x-masthead-key': readSecret() ?? '' } }).catch(() => null);
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
  --no-browser        with the default command: do not open the browser`);
      process.exit(cmd === 'help' || cmd === '--help' ? 0 : 2);
  }
}

if (process.argv.includes('--version')) console.log(VERSION);
else if (process.argv.includes('--help') || process.argv.includes('-h')) process.argv.splice(2, process.argv.length, 'help'), void main();
else void main();
