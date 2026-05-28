// ─── RepoCiv — Shared panel shell helpers ────────────────────────────────────
// Tiny DOM helpers for modal-like overlay panels.

export function ensurePanel(id: string, className: string, html: string): HTMLElement {
  const existing = document.getElementById(id);
  if (existing) return existing as HTMLElement;
  const el = document.createElement('div');
  el.id = id;
  el.className = className;
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

export function showPanel(panel: HTMLElement) {
  panel.classList.remove('hidden');
}

export function hidePanel(panel: HTMLElement) {
  panel.classList.add('hidden');
}

export function bindPanelAction(panel: HTMLElement, selector: string, handler: () => void): void {
  panel.querySelector(selector)?.addEventListener('click', handler);
}
