// Platform rules that run on any machine: folders, finding Claude Code, keeping the secret private.
// Each function takes the platform and its surroundings as arguments, so Linux can check Windows and macOS.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeCandidates, locateClaude, resolveShim, type FindDeps } from '../server/backends/claude/env.ts';
import { appDirs } from '../server/paths.ts';
import { currentSid, isPrivate, loadSecret, makeDirPrivate, makePrivate, renameRetry } from '../server/transport/auth.ts';

test('platform: settings and data folders per platform, with overrides', () => {
  assert.deepEqual(appDirs('linux', {}, '/home/a'), { config: '/home/a/.config/masthead', data: '/home/a/.local/share/masthead' });
  assert.deepEqual(appDirs('darwin', {}, '/Users/a'), { config: '/Users/a/Library/Application Support/Masthead', data: '/Users/a/Library/Application Support/Masthead' });
  assert.deepEqual(appDirs('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a'), {
    config: 'C:\\Users\\a\\AppData\\Roaming\\Masthead',
    data: 'C:\\Users\\a\\AppData\\Local\\Masthead',
  });
  assert.deepEqual(appDirs('win32', {}, 'C:\\Users\\a'), { config: 'C:\\Users\\a\\AppData\\Roaming\\Masthead', data: 'C:\\Users\\a\\AppData\\Local\\Masthead' });
  assert.deepEqual(appDirs('darwin', { XDG_CONFIG_HOME: '/x/c', XDG_DATA_HOME: '/x/d' }, '/Users/a'), { config: '/x/c/masthead', data: '/x/d/masthead' }, 'XDG wins everywhere');
  assert.deepEqual(appDirs('linux', { XDG_DATA_HOME: '/x/d', MASTHEAD_DATA_DIR: '/m/d', MASTHEAD_CONFIG_DIR: '/m/c' }, '/home/a'), { config: '/m/c', data: '/m/d' }, 'MASTHEAD_* wins over XDG');
});

function deps(platform: NodeJS.Platform, env: Record<string, string>, files: Record<string, string>, home: string): FindDeps {
  return { platform, env, home, exists: (p) => p in files, read: (p) => files[p] ?? '' };
}

test('platform: Claude Code is found on PATH and in the installers\' places', () => {
  assert.equal(locateClaude(deps('linux', { PATH: '/usr/bin' }, { '/usr/bin/claude': '' }, '/home/a')), '/usr/bin/claude');
  assert.equal(locateClaude(deps('linux', { PATH: '' }, { '/home/a/.local/bin/claude': '' }, '/home/a')), '/home/a/.local/bin/claude', 'native installer');
  assert.equal(locateClaude(deps('darwin', { PATH: '/usr/bin:/bin' }, { '/opt/homebrew/bin/claude': '' }, '/Users/a')), '/opt/homebrew/bin/claude', 'Homebrew on Apple Silicon, with launchd\'s short PATH');
  assert.equal(locateClaude(deps('linux', { PATH: '/usr/bin', MASTHEAD_CLAUDE: '/opt/c/claude' }, { '/opt/c/claude': '', '/usr/bin/claude': '' }, '/home/a')), '/opt/c/claude', 'the override comes first');
  assert.equal(locateClaude(deps('linux', { PATH: 'relative' }, { 'relative/claude': '' }, '/home/a')), null, 'relative PATH entries are ignored');
  assert.ok(!claudeCandidates({ platform: 'linux', env: {}, home: '/h' }).includes('/opt/homebrew/bin/claude'));
});

test('platform: on Windows the .exe is preferred and npm shims are followed to their real target', () => {
  const home = 'C:\\Users\\a';
  const npm = 'C:\\Users\\a\\AppData\\Roaming\\npm';
  // The native installer's claude.exe.
  assert.equal(locateClaude(deps('win32', { Path: 'C:\\Windows' }, { 'C:\\Users\\a\\.local\\bin\\claude.exe': '' }, home)), 'C:\\Users\\a\\.local\\bin\\claude.exe');
  // npm: an extension-less sh shim (unusable), claude.cmd naming the real program.
  const files = {
    [`${npm}\\claude`]: '#!/bin/sh',
    [`${npm}\\claude.cmd`]: '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
    [`${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`]: '',
  };
  assert.equal(locateClaude(deps('win32', { PATH: npm, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, files, home)), `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`);
  // Only the sh shim: not usable without a shell, so not found.
  assert.equal(locateClaude(deps('win32', { PATH: npm }, { [`${npm}\\claude`]: '#!/bin/sh' }, home)), null);
  assert.equal(resolveShim('C:\\n\\claude.cmd', '"%~dp0\\node_modules\\x\\cli.js" %*'), 'C:\\n\\node_modules\\x\\cli.js');
  assert.equal(resolveShim('C:\\n\\claude.cmd', 'echo nothing here'), null);
  const c = claudeCandidates({ platform: 'win32', env: { PATH: 'C:\\b', PATHEXT: '.COM;.EXE;.CMD' }, home });
  assert.equal(c[0], 'C:\\b\\claude.exe', '.exe is tried first');
});

test('platform: on Windows the secret is made private by SID, and a failure is never silent', () => {
  const calls: Array<[string, string[]]> = [];
  const who = { status: 0, stdout: '"pc\\ann","S-1-5-21-1-2-3-1001"\r\n' };
  const ok = (cmd: string, args: string[]) => (calls.push([cmd, args]), cmd === 'whoami' ? who : { status: 0, stdout: '' });
  assert.equal(currentSid(ok), 'S-1-5-21-1-2-3-1001');
  assert.equal(makePrivate('C:\\d\\secret', 'win32', ok), true);
  assert.deepEqual(calls.at(-1), ['icacls', ['C:\\d\\secret', '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:F']], 'granted by SID, not by an environment name');
  assert.equal(makeDirPrivate('C:\\d', 'win32', ok), true);
  assert.deepEqual(calls.at(-1), ['icacls', ['C:\\d', '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:(OI)(CI)F']], 'inherited by files made inside');
  const icaclsFails = (cmd: string) => (cmd === 'whoami' ? who : { status: 5, stdout: '' });
  assert.equal(makePrivate('C:\\d\\secret', 'win32', icaclsFails), false);
  const noWhoami = () => ({ status: null, stdout: '' });
  assert.equal(makePrivate('C:\\d\\secret', 'win32', noWhoami), false);
  assert.equal(makeDirPrivate('C:\\d', 'win32', noWhoami), false);
});

test('platform: on Windows the ACL is read to tell whether the secret is private', () => {
  const f = 'C:\\Users\\ann\\AppData\\Local\\Masthead\\secret';
  const icacls = (out: string, status = 0) => () => ({ status, stdout: out });
  assert.equal(isPrivate(f, 'win32', icacls(`${f} PC\\ann:(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`)), true);
  assert.equal(isPrivate(f, 'win32', icacls(`${f} PC\\ann:(F)\r\n   BUILTIN\\Users:(RX)\r\n\r\nSuccessfully processed 1 files\r\n`)), false, 'a second entry');
  assert.equal(isPrivate(f, 'win32', icacls(`${f} PC\\ann:(I)(F)\r\n\r\nSuccessfully processed 1 files\r\n`)), false, 'inherited');
  assert.equal(isPrivate(f, 'win32', icacls(`${f} Everyone:(F)\r\n\r\nSuccessfully processed 1 files\r\n`)), false);
  assert.equal(isPrivate(f, 'win32', icacls('', 2)), false, 'icacls failed: not private');
});

test('platform: on POSIX a secret others could read is replaced, and a new one is private', { skip: process.platform === 'win32' && 'POSIX modes only' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'masthead-priv-'));
  const f = join(dir, 'secret');
  const first = loadSecret(f);
  chmodSync(f, 0o644);
  assert.equal(isPrivate(f), false);
  const second = loadSecret(f);
  assert.notEqual(second, first);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o077, 0, 'the folder is private too');
});

test('platform: Masthead refuses a secret it could not make private (Windows)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'masthead-win-'));
  assert.throws(() => loadSecret(join(dir, 'secret'), 'win32', () => ({ status: 5, stdout: '' })), /private/);
});

test('platform: renames are retried only on Windows, and only while the target is busy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'masthead-ren-'));
  writeFileSync(join(dir, 'a'), '1');
  renameRetry(join(dir, 'a'), join(dir, 'b'), 'win32');
  assert.equal(readFileSync(join(dir, 'b'), 'utf8'), '1');
  assert.throws(() => renameRetry(join(dir, 'missing'), join(dir, 'c'), 'win32'), /ENOENT/, 'not a busy error: thrown at once');
});

test('platform: the secret is created once and read back the same', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'masthead-sec-')), 'd', 'secret');
  const a = loadSecret(file);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(loadSecret(file), a);
});

test('platform: real npm shims (cmd-shim 9.0.2) resolve to Claude Code, never to the node.exe they prefer', () => {
  const fx = (f: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'npm-shim-9.0.2', f), 'utf8');
  const npm = 'C:\\Users\\a\\AppData\\Roaming\\npm';
  const home = 'C:\\Users\\a';
  const cli = 'C:\\Users\\a\\AppData\\Roaming\\lib\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  const exe = 'C:\\Users\\a\\AppData\\Roaming\\lib\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  assert.equal(resolveShim(`${npm}\\claude.cmd`, fx('js-claude.cmd')), cli);
  assert.equal(resolveShim(`${npm}\\claude.cmd`, fx('exe-claude.cmd')), exe);
  const env = { PATH: npm, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  for (const nodeBeside of [false, true]) {
    // The sh and PowerShell variants sit beside the .cmd, as npm writes all three.
    const files: Record<string, string> = {
      [`${npm}\\claude`]: fx('js-claude.sh'),
      [`${npm}\\claude.ps1`]: fx('js-claude.ps1'),
      [`${npm}\\claude.cmd`]: fx('js-claude.cmd'),
      [cli]: '',
      ...(nodeBeside ? { [`${npm}\\node.exe`]: '' } : {}),
    };
    assert.equal(locateClaude(deps('win32', env, files, home)), cli, `node.exe beside the shim: ${nodeBeside}`);
  }
  const exeFiles = { [`${npm}\\claude`]: fx('exe-claude.sh'), [`${npm}\\claude.ps1`]: fx('exe-claude.ps1'), [`${npm}\\claude.cmd`]: fx('exe-claude.cmd'), [exe]: '' };
  assert.equal(locateClaude(deps('win32', env, exeFiles, home)), exe);
});
