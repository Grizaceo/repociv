// ─── Shared helpers for spatialPreview submodules ──────────────────────────

export function escapeHtml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function positionEl(el: HTMLElement, pos: { x: number; y: number }): void {
  // Show near cursor, nudge to stay in viewport
  el.style.position = 'fixed';
  el.style.left = '0';
  el.style.top = '0';
  el.style.visibility = 'hidden';
  el.classList.remove('hidden');

  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const MARGIN = 12;

  let x = pos.x + 16;
  let y = pos.y - rect.height / 2;
  if (x + rect.width > vw - MARGIN) x = pos.x - rect.width - 16;
  if (y + rect.height > vh - MARGIN) y = vh - rect.height - MARGIN;
  if (y < MARGIN) y = MARGIN;

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.visibility = 'visible';
}

export function gestureIcon(g: string): string {
  if (g === 'drag_unit_to_city') return '→';
  if (g === 'drag_city_to_city') return '⇌';
  if (g === 'area_select') return '▣';
  if (g === 'right_click') return '◈';
  return '⬡';
}

export function riskStyle(risk: string): [string, string] {
  if (risk === 'destructive') return ['#d44b4b', '☠ DESTRUCTIVO'];
  if (risk === 'high') return ['#e8a040', '⚠ ALTO'];
  if (risk === 'medium') return ['#c8a84b', '◆ MEDIO'];
  return ['#5b9b5b', '● BAJO'];
}
