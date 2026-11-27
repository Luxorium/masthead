// Platform rules that run on any machine: folders, finding Claude Code, keeping the secret private.
// Each function takes the platform and its surroundings as arguments, so Linux can check Windows and macOS.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeCandidates, locateClaude, resolveShim, type FindDeps } from '../server/backends/claude/env.ts';
import { appDirs } from '../server/paths.ts';
import { loadSecret, makePrivate, renameRetry } from '../server/transport/auth.ts';

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

test('platform: the secret is made private with modes on POSIX and with icacls on Windows', () => {
  const calls: Array<[string, string[]]> = [];
  makePrivate('C:\\d\\secret', 'win32', (cmd, args) => (calls.push([cmd, args]), 0), { USERNAME: 'ann', USERDOMAIN: 'PC' });
  assert.deepEqual(calls, [['icacls', ['C:\\d\\secret', '/inheritance:r', '/grant:r', 'PC\\ann:F']]]);
  makePrivate('C:\\d\\secret', 'win32', (cmd, args) => (calls.push([cmd, args]), 0), {});
  assert.equal(calls.length, 1, 'no user name: nothing to grant, nothing run');
  if (process.platform !== 'win32') {
    const dir = mkdtempSync(join(tmpdir(), 'masthead-priv-'));
    const f = join(dir, 's');
    writeFileSync(f, 'x', { mode: 0o644 });
    makePrivate(f, 'linux', () => {
      throw new Error('no commands on POSIX');
    });
    assert.equal(statSync(f).mode & 0o777, 0o600);
  }
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
