// ─── Lightweight markdown → sanitized HTML renderer ───────────────────
// No dependencies. Regex-based parsing for the markdown subset agents emit.
// Order: extract code blocks → escape HTML → block elements → inline → <br> → restore.

const CB_MARK = '\x00';
const CB_MARK_END = '\x01';

interface CodeBlock {
  lang: string;
  code: string;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

let _mdCache: { text: string; html: string } | null = null;

/**
 * Render markdown text to safe HTML.
 * Supports: ```lang blocks, inline `code`, **bold**, *italic*,
 * # h1-3, - / 1. lists, [links](url).
 *
 * Result is memoized on the last input — during streaming the same
 * growing text is often passed multiple times before the next chunk.
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  if (_mdCache?.text === text) return _mdCache.html;

  // Step 1: Extract fenced code blocks → placeholders
  const blocks: CodeBlock[] = [];
  let body = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m: string, lang: string, code: string) => {
    const idx = blocks.length;
    blocks.push({ lang: lang || '', code: code.replace(/^\n/, '') });
    return `${CB_MARK}CB${idx}${CB_MARK_END}`;
  });

  // Step 2: HTML-escape everything (placeholders survive — control chars)
  body = escapeHtml(body);

  // Step 3: Block-level markdown (operates on \n-delimited lines before <br> conversion)
  body = body.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  body = body.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  body = body.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Unordered lists — group consecutive - lines
  body = body.replace(/((?:^- .+(?:\n|$))+)/gm, (match) => {
    const items = match
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => `<li>${l.replace(/^- /, '')}</li>`)
      .join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists — group consecutive 1. lines
  body = body.replace(/((?:^\d+\. .+(?:\n|$))+)/gm, (match) => {
    const items = match
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`)
      .join('');
    return `<ol>${items}</ol>`;
  });

  // Step 4: Inline markdown
  body = body.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  body = body.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  body = body.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // Links — only http/https allowed
  body = body.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m: string, linkText: string, url: string) => {
    const trimmed = url.trim();
    const safeUrl = /^https?:\/\//i.test(trimmed) ? trimmed : '#';
    return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener">${linkText}</a>`;
  });

  // Step 5: Convert remaining newlines to <br>
  // Code blocks are still placeholders, so \n inside them is safe.
  body = body.replace(/\n/g, '<br>');

  // Step 6: Restore code blocks with full HTML wrapper
  const cbPat = new RegExp(`${escapeRegex(CB_MARK)}CB(\\d+)${escapeRegex(CB_MARK_END)}`, 'g');
  body = body.replace(cbPat, (_m: string, idx: string) => {
    const block = blocks[parseInt(idx)];
    if (!block) return '';
    const { lang, code } = block;
    const escapedCode = escapeHtml(code);
    const langLabel = lang || 'code';
    return (
      '<div class="chat-codeblock">' +
      '<div class="chat-codeblock-head">' +
      `<span class="lang">${escapeHtml(langLabel)}</span>` +
      `<button class="chat-code-copy" data-code="${escapeHtml(code)}">copiar</button>` +
      '</div>' +
      `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapedCode}</code></pre>` +
      '</div>'
    );
  });

  _mdCache = { text, html: body };
  return body;
}

/** Escape special chars for use inside new RegExp(). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
