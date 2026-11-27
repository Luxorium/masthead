// App keeps the computer awake while any agent works (delta's Awake behind a small interface).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../server/app/app.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Store } from '../server/storage/store.ts';

test('app: awake follows working conversations and the setting; stop on shutdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-awake-'));
  const calls: string[] = [];
  const awake = { set: (w: boolean) => void calls.push(String(w)), stop: () => void calls.push('stop') };
  const app = new App({ store: new Store(join(dir, 'c')), settingsFile: join(dir, 's.json'), settings: defaultSettings(), claude: { path: null, version: null }, awake });
  let working = false;
  const conv = { meta: { id: 'x' }, busy: () => working, toStored: () => ({ meta: { id: 'x', title: '', cwd: '/', createdAt: 1, updatedAt: 1, leadId: 'l' }, agents: [] }), infos: () => [], shutdown: () => {} };
  (app as unknown as { conversations: Map<string, unknown> }).conversations.set('x', conv);
  const changed = () => app.agentChanged(conv as never, { info: { id: 'a' } } as never);
  working = true;
  changed();
  working = false;
  changed();
  assert.deepEqual(calls, ['true', 'false']);
  working = true;
  changed();
  app.handle({ send: () => {} }, { t: 'settings', settings: { keepAwake: false } });
  // Until settings carry `keepAwake` (foxtrot), the patch is dropped and the hold stays.
  if ('keepAwake' in defaultSettings()) assert.equal(calls.at(-1), 'false', 'switching the setting off releases it');
  app.shutdown();
  assert.equal(calls.at(-1), 'stop');
});
