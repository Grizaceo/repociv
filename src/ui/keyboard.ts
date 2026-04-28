// ─── RepoCiv — Keyboard help & tooltip ───────────────────────────────────────

export function toggleKeyboardHelp(force?: boolean) {
  const el = document.getElementById('keyboard-help');
  if (!el) return;
  if (force === true) el.classList.remove('hidden');
  else if (force === false) el.classList.add('hidden');
  else el.classList.toggle('hidden');
}

export function showTooltip(text: string, x: number, y: number) {
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  tip.textContent = text;
  tip.style.left = `${x + 12}px`;
  tip.style.top = `${y - 8}px`;
  tip.classList.remove('hidden');
}

export function hideTooltip() {
  document.getElementById('tooltip')?.classList.add('hidden');
}
