// ─── RepoCiv — Focus Trap utility ────────────────────────────────────────────
// Keeps keyboard focus inside a modal/panel while it is open.
// Returns a cleanup function that removes the trap.

const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
}

/**
 * Traps Tab/Shift+Tab focus within `container`.
 * Moves focus to the first focusable child immediately.
 * Returns a cleanup function to release the trap.
 */
export function trapFocus(container: HTMLElement): () => void {
  const focusable = getFocusable(container);
  focusable[0]?.focus();

  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const els = getFocusable(container);
    if (els.length === 0) return;
    const first = els[0]!;
    const last = els[els.length - 1]!;

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}
