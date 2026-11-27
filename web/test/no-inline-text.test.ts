// Every word a person reads comes from web/src/lib/text.ts, so wording can be checked in one place.
// This scans the markup of each .svelte file (not its script or style) for English written inline:
// text between tags, and the aria-label, title, placeholder and alt attributes.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../src');
/** Inline text that is fine: symbols, and names that are not language. */
const ALLOWED = new Set(['Masthead', 'Copy']);

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? svelteFiles(p) : p.endsWith('.svelte') ? [p] : [];
  });
}

function markup(src: string): string {
  return src
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\{/g, '{');
}

/** Removes {expressions}, innermost first, so nested braces go too. */
function noExpressions(m: string): string {
  let prev = '';
  while (prev !== m) {
    prev = m;
    m = m.replace(/\{[^{}]*\}/g, ' ');
  }
  return m;
}

const words = (s: string) => s.replace(/[^A-Za-z' ]+/g, ' ').trim();

describe('page text lives in text.ts', () => {
  it('no .svelte file writes English inline', () => {
    const found: string[] = [];
    for (const file of svelteFiles(ROOT)) {
      const m = noExpressions(markup(readFileSync(file, 'utf8')));
      const bits = [
        ...[...m.matchAll(/>([^<>]+)</g)].map((x) => x[1]!),
        ...[...m.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]*)"/g)].map((x) => x[1]!),
      ];
      for (const b of bits) {
        const w = words(b);
        if (/[A-Za-z]{2,}/.test(w) && !ALLOWED.has(w)) found.push(`${file.slice(ROOT.length + 1)}: "${w}"`);
      }
    }
    expect(found).toEqual([]);
  });
});
