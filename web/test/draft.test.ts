// @vitest-environment jsdom
// DOMPurify needs a real-ish DOM (see markdown.test.ts), so this runs in jsdom too.
import { describe, expect, it } from 'vitest';
import { renderDraft, renderMarkdown, splitDraft } from '../src/lib/markdown.ts';

/** A long agent answer: paragraphs, lists and code blocks, about 30 KB. */
function sample(): string {
  const parts: string[] = [];
  for (let i = 0; i < 60; i++) {
    parts.push(`## Part ${i}\n\nSome **bold** text and \`code\` in paragraph ${i}, long enough to wrap a line or two in the page.\n`);
    parts.push(`- one ${i}\n- two\n- three\n`);
    parts.push('```ts\n' + `function f${i}(a: number) {\n  return a * ${i};\n}\n` + '```\n');
  }
  return parts.join('\n');
}

describe('splitDraft', () => {
  it('splits at the last blank line outside a code fence', () => {
    expect(splitDraft('a\n\nb')).toEqual({ blocks: ['a\n\n'], tail: 'b', inFence: false });
  });
  it('does not split inside an open fence', () => {
    const t = 'intro\n\n```js\nconst a = 1;\n\nconst b = 2;';
    const r = splitDraft(t);
    expect(r.blocks).toEqual(['intro\n\n']);
    expect(r.inFence).toBe(true);
  });
  it('ends a block where a fence closes', () => {
    const r = splitDraft('```\nx\n```\nmore');
    expect(r.blocks).toEqual(['```\nx\n```\n']);
    expect(r.tail).toBe('more');
  });
});

describe('renderDraft', () => {
  it('ends up with the same text as a full render', () => {
    const text = sample();
    const strip = (html: string) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      return d.textContent!.replace(/\s+/g, ' ').trim();
    };
    expect(strip(renderDraft(text))).toBe(strip(renderMarkdown(text)));
  });
  it('shows an unclosed code fence as escaped plain code', () => {
    const html = renderDraft('Look:\n\n```html\n<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('costs far less per update than re-rendering the whole draft', () => {
    const text = sample();
    const steps: string[] = [];
    for (let n = 200; n < text.length; n += 200) steps.push(text.slice(0, n));
    const time = (fn: (t: string) => string, salt: string) => {
      const t0 = performance.now();
      for (const s of steps) fn(s + salt);
      return performance.now() - t0;
    };
    // A fresh salt per run keeps the cache from serving the full renders.
    const full = time((t) => renderMarkdown(t), '\n<!-- full -->');
    const incremental = time(renderDraft, '');
    console.log(`draft of ${text.length} chars in ${steps.length} updates: full ${full.toFixed(0)} ms, incremental ${incremental.toFixed(0)} ms`);
    expect(incremental).toBeLessThan(full / 2);
  });
});

describe('renderMarkdown cache', () => {
  it('returns the same HTML for the same text without parsing again', () => {
    const t = 'cached **once**';
    const a = renderMarkdown(t);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) renderMarkdown(t);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(renderMarkdown(t)).toBe(a);
  });
});
