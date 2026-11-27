#!/usr/bin/env node
// Runs a test command with its own temporary folder, and removes that folder afterwards: on success,
// on failure, and on Ctrl+C / SIGTERM. Every temp folder a test makes (os.tmpdir(), mkdtemp) lands
// inside it, whatever its prefix, so no test run leaves anything behind in the system temp folder.
//
//   node scripts/run-tests.mjs                      -> node --import tsx --test test/*.test.ts
//   node scripts/run-tests.mjs test/foo.test.ts     -> node --import tsx --test test/foo.test.ts
//   node scripts/run-tests.mjs -- <command> [args]  -> any command (e.g. vitest), same temp folder rules
//
// The folder name is short (mh-XXXXXX), so Unix socket paths built under it still fit macOS's
// 104-byte limit even under its long /var/folders/... temp path. MASTHEAD_KEEP_TMP=1 keeps it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const root = mkdtempSync(join(tmpdir(), 'mh-'));
const env = { ...process.env, TMPDIR: root, TEMP: root, TMP: root };

let cmd;
let cmdArgs;
if (args[0] === '--') {
  [cmd, ...cmdArgs] = args.slice(1);
  if (!cmd) {
    console.error('run-tests: nothing to run after --');
    process.exit(2);
  }
} else {
  cmd = process.execPath;
  // Node expands the glob itself (no shell), so this works the same on Windows.
  cmdArgs = ['--import', 'tsx', '--test', ...(args.length ? args : ['test/*.test.ts'])];
}

function cleanup() {
  if (process.env.MASTHEAD_KEEP_TMP === '1') {
    console.error(`run-tests: kept ${root}`);
    return;
  }
  try {
    // Retries: on Windows a file a child just closed can stay locked for a moment.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.error(`run-tests: could not remove ${root}: ${e.message}`);
  }
}

// npm's .cmd shims (vitest) need a shell on Windows; node itself does not.
const child = spawn(cmd, cmdArgs, { stdio: 'inherit', env, shell: process.platform === 'win32' && cmd !== process.execPath });
let signalled = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    signalled = sig;
    // The child gets the terminal's Ctrl+C itself; pass the others on. Clean up once it has exited.
    if (sig !== 'SIGINT') child.kill(sig);
  });
}
child.on('error', (e) => {
  console.error(`run-tests: could not start ${cmd}: ${e.message}`);
  cleanup();
  process.exit(1);
});
child.on('exit', (code, signal) => {
  cleanup();
  if (signal || signalled) process.exit(130);
  process.exit(code ?? 1);
});
