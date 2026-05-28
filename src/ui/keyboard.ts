// ─── RepoCiv — Keyboard help & tooltip ───────────────────────────────────────
import { trapFocus } from './focusTrap.ts';

let _kbhCleanup: (() => void) | null = null;

export function toggleKeyboardHelp(force?: boolean) {
  const el = document.getElementById('keyboard-help');
  if (!el) return;
  const wasHidden = el.classList.contains('hidden');
  if (force === true) el.classList.remove('hidden');
  else if (force === false) el.classList.add('hidden');
  else el.classList.toggle('hidden');
  const nowHidden = el.classList.contains('hidden');
  if (wasHidden && !nowHidden) {
    _kbhCleanup?.();
    _kbhCleanup = trapFocus(el);
  } else if (!wasHidden && nowHidden) {
    _kbhCleanup?.();
    _kbhCleanup = null;
  }
}
