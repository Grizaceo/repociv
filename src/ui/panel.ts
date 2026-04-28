// ─── RepoCiv — Unit panel & hero bar (Civ V Aesthetic) ─────────────────────────
import type { GameState } from '../game.ts';
import type { Unit } from '../types.ts';
import { cfg } from '../gameConfig.ts';

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
}

export function unitModelLabel(unit: Unit): string {
  const base = unit.id.split('-')[0]?.toUpperCase();
  if (base === 'DAVI')   return 'Héroe · Mimo Técnico';
  if (base === 'WORKER') return 'Agente · Constructor';
  if (base === 'SCOUT')  return 'Explorador · Analista';
  if (base === 'LEXO')   return 'Consejero · LexO-α';
  if (base === 'OPENCLAW') return 'Guardián · OpenClaw';
  return unit.type;
}

export function unitStateColor(state: Unit['state']): string {
  return state === 'working' ? 'var(--civ-science)' :
         state === 'moving'  ? 'var(--civ-gold)' :
         state === 'sleeping'? '#444' :
         state === 'building'? 'var(--civ-production)' : 'var(--state-info)';
}

export function hideUnitPanel() {
  document.getElementById('unit-panel')?.classList.add('hidden');
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
