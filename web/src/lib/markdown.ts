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
    // Agent output is untrusted (it can quote web pages and files), so HTML written in it is shown as
    // text, never as markup. Only the HTML this renderer builds reaches the sanitizer.
    html({ text, block }: Tokens.HTML | Tokens.Tag): string {
      return block ? `<p>${escapeHtml(text)}</p>` : escapeHtml(text);
    },
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

/** Classes Masthead's own renderer and highlight.js produce. Nothing else may set a class. */
const OWN_CLASS = /^(code-block|code-lang|code-copy|hljs(-[\w-]+)?|language-[\w-]+|[\w-]+_)$/;

DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'class') {
    const kept = data.attrValue.split(/\s+/).filter((c) => OWN_CLASS.test(c));
    if (kept.length) data.attrValue = kept.join(' ');
    else data.keepAttr = false;
  }
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function render(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-copy'],
    FORBID_TAGS: ['style', 'form', 'input', 'iframe'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });
}

/**
 * Rendered Markdown by its text, most recently used last. Transcripts are rebuilt on reload, reconnect
 * and when a chat is opened; without this every text item would be parsed, highlighted and sanitised
 * again each time.
 */
const cache = new Map<string, string>();
const CACHE_MAX = 500;

/** Turns model-written Markdown into HTML that is safe to put in the page. */
export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) {
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  const html = render(text);
  cache.set(text, html);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return html;
}

/**
 * Splits a streaming draft into its finished blocks (each ending at a blank line outside a code fence,
 * or where a fence closes) and the unfinished tail, and says whether the tail is inside an open fence.
 */
export function splitDraft(text: string): { blocks: string[]; tail: string; inFence: boolean } {
  const blocks: string[] = [];
  let inFence = false;
  let start = 0;
  let pos = 0;
  for (const line of text.split('\n')) {
    const end = Math.min(pos + line.length + 1, text.length);
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      // A fence that just closed ends a block.
      if (!inFence && end > start && pos + line.length < text.length) {
        blocks.push(text.slice(start, end));
        start = end;
      }
    } else if (!inFence && line.trim() === '' && pos > start && pos + line.length < text.length) {
      blocks.push(text.slice(start, end));
      start = end;
    }
    pos += line.length + 1;
  }
  return { blocks, tail: text.slice(start), inFence };
}

/**
 * Renders a draft that grows a little every 70 ms. Each finished block is rendered once and then comes
 * from the cache, so an update parses only the unfinished tail; a tail inside an unclosed code fence is
 * shown as plain escaped text until the fence closes (no highlighting per update). The same safety
 * steps apply to every block. Blocks are rendered separately, so a list interrupted by a blank line can
 * look split until the reply ends; the finished item is then rendered whole.
 */
export function renderDraft(text: string): string {
  const { blocks, tail, inFence } = splitDraft(text);
  const top = blocks.map(renderMarkdown).join('');
  if (!tail) return top;
  if (inFence) {
    const fenceAt = tail.search(/^\s{0,3}(```|~~~)/m);
    const before = fenceAt > 0 ? render(tail.slice(0, fenceAt)) : '';
    const code = tail.slice(fenceAt < 0 ? 0 : fenceAt).replace(/^\s{0,3}(```|~~~)[^\n]*\n?/, '');
    return `${top}${before}<div class="code-block"><pre><code class="hljs">${escapeHtml(code)}</code></pre></div>`;
  }
  return top + render(tail);
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
