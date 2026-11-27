// Parsing of the `masthead` command line and of the installed service's port.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SIGN_IN_STALE_MS, UsageError, openSignedIn, parseCommand, parseDevWebPort, parsePort, serverProves, signInDir, signInUrl, unitPortFrom, writeSignInFile, type Opener } from '../server/cli.ts';
import { DEFAULT_PORT, proofOf } from '../server/config.ts';

test('launcher: the port comes from --port, then MASTHEAD_PORT, then the default', () => {
  assert.equal(parsePort([]), DEFAULT_PORT);
  assert.equal(parsePort(['stop']), DEFAULT_PORT);
  assert.equal(parsePort(['--port', '7720']), 7720);
  assert.equal(parsePort(['stop', '--port', '7720']), 7720);
  assert.equal(parsePort(['--port=7721', 'status']), 7721);
  assert.equal(parsePort([], { MASTHEAD_PORT: '7722' }), 7722);
  assert.equal(parsePort(['--port', '7723'], { MASTHEAD_PORT: '7722' }), 7723, '--port wins');
  assert.equal(parsePort([], { MASTHEAD_PORT: '' }), DEFAULT_PORT);
});

test('launcher: a missing or bad port is an error, never a silent fallback', () => {
  for (const args of [['--port'], ['stop', '--port'], ['--port', '--no-browser'], ['--port', ''], ['--port='], ['--port', 'abc'], ['--port', '80'], ['--port', '70000'], ['--port', '7720.5'], ['--port', '0x1e30']]) {
    assert.throws(() => parsePort(args), UsageError, args.join(' '));
  }
  assert.throws(() => parsePort([], { MASTHEAD_PORT: 'x' }), UsageError);
});

test('launcher: the command is the first word that is not an option or the port', () => {
  assert.equal(parseCommand([]), 'open');
  assert.equal(parseCommand(['--no-browser']), 'open');
  assert.equal(parseCommand(['--port', '7720']), 'open');
  assert.equal(parseCommand(['--port', '7720', 'stop']), 'stop');
  assert.equal(parseCommand(['stop', '--port', '7720']), 'stop');
  assert.equal(parseCommand(['--port=7720', 'status']), 'status');
  assert.equal(parseCommand(['serve']), 'serve');
});

test("launcher: only the unit's own port is handled through systemd", () => {
  assert.equal(unitPortFrom('LoadState=not-found\nEnvironment=\n'), null, 'no unit installed');
  assert.equal(unitPortFrom(''), null);
  assert.equal(unitPortFrom('LoadState=loaded\nEnvironment=PATH=/usr/bin MASTHEAD_CLAUDE=/x/claude\n'), DEFAULT_PORT);
  assert.equal(unitPortFrom('LoadState=loaded\nEnvironment=PATH=/usr/bin MASTHEAD_PORT=7730\n'), 7730);
  assert.equal(unitPortFrom('LoadState=loaded\nEnvironment="PATH=/home/a b/bin" MASTHEAD_PORT=7731\n'), 7731);
  assert.equal(unitPortFrom('LoadState=loaded\nEnvironment=NOT_MASTHEAD_PORT=7732\n'), DEFAULT_PORT);
  assert.equal(unitPortFrom('LoadState=loaded\nEnvironment=MASTHEAD_PORT=12\n'), DEFAULT_PORT, 'a port the server would refuse');
});

test('launcher: the dev page port comes from MASTHEAD_DEV_WEB_PORT, else 7718', () => {
  assert.equal(parseDevWebPort({}), 7718);
  assert.equal(parseDevWebPort({ MASTHEAD_DEV_WEB_PORT: '7740' }), 7740);
  assert.throws(() => parseDevWebPort({ MASTHEAD_DEV_WEB_PORT: 'x' }), UsageError);
  // Same range as --port: a typo must not quietly pick a privileged or impossible port.
  for (const bad of ['80', '70000']) assert.throws(() => parseDevWebPort({ MASTHEAD_DEV_WEB_PORT: bad }), UsageError, bad);
});

const KEY = 'c'.repeat(64);

test('launcher: the key travels in the fragment, and sign-in files go to the runtime folder', () => {
  assert.equal(signInUrl('http://127.0.0.1:7790', KEY), `http://127.0.0.1:7790/#key=${KEY}`);
  assert.equal(signInDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/d/masthead'), '/run/user/1000/masthead');
  assert.equal(signInDir({}, '/d/masthead'), '/d/masthead/open');
  assert.equal(signInDir({ XDG_RUNTIME_DIR: 'relative' }, '/d/masthead'), '/d/masthead/open');
});

test('launcher: the sign-in file is private, holds the fragment address, and stale ones are removed', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'masthead-open-')), 'open');
  const target = signInUrl('http://127.0.0.1:7790', KEY);
  const first = writeSignInFile(dir, target);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(first).mode & 0o777, 0o600);
  const html = readFileSync(first, 'utf8');
  assert.match(html, new RegExp(`http-equiv="refresh" content="0; url=http://127.0.0.1:7790/#key=${KEY}"`));
  assert.match(html, new RegExp(`<a href="http://127.0.0.1:7790/#key=${KEY}">`));
  writeFileSync(join(dir, 'other.txt'), '');
  const old = (Date.now() - SIGN_IN_STALE_MS - 1000) / 1000;
  utimesSync(first, old, old);
  const second = writeSignInFile(dir, target);
  assert.equal(existsSync(first), false, 'a stale sign-in file is removed');
  assert.equal(existsSync(second), true);
  assert.equal(existsSync(join(dir, 'other.txt')), true, 'other files are left alone');
  // A fresh file belongs to a run that may still be opening it.
  const third = writeSignInFile(dir, target);
  assert.equal(existsSync(second), true, 'a recent sign-in file from a parallel run survives');
  assert.equal(existsSync(third), true);
});

test('launcher: an existing, too-open sign-in folder is made private again', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'masthead-open-')), 'open');
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755); // mkdir's mode is masked by umask
  writeSignInFile(dir, signInUrl('http://127.0.0.1:7790', KEY));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('launcher: the sign-in file never overwrites one, and the address is HTML-escaped', (t) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'masthead-open-')), 'open');
  // Fix the random name so the second write collides with the first; the sync makes cli.ts's named import see it.
  const real = crypto.randomBytes;
  (crypto as { randomBytes: unknown }).randomBytes = () => Buffer.alloc(6);
  syncBuiltinESMExports();
  t.after(() => {
    crypto.randomBytes = real;
    syncBuiltinESMExports();
  });
  const file = writeSignInFile(dir, 'http://x/"<b>&');
  const html = readFileSync(file, 'utf8');
  assert.match(html, /url=http:\/\/x\/&quot;&lt;b&gt;&amp;"/);
  assert.match(html, /<a href="http:\/\/x\/&quot;&lt;b&gt;&amp;">/);
  assert.ok(!html.includes('"<b>'), 'the raw target never appears');
  assert.throws(() => writeSignInFile(dir, 'http://y/'), { code: 'EEXIST' });
  assert.equal(readFileSync(file, 'utf8'), html, 'the existing file is untouched');
});

function fakeOpener(opts: { has?: string[]; code?: number | null | 'hang' } = {}) {
  const calls: Array<{ kind: string; cmd: string; args: string[] }> = [];
  const lines: string[] = [];
  const opener: Opener = {
    has: (cmd) => (opts.has ?? ['xdg-open']).includes(cmd),
    run: async (cmd, args) => {
      calls.push({ kind: 'run', cmd, args });
      if (opts.code === 'hang') return new Promise<number | null>(() => {});
      return opts.code === undefined ? 0 : opts.code;
    },
    detach: (cmd, args) => void calls.push({ kind: 'detach', cmd, args }),
    log: (line) => void lines.push(line),
  };
  return { opener, calls, lines };
}

test('launcher: the opener gets a file path, never the key, and the file is removed later', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'masthead-open-')), 'open');
  const { opener, calls, lines } = fakeOpener();
  assert.equal(await openSignedIn({ base: 'http://127.0.0.1:7790', secret: KEY, dir, opener, tty: false }), true);
  for (const c of calls) assert.ok(!c.args.join(' ').includes(KEY), `${c.cmd} got the key in its arguments`);
  assert.equal(calls[0]!.cmd, 'xdg-open');
  const file = calls[0]!.args[0]!;
  assert.ok(file.startsWith(dir) && existsSync(file));
  assert.deepEqual(calls[1], { kind: 'detach', cmd: 'sh', args: ['-c', 'sleep 60; rm -f -- "$1"', 'sh', file] });
  assert.deepEqual(lines, [], 'nothing printed when the browser opened and there is no terminal');

  const gio = fakeOpener({ has: ['gio'] });
  await openSignedIn({ base: 'http://127.0.0.1:7790', secret: KEY, dir, opener: gio.opener, tty: true });
  assert.deepEqual(gio.lines, ['If the browser did not open signed in, run: masthead --no-browser'], 'in a terminal, one hint line and no key');
  assert.equal(gio.calls[0]!.cmd, 'gio');
  assert.equal(gio.calls[0]!.args[0], 'open');
});

test('launcher: with no opener, or one that fails, the address is printed and no file is left', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'masthead-open-')), 'open');
  const none = fakeOpener({ has: [] });
  assert.equal(await openSignedIn({ base: 'http://127.0.0.1:7790', secret: KEY, dir, opener: none.opener, tty: true }), false);
  assert.match(none.lines.join('\n'), new RegExp(`http://127.0.0.1:7790/#key=${KEY}`));
  assert.match(none.lines.at(-1)!, /masthead --no-browser/);
  assert.equal(existsSync(dir), false, 'no file written without an opener');

  for (const code of [1, null]) {
    const failing = fakeOpener({ code });
    assert.equal(await openSignedIn({ base: 'http://127.0.0.1:7790', secret: KEY, dir, opener: failing.opener, tty: true }), false);
    assert.match(failing.lines.join('\n'), /#key=/);
    assert.deepEqual(readdirSync(dir), [], 'the unused file is removed');
    assert.ok(!failing.calls.some((c) => c.kind === 'detach'));
  }
});

test('launcher: a sign-in file that cannot be written is reported, and the address is printed', async () => {
  const base = mkdtempSync(join(tmpdir(), 'masthead-open-'));
  writeFileSync(join(base, 'file'), '');
  const dir = join(base, 'file', 'open'); // under a regular file, so mkdir fails
  const fake = fakeOpener();
  assert.equal(await openSignedIn({ base: 'http://127.0.0.1:7790', secret: KEY, dir, opener: fake.opener, tty: true }), false);
  assert.match(fake.lines[0]!, /^Could not write the sign-in file/);
  assert.match(fake.lines.join('\n'), new RegExp(`http://127.0.0.1:7790/#key=${KEY}`));
  assert.ok(!fake.calls.some((c) => c.kind === 'run'), 'the opener is not run without a file');
});

test('launcher: without a terminal the key is never printed, only how to get it', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'masthead-open-')), 'open');
  for (const fake of [fakeOpener({ has: [] }), fakeOpener({ code: 1 })]) {
    assert.equal(await openSignedIn({ base: 'http://127.0.0.1:7790', secret: KEY, dir, opener: fake.opener, tty: false }), false);
    assert.ok(!fake.lines.join('\n').includes(KEY), 'the key stays out of output that may be logged');
    assert.match(fake.lines.join('\n'), /masthead --no-browser/);
  }
});

test('launcher: an opener still running after the wait counts as opened, so masthead never hangs', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'masthead-open-')), 'open');
  const hanging = fakeOpener({ code: 'hang' });
  const t0 = Date.now();
  assert.equal(await openSignedIn({ base: 'http://127.0.0.1:7790', secret: KEY, dir, opener: hanging.opener, tty: false, waitMs: 50 }), true);
  assert.ok(Date.now() - t0 < 2000, 'returned after the wait, not when the opener ended');
  assert.equal(hanging.calls.at(-1)!.kind, 'detach', 'the file is still removed later');
});

test('launcher: the key goes only to a server that proves it knows it', async () => {
  const PORT = 7790;
  type Reply = { status: number; json(): Promise<unknown> };
  const asked: string[] = [];
  const server = (answer: (nonce: string) => Reply | Promise<Reply>) => async (url: string) => {
    asked.push(url);
    const nonce = new URL(url).searchParams.get('nonce')!;
    return answer(nonce);
  };
  const json = (status: number, body: unknown): Reply => ({ status, json: async () => body });
  const real = server((n) => json(200, { name: 'masthead', proof: proofOf(KEY, PORT, n) }));
  assert.equal(await serverProves('http://127.0.0.1:7790', PORT, KEY, real), true);
  assert.match(asked[0]!, /^http:\/\/127\.0\.0\.1:7790\/api\/proof\?nonce=[0-9a-f]{64}$/);
  assert.ok(!asked[0]!.includes(KEY), 'asking does not reveal the key');
  await serverProves('http://127.0.0.1:7790', PORT, KEY, real);
  assert.notEqual(asked[0], asked[1], 'a fresh nonce each time');

  const impostors = [
    server(() => json(200, { name: 'masthead', proof: 'f'.repeat(64) })),
    server((n) => json(200, { name: 'masthead', proof: proofOf('d'.repeat(64), PORT, n) })),
    server((n) => json(200, { name: 'masthead', proof: proofOf(KEY, PORT + 1, n) })), // relayed from a Masthead on another port
    server(() => json(404, null)), // a Masthead older than /api/proof
    server(() => json(200, 'not json object')),
    server(() => ({ status: 200, json: async () => { throw new Error('bad json'); } })),
    async () => { throw new Error('ECONNREFUSED'); },
  ];
  for (const f of impostors) assert.equal(await serverProves('http://127.0.0.1:7790', PORT, KEY, f), false);
});

test('install: the service PATH drops empty, relative and repeated entries', () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'path.sh');
  const clean = (p: string) => execFileSync('bash', ['-c', '. "$1"; clean_path "$2"', 'bash', script, p], { encoding: 'utf8' });
  assert.equal(clean('/usr/bin:.:bin::/usr/bin:/home/a b/bin:node_modules/.bin:/x/*:/usr/bin/'), '/usr/bin:/home/a b/bin:/x/*:/usr/bin/');
  assert.equal(clean(''), '');
  assert.equal(clean('.:relative'), '');
});
