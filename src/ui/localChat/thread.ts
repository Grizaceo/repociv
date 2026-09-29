// ─── Local view chat: pure logic ────────────────────────────────────────────
// The local chat is a second presentation of the SAME transcript the side
// panel shows. These helpers decide *which* threads belong to the office and
// how a thread is shaped for the phone-style feed; nothing here touches the DOM.

import type { LocalUnit } from '../../types.ts';
import type { ChatMessage } from '../chat/state.ts';

export interface OfficeThread {
  /** Key into chatHistory — the unit id the bridge keys chat on. */
  key: string;
  /** Short label for the feed header. */
  label: string;
  messages: ChatMessage[];
}

/**
 * Chat keys for the office transcript.
 *
 * The thread you talk to is the non-ephemeral unit (the hero). Subagents are
 * ephemeral delegates whose output arrives through the parent's thread, so
 * listing them here would duplicate the same conversation twice.
 */
export function officeChatKeys(units: LocalUnit[]): string[] {
  const keys: string[] = [];
  for (const u of units) {
    if (u.ephemeral) continue;
    const key = u.id || u.macroUnitId;
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** "WORKER-1" / "main" → "M". Used for the feed's avatar chip. */
export function initialsOf(label: string): string {
  const cleaned = (label ?? '').trim();
  if (!cleaned) return '?';
  return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Drop the trailing empty agent message.
 *
 * appendUserMessage pushes an empty agent slot to start streaming the reply,
 * so a thread that has not received its first chunk ends in `role: 'agent',
 * text: ''`. The phone feed should read as a phone: no dangling empty bubble.
 */
export function visibleMessages(messages: ChatMessage[]): ChatMessage[] {
  const out = messages.slice();
  const last = out[out.length - 1];
  if (last && last.role === 'agent' && last.text.trim() === '') out.pop();
  return out;
}

/** True when the thread has nothing worth showing yet. */
export function isEmptyThread(messages: ChatMessage[]): boolean {
  return visibleMessages(messages).length === 0;
}

// ─── Markup ─────────────────────────────────────────────────────────────────
// The feed's HTML is built as a pure string, not imperatively: this repo has no
// DOM unit-test environment (no jsdom — DOM behaviour is covered by the
// Playwright specs), so the presentation is kept testable as data. feed.ts
// assigns the result to innerHTML and owns the scroll position.

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `md` renders a message body. Passed in so this module stays DOM-free and
 *  the real renderer (markdown + escaping) is injected by the caller. */
export type MarkdownRenderer = (text: string) => string;

export function agentChipsHtml(keys: string[]): string {
  return keys
    .map(
      (k) =>
        `<span class="local-chat-agent"><i>${escapeText(initialsOf(k))}</i>${escapeText(k.toUpperCase())}</span>`,
    )
    .join('');
}

export function threadHtml(
  keys: string[],
  getMessages: (key: string) => ChatMessage[],
  md: MarkdownRenderer,
): string {
  const blocks: string[] = [];
  for (const key of keys) {
    const messages = getMessages(key);
    if (isEmptyThread(messages)) continue;
    for (const m of visibleMessages(messages)) {
      const side = m.role === 'user' ? 'user' : 'agent';
      const who = m.role === 'user' ? 'TÚ' : key.toUpperCase();
      // User text is escaped: the side panel does the same, and a local-view
      // feed must not become an injection surface just because it is prettier.
      const bodyHtml = m.role === 'user' ? escapeText(m.text) : md(m.text);
      blocks.push(
        `<article class="local-chat-msg ${side}" data-unit="${escapeText(key)}">` +
          `<div class="local-chat-meta"><span>${escapeText(who)}</span>` +
          `<time>${escapeText(m.timestamp)}</time></div>` +
          `<div class="local-chat-bubble">${bodyHtml}</div>` +
          `</article>`,
      );
    }
  }
  return blocks.join('');
}

/** Placeholder shown when the office has nobody, or nobody has spoken. */
export function emptyStateHtml(keys: string[]): string {
  return keys.length === 0
    ? '<p class="local-chat-empty">Sin agentes en el sector.</p>'
    : '<p class="local-chat-empty">Sin actividad todavía.</p>';
}
