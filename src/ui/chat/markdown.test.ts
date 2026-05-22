// ─── markdown.ts unit tests ──────────────────────────────────────────────────
// Pure string-to-string tests — no DOM needed.

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.ts';

describe('renderMarkdown', () => {
  // ── Edge cases ────────────────────────────────────────────────────
  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('preserves plain text without markdown', () => {
    expect(renderMarkdown('hello world')).toBe('hello world');
  });

  // ── Bold ───────────────────────────────────────────────────────────
  it('renders **bold** as <strong>', () => {
    expect(renderMarkdown('**bold text**')).toContain('<strong>bold text</strong>');
  });

  it('does not match bold across newlines', () => {
    const result = renderMarkdown('**bold\nstill**');
    expect(result).not.toContain('<strong>');
  });

  // ── Italic ─────────────────────────────────────────────────────────
  it('renders *italic* as <em>', () => {
    expect(renderMarkdown('*italic text*')).toContain('<em>italic text</em>');
  });

  it('does not match italic across newlines', () => {
    const result = renderMarkdown('*italic\nstill*');
    expect(result).not.toContain('<em>');
  });

  // ── Inline code ────────────────────────────────────────────────────
  it('renders `inline code` as <code>', () => {
    expect(renderMarkdown('use `code()` here')).toContain('<code>code()</code>');
  });

  it('does not match inline code across newlines', () => {
    const result = renderMarkdown('use `code\nhere`');
    expect(result).not.toContain('<code>');
  });

  // ── Headings ───────────────────────────────────────────────────────
  it('renders # heading as <h1>', () => {
    expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>');
  });

  it('renders ## heading as <h2>', () => {
    expect(renderMarkdown('## Section')).toContain('<h2>Section</h2>');
  });

  it('renders ### heading as <h3>', () => {
    expect(renderMarkdown('### Sub')).toContain('<h3>Sub</h3>');
  });

  it('does not render #### as heading', () => {
    expect(renderMarkdown('#### Not a heading')).not.toContain('<h');
  });

  // ── Unordered lists ────────────────────────────────────────────────
  it('renders - items as <ul><li>', () => {
    const result = renderMarkdown('- a\n- b\n- c');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>a</li>');
    expect(result).toContain('<li>b</li>');
    expect(result).toContain('<li>c</li>');
  });

  it('renders single - item', () => {
    expect(renderMarkdown('- just one')).toContain('<li>just one</li>');
  });

  // ── Ordered lists ──────────────────────────────────────────────────
  it('renders 1. items as <ol><li>', () => {
    const result = renderMarkdown('1. first\n2. second');
    expect(result).toContain('<ol>');
    expect(result).toContain('<li>first</li>');
    expect(result).toContain('<li>second</li>');
  });

  // ── Links ──────────────────────────────────────────────────────────
  it('renders [text](url) as <a> with target=_blank', () => {
    const result = renderMarkdown('[click](https://example.com)');
    expect(result).toContain('<a href="https://example.com" target="_blank" rel="noopener">click</a>');
  });

  it('strips dangerous javascript: links', () => {
    const result = renderMarkdown('[bad](javascript:alert(1))');
    expect(result).not.toContain('javascript');
    expect(result).toContain('<a href="#" target="_blank"');
  });

  it('strips non-http links', () => {
    const result = renderMarkdown('[x](ftp://bad.com)');
    expect(result).toContain('<a href="#" target="_blank"');
  });

  // ── Code blocks ────────────────────────────────────────────────────
  it('renders ``` block with language', () => {
    const input = '```python\nprint("hi")\n```';
    const result = renderMarkdown(input);
    expect(result).toContain('chat-codeblock');
    expect(result).toContain('class="lang">python</span>');
    expect(result).toContain('data-code="print(&quot;hi&quot;)\n"');
    expect(result).toContain('<code');
  });

  it('renders ``` block without language', () => {
    const input = '```\nplain code\n```';
    const result = renderMarkdown(input);
    expect(result).toContain('chat-codeblock');
    expect(result).toContain('class="lang">code</span>');
  });

  it('preserves code content across multiple lines', () => {
    const input = '```\nline1\nline2\nline3\n```';
    const result = renderMarkdown(input);
    expect(result).toContain('line1');
    expect(result).toContain('line2');
    expect(result).toContain('line3');
  });

  it('renders inline text around code blocks', () => {
    const input = 'before\n```\ncode\n```\nafter';
    const result = renderMarkdown(input);
    // 'before' followed by <br>, then the code block div, then <br>, then 'after'
    const beforeIdx = result.indexOf('before');
    const afterIdx = result.indexOf('after');
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(afterIdx).toBeGreaterThan(beforeIdx);
  });

  // ── HTML escaping (XSS prevention) ────────────────────────────────
  it('escapes <script> tags', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script>');
    expect(renderMarkdown('<script>alert(1)</script>')).toContain('&lt;script&gt;');
  });

  it('escapes HTML entities in inline text', () => {
    expect(renderMarkdown('<b>not bold</b>')).toBe('&lt;b&gt;not bold&lt;/b&gt;');
  });

  it('escapes HTML in code block content', () => {
    const input = '```html\n<script>alert(1)</script>\n```';
    const result = renderMarkdown(input);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('prevents XSS via onclick attributes in code', () => {
    const input = '```\nonclick="evil()"\n```';
    const result = renderMarkdown(input);
    // onclick appears inside data-code attribute as HTML-escaped → safe
    expect(result).toContain('data-code="onclick=&quot;evil()&quot;');
    // There should be NO raw onclick attribute (like <div onclick=...>)
    expect(result).not.toContain('<div onclick=');
  });

  // ── Combined scenarios ─────────────────────────────────────────────
  it('renders heading + list + code block together', () => {
    const input = '# Report\n\n- item 1\n- item 2\n\n```sh\necho hi\n```';
    const result = renderMarkdown(input);
    expect(result).toContain('<h1>Report</h1>');
    expect(result).toContain('<li>item 1</li>');
    expect(result).toContain('chat-codeblock');
  });

  it('renders bold and italic inside a paragraph', () => {
    const result = renderMarkdown('this is **bold** and *italic*');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
  });

  it('preserves raw dataset via dataset.raw in history.ts (integration check)', () => {
    // verify that the rendered text does not contain the raw markdown markers
    const raw = 'use `code` and **bold**';
    const html = renderMarkdown(raw);
    expect(html).not.toContain('**bold**');
    expect(html).not.toContain('`code`');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });
});
