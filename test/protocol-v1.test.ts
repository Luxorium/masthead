// Exactly what a version 1 (0.1.x) tab receives from App, as the review asked: no v2 fields leak in.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App, type Client } from '../server/app/app.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Store } from '../server/storage/store.ts';

test('v1: state, events and errors keep the 0.1.x shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-v1-'));
  const app = new App({ store: new Store(join(dir, 'c')), settingsFile: join(dir, 's.json'), settings: defaultSettings(), claude: { path: null, version: null } });
  const got: Array<Record<string, unknown>> = [];
  const c: Client = { send: (m) => void got.push(JSON.parse(JSON.stringify(m))), blobToken: 't' };
  app.connect(c);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.t, 'state');
  assert.equal('protocol' in got[0]!, false);
  assert.equal('epoch' in got[0]!, false);
  const st = got[0]!.state as Record<string, unknown>;
  assert.equal('backends' in st, false);
  assert.equal('remote' in st, false);
  got.length = 0;
  app.handle(c, { t: 'open', convId: 'nope' });
  assert.deepEqual(got, [{ t: 'error', message: 'That conversation no longer exists.' }], 'no code for a v1 tab');
  got.length = 0;
  app.handle(c, { t: 'subscribe', convId: 'x' });
  assert.deepEqual(got, [{ t: 'error', message: 'Say hello with protocol 2 first.' }]);
  got.length = 0;
  app.handle(c, { t: 'settings', settings: { autoEffort: false } });
  assert.deepEqual(got.map((m) => m.t), ['settings'], 'list-level events reach a v1 tab unchanged');
  assert.equal('seq' in got[0]!, false);
});
