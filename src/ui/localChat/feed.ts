// ─── Local view chat: the phone-style feed ──────────────────────────────────
// A second presentation of the SAME transcript the side panel shows. Not a
// redesign of RepoCiv's chat: same chatHistory, same chat chunks, different
// skin — because in the local view the context is a single repo and the
// transcript has to compete for attention with the map sitting next to it.
//
// The markup itself is pure (see thread.ts) so the presentation is testable
// without a DOM; this module only owns the element, the subscription and the
// scroll position.

import { chatHistory } from '../chat/state.ts';
import { subscribeChatChunks } from '../chat/history.ts';
import { renderMarkdown } from '../chat/markdown.ts';
import {
  officeChatKeys,
  threadHtml,
  emptyStateHtml,
  agentChipsHtml,
  type MarkdownRenderer,
} from './thread.ts';
import type { LocalUnit } from '../../types.ts';

const LAYER_ID = 'local-chat-feed';

export interface LocalChatHandle {
  /** Point the feed at a different office. Cheap; safe to call repeatedly. */
  setUnits(units: LocalUnit[]): void;
  /** Detach listeners and remove the DOM. */
  destroy(): void;
}

/** Injected by tests; the app uses the real chat modules. */
export interface LocalChatDeps {
  chatHistoryRef: typeof chatHistory;
  subscribe: typeof subscribeChatChunks;
  renderMarkdown: MarkdownRenderer;
  /** Injected so the feed can be tested without a DOM. */
  doc?: Document;
}

const defaultDeps: LocalChatDeps = {
  chatHistoryRef: chatHistory,
  subscribe: subscribeChatChunks,
  renderMarkdown: renderMarkdown as MarkdownRenderer,
};

export function mountLocalChat(
  getUnits: () => LocalUnit[],
  deps: LocalChatDeps = defaultDeps,
): LocalChatHandle {
  const doc = deps.doc ?? document;
  const host = deps.chatHistoryRef;
  let units: LocalUnit[] = getUnits();
  let frame = 0;

  let root = doc.getElementById(LAYER_ID);
  if (!root) {
    root = doc.createElement('div');
    root.id = LAYER_ID;
    root.className = 'local-chat';
    root.setAttribute('role', 'log');
    root.setAttribute('aria-label', 'Transcripción del sector local');
    doc.body.appendChild(root);
  }
  root.innerHTML =
    '<header class="local-chat-head"><span class="local-chat-title">REGISTRO</span>' +
    '<span class="local-chat-agents"></span></header>' +
    '<div class="local-chat-body"></div>';

  const body = root.querySelector<HTMLElement>('.local-chat-body')!;
  const agents = root.querySelector<HTMLElement>('.local-chat-agents')!;

  function render(): void {
    frame = 0;
    const keys = officeChatKeys(units);
    agents.innerHTML = agentChipsHtml(keys);
    const html = threadHtml(keys, (key) => host.get(key) ?? [], deps.renderMarkdown);
    body.innerHTML = html || emptyStateHtml(keys);
    body.scrollTop = body.scrollHeight;
  }

  /** Coalesce a burst of chunks into a single paint. */
  function schedule(): void {
    if (frame) return;
    frame = requestAnimationFrame(render);
  }

  const unsubscribe = deps.subscribe((unitId) => {
    // A chunk for someone outside this office must not repaint our feed.
    if (!officeChatKeys(units).includes(unitId)) return;
    schedule();
  });

  render();

  return {
    setUnits(next: LocalUnit[]): void {
      units = next;
      schedule();
    },
    destroy(): void {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      root?.remove();
    },
  };
}

/** Remove the feed if present. Safe to call when it was never mounted. */
export function unmountLocalChat(doc: Document = document): void {
  doc.getElementById(LAYER_ID)?.remove();
}
