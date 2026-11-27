// The scratch folders as the app uses them: agents get theirs as TMPDIR (and as an allowed folder),
// deleting a conversation removes it, and the start-up sweep clears the folders of gone or week-old
// conversations. Fake backend, temporary folders only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App, type Client } from '../server/app/app.ts';
import { BackendRegistry } from '../server/backends/registry.ts';
import { defaultSettings } from '../server/settings/settings.ts';
import { Store } from '../server/storage/store.ts';
import type { ServerMsg } from '../shared/protocol.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mh-scratch-'));
  const scratchRoot = join(dir, 'data', 'scratch');
  const registry = new BackendRegistry({ env: { MASTHEAD_BACKEND: 'fake', MASTHEAD_ALLOW_FAKE: '1', MASTHEAD_FAKE_STEP_MS: '1' } });
  const app = new App({ store: new Store(join(dir, 'data', 'conversations')), settingsFile: join(dir, 's.json'), settings: { ...defaultSettings(), defaultCwd: dir }, registry, scratchRoot });
  const got: ServerMsg[] = [];
  const client: Client = { send: (m) => void got.push(m) };
  app.connect(client);
  return { dir, scratchRoot, registry, app, got, client };
}

async function until(cond: () => boolean) {
  const end = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('scratch: an agent gets the conversation\'s folder as TMPDIR and as an allowed folder; deleting the conversation removes it', async () => {
  const { scratchRoot, registry, app, got, client } = setup();
  app.handle(client, { t: 'send', convId: null, text: 'Reply with exactly the word HI' });
  await until(() => registry.fake!.sessions.length === 1);
  const spec = registry.fake!.sessions[0]!.spec;
  const convId = [...(app as unknown as { conversations: Map<string, unknown> }).conversations.keys()][0]!;
  const folder = join(scratchRoot, convId);
  assert.equal(spec.env.TMPDIR, folder);
  assert.equal(spec.env.CLAUDE_CODE_TMPDIR, folder);
  assert.deepEqual(spec.dirs, [folder]);
  assert.match(spec.instructions, new RegExp(`Your temporary folder is ${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(existsSync(folder));
  app.handle(client, { t: 'delete', convId });
  assert.equal(existsSync(folder), false);
  app.shutdown();
});

test('scratch: the start-up sweep removes gone and week-old folders, keeps the rest', async () => {
  const { scratchRoot, app, got, client, registry } = setup();
  assert.deepEqual(app.sweepScratch(), [], 'no folder yet: nothing, no error');
  app.handle(client, { t: 'send', convId: null, text: 'Reply with exactly the word HI' });
  await until(() => registry.fake!.sessions.length === 1);
  const convId = [...(app as unknown as { conversations: Map<string, unknown> }).conversations.keys()][0]!;
  mkdirSync(join(scratchRoot, 'gone-conversation'), { recursive: true });
  const kept = join(scratchRoot, convId);
  assert.deepEqual(app.sweepScratch(), ['gone-conversation']);
  assert.ok(existsSync(kept));
  // A week later, folder and conversation unchanged: removed (unless an agent is busy there).
  const old = new Date(Date.now() - 8 * 86_400_000);
  utimesSync(kept, old, old);
  await until(() => !app.workingCount());
  assert.deepEqual(app.sweepScratch(), [], 'the conversation itself was active within the week: kept');
  (app as unknown as { conversations: Map<string, { meta: { updatedAt: number } }> }).conversations.get(convId)!.meta.updatedAt = old.getTime();
  assert.deepEqual(app.sweepScratch(), [convId]);
  assert.equal(existsSync(kept), false);
  app.shutdown();
});

test('scratch: a folder that cannot be made leaves the agent on the system temporary folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-scratch-'));
  const registry = new BackendRegistry({ env: { MASTHEAD_BACKEND: 'fake', MASTHEAD_ALLOW_FAKE: '1', MASTHEAD_FAKE_STEP_MS: '1' } });
  // A file where the root should be: mkdir fails.
  const blocked = join(dir, 'file');
  (await import('node:fs')).writeFileSync(blocked, '');
  const app = new App({ store: new Store(join(dir, 'c')), settingsFile: join(dir, 's.json'), settings: defaultSettings(), registry, scratchRoot: join(blocked, 'scratch') });
  const client: Client = { send: () => {} };
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    app.handle(client, { t: 'send', convId: null, text: 'Reply with exactly the word HI', cwd: dir });
    await until(() => registry.fake!.sessions.length === 1);
  } finally {
    console.error = orig;
  }
  assert.equal(registry.fake!.sessions[0]!.spec.env.TMPDIR, undefined);
  assert.equal(errors.length, 1);
  app.shutdown();
});
