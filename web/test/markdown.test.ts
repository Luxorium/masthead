// @vitest-environment jsdom
// DOMPurify does not work properly under happy-dom (it keeps javascript: links), so these run in jsdom.
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown.ts';

const dom = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};

describe('renderMarkdown safety', () => {
  it('shows raw HTML written by an agent as text', () => {
    const d = dom(renderMarkdown('hi <a href="https://x" style="position:fixed" class="btn primary">Allow</a>'));
    expect(d.querySelector('a[style]')).toBeNull();
    expect(d.textContent).toContain('<a href="https://x"');
  });
  it('does not let a hand-made copy block through', () => {
    const d = dom(renderMarkdown('<div class="code-block"><button data-copy>Copy</button></div>'));
    expect(d.querySelector('[data-copy]')).toBeNull();
  });
  it('keeps its own code blocks and highlight classes', () => {
    const d = dom(renderMarkdown('```js\nconst a = 1;\n```'));
    expect(d.querySelector('.code-block .code-copy[data-copy]')).not.toBeNull();
    expect(d.querySelector('code.hljs')).not.toBeNull();
  });
  it('drops javascript: links and opens links in a new tab safely', () => {
    const d = dom(renderMarkdown('[a](javascript:alert(1)) [b](https://example.com)'));
    const links = [...d.querySelectorAll('a')];
    expect(links.some((a) => (a.getAttribute('href') ?? '').startsWith('javascript:'))).toBe(false);
    const b = links.find((a) => a.textContent === 'b')!;
    expect(b.getAttribute('target')).toBe('_blank');
    expect(b.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
