// ─── RepoCiv — Unit panel & hero bar (Civ V Aesthetic) ─────────────────────────
import type { GameState } from '../game.ts';
import type { Unit, UnitState } from '../types.ts';
import { cfg } from '../gameConfig.ts';
import { renderCapabilityBadges, clearCapabilityBadges } from './capabilityBadges.ts';

function unitStateColor(state: UnitState): string {
  const colors: Record<UnitState, string> = {
    idle: 'var(--gold-mid, #c8a84b)',
    moving: 'var(--blue-mid, #5b9bd5)',
    working: 'var(--green-mid, #4caf50)',
    sleeping: 'var(--purple-mid, #9b5bd4)',
    building: 'var(--orange-mid, #ff9800)',
  };
  return colors[state] ?? '#888';
}

function unitModelLabel(unit: Unit): string {
  const labels: Record<string, string> = {
    hero: 'Agente Principal',
    worker: 'Worker',
    scout: 'Scout',
    army: 'Ejército',
    caravan: 'Caravana',
    lexo: 'LexO-α',
    openclaw: 'OpenClaw',
  };
  return labels[unit.type] ?? unit.type;
}

export function showUnitPanel(unit: Unit) {
  const panel = document.getElementById('unit-panel');
  if (!panel) return;
  panel.classList.remove('hidden');

  const sprite = document.getElementById('unit-sprite');
  if (sprite) {
    sprite.textContent = unit.name[0] ?? '?';
    sprite.style.background = unit.color;
    sprite.style.borderColor = 'var(--gold-mid)';
  }

  const setText = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText('unit-name', unit.name.toUpperCase());
  setText('unit-mission', unit.mission ? `"${unit.mission}"` : '"Esperando órdenes..."');
  setText('unit-moves', `${unit.movesLeft}/${unit.maxMoves} mov`);
  setText('unit-model', unitModelLabel(unit));

  const fill = document.getElementById('unit-moves-fill');
  if (fill) fill.style.width = `${(unit.movesLeft / unit.maxMoves) * 100}%`;

  const dot = document.getElementById('unit-status-dot');
  if (dot) dot.style.background = unitStateColor(unit.state);

  renderCapabilityBadges(unit);
}



export function hideUnitPanel() {
  document.getElementById('unit-panel')?.classList.add('hidden');
  clearCapabilityBadges();
}

export function renderHeroBar(state: GameState, onSelect: (u: Unit) => void) {
  const slots = document.getElementById('hero-bar-slots');
  if (!slots) return;

  const heroes = state.getAllUnits().slice(0, 9);

  // Limpieza simple para permitir auto-animate en el contenedor
  slots.innerHTML = '';

  heroes.forEach((unit, idx) => {
    const slot = document.createElement('div');
    slot.className = 'hero-slot';
    if (state.selectedUnit?.id === unit.id) slot.classList.add('selected');

    // Phase 9: fatigue bar — color shifts green→yellow→red as fatigue drops
    // Thresholds now driven by gameConfig.ts (Phase 10.2)
    const pct = unit.fatigue / unit.maxFatigue;
    const { warnThreshold, criticalThreshold } = cfg.fatigue;
    const fbar = pct > criticalThreshold ? '#4caf50' : pct > warnThreshold ? '#ff9800' : '#f44336';
    const fPct = Math.round(pct * 100);
    const restBadge = unit.isResting
      ? `<span class="fatigue-rest-badge" title="${unit.name} descansando">☕</span>`
      : '';

    slot.innerHTML = `
      <span class="slot-num">${idx + 1}</span>
      <span class="hero-slot-sprite">${unit.name[0]}</span>
      <span class="slot-state" style="background:${unitStateColor(unit.state)}"></span>
      <div class="hero-fatigue-wrap" title="Contexto: ${fPct}%">
        <div class="hero-fatigue-bar" style="width:${fPct}%;background:${fbar}"></div>
      </div>
      ${restBadge}
    `;

    slot.title = `${unit.name} — ${unit.state} | Contexto ${fPct}%${unit.isResting ? ' (descansando)' : ''}`;
    slot.addEventListener('click', () => onSelect(unit));
    slots.appendChild(slot);
  });
}
