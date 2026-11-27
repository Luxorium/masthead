#!/usr/bin/env node
// Checks docs/wiki/Code-Coverage-Map.md against the source tree: every source file must have a row
// (a row may cover a folder with a trailing `/**`), every row must name a file that exists, and every
// wiki link in the map must point to a page (and heading) that exists.
//
//   node docs/check-coverage.mjs            check everything
//   node docs/check-coverage.mjs server/core server/settings   only files under these paths
//
// Exit code 1 when something is missing or stale. Reads files only; changes nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wiki = join(root, 'docs', 'wiki');
const only = process.argv.slice(2).map((p) => p.replace(/\/+$/, ''));

const SOURCES = ['server', 'shared', 'web/src', 'web/index.html', 'web/public', 'scripts', 'packaging', 'test', 'vite.config.ts', 'svelte.config.js', 'tsconfig.server.json', 'tsconfig.web.json', 'package.json'];
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SOURCES], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && existsSync(join(root, f)) && !f.startsWith('test/fixtures/'));

const map = readFileSync(join(wiki, 'Code-Coverage-Map.md'), 'utf8');
const rows = [];
for (const line of map.split('\n')) {
  const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
  if (m) rows.push({ path: m[1], line });
}
const covers = (row, file) => (row.endsWith('/**') ? file.startsWith(row.slice(0, -2)) : row === file);
const inScope = (file) => only.length === 0 || only.some((p) => file === p || file.startsWith(`${p}/`));

const problems = [];
for (const f of files) if (inScope(f) && !rows.some((r) => covers(r.path, f))) problems.push(`missing: ${f}`);
for (const r of rows) {
  if (!inScope(r.path.replace(/\/\*\*$/, ''))) continue;
  const exists = r.path.endsWith('/**') ? files.some((f) => covers(r.path, f)) : files.includes(r.path);
  if (!exists) problems.push(`stale row (no such file): ${r.path}`);
}

// Links in the rows we checked: page must exist; #anchor must match a heading on that page.
const slug = (h) =>
  h.trim().toLowerCase().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
const anchorsOf = new Map();
function anchors(page) {
  if (!anchorsOf.has(page)) {
    const text = readFileSync(join(wiki, page), 'utf8');
    const seen = new Map();
    const set = new Set();
    for (const l of text.split('\n')) {
      const h = /^#{1,6}\s+(.*)$/.exec(l);
      if (!h) continue;
      const base = slug(h[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      set.add(n ? `${base}-${n}` : base);
    }
    anchorsOf.set(page, set);
  }
  return anchorsOf.get(page);
}
for (const r of rows) {
  if (!inScope(r.path.replace(/\/\*\*$/, ''))) continue;
  for (const m of r.line.matchAll(/\]\(([A-Za-z0-9-]+\.md)(?:#([^)]+))?\)/g)) {
    const [, page, anchor] = m;
    if (!existsSync(join(wiki, page))) problems.push(`${r.path}: link to missing page ${page}`);
    else if (anchor && !anchors(page).has(anchor)) problems.push(`${r.path}: ${page}#${anchor} has no such heading`);
  }
}

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n${problems.length} problem(s).`);
  process.exit(1);
}
console.log(`Code coverage map: ${files.filter(inScope).length} files covered, links resolve.`);
