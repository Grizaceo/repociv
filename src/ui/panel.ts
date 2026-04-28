// ─── RepoCiv — Unit panel & hero bar ─────────────────────────────────────────
import type { GameState } from '../game.ts';
import type { Unit } from '../types.ts';

export function showUnitPanel(unit: Unit) {
  const panel = document.getElementById('unit-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  const sprite = document.getElementById('unit-sprite');
  if (sprite) {
    sprite.textContent = unit.name[0] ?? '?';
    sprite.style.background = unit.color;
    sprite.style.color = '#1a1208';
    if (unit.state === 'working') sprite.classList.add('working');
    else sprite.classList.remove('working');
  }
  const setText = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText('unit-name', unit.name);
  setText('unit-state-text', unit.state);
  setText('unit-mission', unit.mission ?? 'Sin misión');
  setText('unit-moves', `${unit.movesLeft}/${unit.maxMoves} mov`);
  setText('unit-model', unitModelLabel(unit));

  const fill = document.getElementById('unit-moves-fill');
  if (fill) fill.style.width = `${(unit.movesLeft / unit.maxMoves) * 100}%`;

  const dot = document.getElementById('unit-status-dot');
  if (dot) dot.style.background = unitStateColor(unit.state);
}

export function unitModelLabel(unit: Unit): string {
  const base = unit.id.split('-')[0]?.toUpperCase();
  if (base === 'DAVI')     return 'mimo · técnico';
  if (base === 'WORKER')   return 'fluido · conciso';
  if (base === 'SCOUT')    return 'analítico · útil';
  if (base === 'LEXO')     return 'lexo-alpha · analítico';
  if (base === 'OPENCLAW') return 'openclaw · local';
  return unit.type;
}

export function unitStateColor(state: Unit['state']): string {
  return state === 'working' ? '#5b9bd5' :
         state === 'moving'  ? '#c8a84b' :
         state === 'sleeping'? '#444'    :
         state === 'building'? '#5b9b5b' : '#888';
}

export function hideUnitPanel() {
  document.getElementById('unit-panel')?.classList.add('hidden');
}

export function renderHeroBar(state: GameState, onSelect: (u: Unit) => void) {
  const slots = document.getElementById('hero-bar-slots');
  if (!slots) return;
  slots.innerHTML = '';
  const heroes = state.getAllUnits().slice(0, 9);
  heroes.forEach((unit, idx) => {
    const slot = document.createElement('div');
    slot.className = 'hero-slot';
    if (state.selectedUnit?.id === unit.id) slot.classList.add('selected');
    slot.style.background = `linear-gradient(135deg, ${unit.color}33, ${unit.color}11)`;
    slot.style.color = unit.color;
    slot.title = `${unit.name} — ${unit.state} (${idx + 1})`;
    slot.innerHTML = `
      <span class="slot-num">${idx + 1}</span>
      <span class="slot-letter">${unit.name[0]}</span>
      <span class="slot-state ${unit.state}"></span>
    `;
    slot.addEventListener('click', () => onSelect(unit));
    slots.appendChild(slot);
  });
}
