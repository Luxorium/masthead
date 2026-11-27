// Live check of the Codex adapter against the real, signed-in Codex CLI. Not part of `npm test`: it uses
// real (small) Codex usage. Run: node --import tsx --test test/codex.live.ts
// Cheapest model (MASTHEAD_CODEX_MODEL, default gpt-6-luna), low effort, a temp folder per session.
// Threads must be saved for the resume case, so every thread it creates is deleted at the end
// (`codex delete --force <id>`).
import { execFileSync } from 'node:child_process';
import { after } from 'node:test';
import { CodexBackend } from '../server/backends/codex/index.ts';
import type { Backend, SessionEvents, SessionSpec } from '../server/backends/types.ts';
import { runConformance } from './backend-conformance.ts';

const model = process.env.MASTHEAD_CODEX_MODEL ?? 'gpt-6-luna';
const created = new Set<string>();
const backends: CodexBackend[] = [];

function make(): Backend {
  const b = new CodexBackend();
  backends.push(b);
  const open = b.open.bind(b);
  // Remember every thread, to delete it afterwards.
  b.open = (spec: SessionSpec, ev: SessionEvents) =>
    open(spec, new Proxy(ev, { get: (t, k) => (k === 'sessionStarted' ? (id: string) => (created.add(id), t.sessionStarted(id)) : (t as any)[k]) }));
  return b;
}

runConformance('codex (live)', make, { live: true, model, timeoutMs: 240_000 });

after(async () => {
  for (const b of backends) await b.dispose();
  for (const id of created) {
    try {
      execFileSync(process.env.MASTHEAD_CODEX || 'codex', ['delete', '--force', id], { stdio: 'ignore', timeout: 30_000 });
    } catch {
      // ephemeral or already gone
    }
  }
  console.log(`codex live: deleted ${created.size} test thread(s)`);
});
