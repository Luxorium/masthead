import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked, type Tokens } from 'marked';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? '').trim().split(/\s+/)[0] ?? '';
      let body: string;
      try {
        body = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : escapeHtml(text);
      } catch {
        body = escapeHtml(text);
      }
      const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : '';
      return `<div class="code-block">${label}<button class="code-copy" type="button" data-copy>Copy</button><pre><code class="hljs">${body}</code></pre></div>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Turns model-written Markdown into HTML that is safe to put in the page. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-copy'], FORBID_TAGS: ['style', 'form', 'input', 'iframe'] });
}

/** One click handler for every "Copy" button inside rendered Markdown. */
export function handleCopyClick(ev: MouseEvent): void {
  const btn = (ev.target as HTMLElement | null)?.closest?.('[data-copy]') as HTMLElement | null;
  if (!btn) return;
  const code = btn.parentElement?.querySelector('code')?.textContent ?? '';
  void navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy'), 1200);
  });
}
