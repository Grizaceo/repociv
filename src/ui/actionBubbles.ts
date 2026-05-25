import type { LocalUnit } from '../types.ts';

// ─── Action Bubbles — RimWorld-style DOM overlay (Phase 9) ────────────────────
// One floating div per visible agent, updated via transform each frame.
// Zero layout thrashing: only transform is mutated; text only on state change.

const IDLE_HIDE_MS = 3000;

interface BubbleEntry {
  el: HTMLDivElement;
  lastText: string;
  lastClass: string;
  idleSince: number; // 0 = not idle, else timestamp when idle started
}

const pool = new Map<string, BubbleEntry>();
let layer: HTMLDivElement | null = null;

export function initBubbleLayer(): void {
  if (layer && document.contains(layer)) return;
  layer = document.createElement('div');
  layer.id = 'action-bubbles-layer';
  const anchor = document.getElementById('main-canvas') ?? document.querySelector('canvas');
  (anchor?.parentElement ?? document.getElementById('app') ?? document.body).appendChild(layer);
}

function getBubbleText(unit: LocalUnit): string | null {
  switch (unit.state) {
    case 'working_on_file': {
      const label = unit.mission ? `⚙ ${unit.mission}` : '⚙ Trabajando...';
      return label.length > 24 ? label.slice(0, 23) + '…' : label;
    }
    case 'walking_to_workbench':
    case 'walking_to_room':
      return '🚶 Caminando...';
    case 'resting':
      return '💤';
    case 'idle_in_room':
    default:
      return null;
  }
}

function getBubbleClass(unit: LocalUnit): string {
  if (unit.state === 'working_on_file') return 'action-bubble working';
  if (unit.state === 'resting') return 'action-bubble resting';
  return 'action-bubble';
}

export function updateBubble(unit: LocalUnit, screenX: number, screenY: number): void {
  if (!layer) return;

  let entry = pool.get(unit.id);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'action-bubble';
    layer.appendChild(el);
    entry = { el, lastText: '', lastClass: 'action-bubble', idleSince: 0 };
    pool.set(unit.id, entry);
  }

  // Position update — only mutates transform, no layout recalc
  entry.el.style.transform = `translate(calc(${screenX}px - 50%), calc(${screenY}px - 110%))`;

  const text = getBubbleText(unit);

  if (text === null) {
    // Track how long the unit has been idle
    if (entry.idleSince === 0) entry.idleSince = Date.now();
    if (Date.now() - entry.idleSince > IDLE_HIDE_MS) {
      entry.el.style.opacity = '0';
    }
    return;
  }

  // Unit is active — reset idle timer, ensure visible
  entry.idleSince = 0;
  entry.el.style.opacity = '';

  // Only touch className and textContent when they change
  const cls = getBubbleClass(unit);
  if (cls !== entry.lastClass) {
    entry.el.className = cls;
    entry.lastClass = cls;
  }
  if (text !== entry.lastText) {
    entry.el.textContent = text;
    entry.lastText = text;
  }
}

export function hideBubble(unitId: string): void {
  const entry = pool.get(unitId);
  if (entry) entry.el.style.opacity = '0';
}

export function clearAllBubbles(): void {
  pool.forEach(({ el }) => el.remove());
  pool.clear();
  layer?.remove();
  layer = null;
}
