// ─── Clipboard + copy-button helpers ────────────────────────────────────────
import { chatBuffers } from './state.ts';

export const COPY_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
export const CHECK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';

export function clipboardWrite(text: string): boolean {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Returns true if the text contains a transport error marker. */
export function hasErrorLine(text: string): boolean {
  return /\[(?:hermes|openclaw) error\]/i.test(text);
}

/** Extracts the first error line from the message text. */
export function extractErrorLine(text: string): string {
  const m = text.match(/\[(?:hermes|openclaw) error\].*?(?:\n|$)/i);
  return m ? m[0] : '';
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

// ─── One-shot listener attachment (idempotent) ───────────────────────────────
const _wired = new WeakMap<HTMLElement, { full: boolean; err: boolean; code: boolean }>();

export function attachCopyListeners(root: HTMLElement, unitId: string): void {
  // Full-message copy buttons
  for (const btn of root.querySelectorAll<HTMLElement>('.chat-copy-btn')) {
    const state = _wired.get(btn) ?? { full: false, err: false, code: false };
    if (state.full) continue;
    state.full = true;
    _wired.set(btn, state);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const msg = btn.closest<HTMLElement>('.chat-msg');
      if (!msg) return;
      const isLive = msg.id === `chat-current-${unitId}`;
      const text = isLive
        ? (chatBuffers.get(unitId) ?? '')
        : (msg.dataset['raw'] ?? msg.textContent ?? '');
      clipboardWrite(text);
      const orig = btn.innerHTML;
      btn.innerHTML = CHECK_SVG;
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.classList.remove('copied');
      }, 1500);
    });
  }

  // Error-only copy buttons
  for (const btn of root.querySelectorAll<HTMLElement>('.chat-error-btn')) {
    const state = _wired.get(btn) ?? { full: false, err: false, code: false };
    if (state.err) continue;
    state.err = true;
    _wired.set(btn, state);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const msg = btn.closest<HTMLElement>('.chat-msg');
      if (!msg) return;
      const text = msg.dataset['raw'] ?? msg.textContent ?? '';
      const line = extractErrorLine(text);
      if (line) {
        clipboardWrite(line);
        const orig = btn.textContent;
        btn.textContent = '¡Copiado!';
        setTimeout(() => {
          btn.textContent = orig;
        }, 1500);
      }
    });
  }

  // Code-block copy buttons (.chat-code-copy)
  for (const btn of root.querySelectorAll<HTMLElement>('.chat-code-copy')) {
    const state = _wired.get(btn) ?? { full: false, err: false, code: false };
    if (state.code) continue;
    state.code = true;
    _wired.set(btn, state);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = btn.dataset['code'] ?? '';
      if (!code) return;
      clipboardWrite(code);
      const orig = btn.innerHTML;
      btn.innerHTML = CHECK_SVG;
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.classList.remove('copied');
      }, 1500);
    });
  }
}
