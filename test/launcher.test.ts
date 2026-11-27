// Parsing of the `masthead` command line and of the installed service's port.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError, parseCommand, parsePort, unitPortFrom } from '../server/cli.ts';
import { DEFAULT_PORT } from '../server/config.ts';

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
