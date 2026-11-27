#!/usr/bin/env node
// Regenerates ./protocol/ from the installed Codex: `codex app-server generate-ts --experimental`,
// keeps only the types the adapter imports (and what they import), and adds the `.js` extensions that
// NodeNext needs. Run after a Codex upgrade, then run the Codex tests: node server/backends/codex/generate-protocol.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'protocol');
const tmp = mkdtempSync(join(tmpdir(), 'codex-ts-'));
execFileSync(process.env.MASTHEAD_CODEX || 'codex', ['app-server', 'generate-ts', '--experimental', '--out', tmp], { stdio: 'inherit' });
const version = execFileSync(process.env.MASTHEAD_CODEX || 'codex', ['--version'], { encoding: 'utf8' }).trim();

const ROOTS = [
  'InitializeParams', 'InitializeResponse', 'ServerNotification', 'ServerRequest',
  'v2/ThreadStartParams', 'v2/ThreadStartResponse', 'v2/ThreadResumeParams', 'v2/ThreadResumeResponse',
  'v2/TurnStartParams', 'v2/TurnStartResponse', 'v2/TurnSteerParams', 'v2/TurnInterruptParams',
  'v2/ModelListParams', 'v2/ModelListResponse', 'v2/DynamicToolCallParams', 'v2/DynamicToolCallResponse',
  'v2/CommandExecutionRequestApprovalResponse', 'v2/FileChangeRequestApprovalResponse',
  'v2/PermissionsRequestApprovalResponse', 'v2/ToolRequestUserInputResponse', 'v2/McpServerElicitationRequestResponse',
];
const keep = new Set();
const visit = (rel) => {
  if (keep.has(rel)) return;
  keep.add(rel);
  const src = readFileSync(join(tmp, rel + '.ts'), 'utf8');
  for (const m of src.matchAll(/from "(\.[^"]+)"/g)) visit(relative(tmp, resolve(dirname(join(tmp, rel)), m[1])));
};
ROOTS.forEach(visit);
rmSync(out, { recursive: true, force: true });
for (const rel of keep) {
  const src = readFileSync(join(tmp, rel + '.ts'), 'utf8').replace(/from "(\.[^"]+)"/g, (_, p) => `from "${p}.js"`);
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  writeFileSync(join(out, rel + '.ts'), src);
}
writeFileSync(join(out, 'VERSION'), `${version}\n${keep.size} files from generate-ts --experimental\n`);
rmSync(tmp, { recursive: true, force: true });
console.log(`protocol/: ${keep.size} files from ${version}`);
