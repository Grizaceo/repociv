// ─── RepoCiv — Unit panel & hero bar (Civ V Aesthetic) ─────────────────────────
import type { GameState } from '../game.ts';
import type { Unit, UnitState } from '../types.ts';
import { cfg } from '../gameConfig.ts';
import { escapeHtml } from './escapeHtml.ts';
import { agentTooltip } from './agentGlossary.ts';
import { heroBarVisible, heroBarOverflowCount, heroBarRoster } from './heroBarUnits.ts';
import { renderCapabilityBadges, clearCapabilityBadges } from './capabilityBadges.ts';
import {
  renderOrdenDeBatalla,
  hideOrdenDeBatalla,
  setOrdenHighlightCallback,
} from './ordenDeBatalla.ts';

setOrdenHighlightCallback((unitId) => {
  const ev = new CustomEvent('repociv:highlight-unit', { detail: { unitId } });
  window.dispatchEvent(ev);
});

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

export function showUnitPanel(unit: Unit, state?: GameState) {
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
  if (state) renderOrdenDeBatalla(state, unit);
}

export function hideUnitPanel() {
  document.getElementById('unit-panel')?.classList.add('hidden');
  clearCapabilityBadges();
  hideOrdenDeBatalla();
}

/** Role icons. Drawn, not typed: two agents whose names both start with "W"
 *  used to render as two identical "W" boxes. */
const ROLE_ICONS: Record<string, string> = {
  hero: '<path d="M8 2.4V13.6M3.2 5.2 12.8 10.8M3.2 10.8 12.8 5.2"/>',
  worker:
    '<circle cx="8" cy="8" r="2.6"/><path d="M12.2 8H14M10.1 11.64 11 13.2M5.9 11.64 5 13.2M3.8 8H2M5.9 4.36 5 2.8M10.1 4.36 11 2.8"/>',
  scout: '<circle cx="7.2" cy="7.2" r="4"/><path d="M10.2 10.2 14 14"/>',
  praetorian: '<path d="M8 2 13.5 4.2V8.4C13.5 11.4 11 13.4 8 14.4 5 13.4 2.5 11.4 2.5 8.4V4.2Z"/>',
  cli: '<path d="M3.5 4.5 7 8 3.5 11.5M8.5 12.5H13"/>',
};

const ROLE_BY_TYPE: Record<string, keyof typeof ROLE_ICONS> = {
  hero: 'hero',
  worker: 'worker',
  army: 'worker',
  caravan: 'worker',
  scout: 'scout',
  praetorian: 'praetorian',
  claude: 'cli',
  codex: 'cli',
  cursor: 'cli',
  openclaw: 'cli',
  lexo: 'cli',
};

function roleIcon(unit: Unit): string {
  const shape = ROLE_ICONS[ROLE_BY_TYPE[unit.type] ?? 'worker'] ?? ROLE_ICONS['worker'];
  return `<svg class="chip-ico" viewBox="0 0 16 16" aria-hidden="true">${shape}</svg>`;
}

/** Remaining context as a fraction, plus the band it falls in. One scale, read
 *  one way: 1 = fresh, 0 = exhausted, and each threshold is a floor. */
function contextBand(unit: Unit): { pct: number; color: string; band: 'ok' | 'warn' | 'critical' } {
  const pct = unit.maxFatigue > 0 ? unit.fatigue / unit.maxFatigue : 0;
  const { warnThreshold, criticalThreshold } = cfg.fatigue;
  if (pct > warnThreshold) return { pct, color: '#4caf50', band: 'ok' };
  if (pct > criticalThreshold) return { pct, color: '#ff9800', band: 'warn' };
  return { pct, color: '#f44336', band: 'critical' };
}

function chipSubtitle(unit: Unit): string {
  const parts: string[] = [];
  if (unit.tier) parts.push(unit.tier);
  else parts.push(unitModelLabel(unit));
  if (unit.isResting) parts.push('descansa');
  if (unit.hidden) parts.push('oculto');
  return parts.join(' · ');
}

export function renderHeroBar(state: GameState, onSelect: (u: Unit) => void) {
  const slots = document.getElementById('hero-bar-slots');
  if (!slots) return;

  const heroes = heroBarVisible(state);
  const overflow = heroBarOverflowCount(state);

  const zone = document.getElementById('hero-bar-zone');
  if (zone)
    zone.textContent = heroes.length ? `En campo · ${heroBarRoster(state).length}` : 'En campo';
  const hint = document.getElementById('hero-bar-hint');
  if (hint) hint.classList.toggle('hidden', heroes.length === 0);

  slots.innerHTML = '';

  // Empty bar teaches the next action instead of showing a blank strip.
  if (heroes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hero-empty';
    empty.innerHTML = `
      <svg class="hero-empty-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6 13.6 4.8V11.2L8 14.4 2.4 11.2V4.8Z"/></svg>
      <div class="hero-empty-copy">
        <span class="hero-empty-title">Sin agentes en campo</span>
        <span class="hero-empty-hint">Apretá <kbd>Q</kbd> para desplegar el agente principal, o elegí una plantilla abajo.</span>
      </div>
    `;
    slots.appendChild(empty);
    return;
  }

  heroes.forEach((unit, idx) => {
    const { pct, color, band } = contextBand(unit);
    const fPct = Math.round(pct * 100);

    const chip = document.createElement('div');
    chip.className = 'hero-chip';
    chip.dataset['unitId'] = unit.id;
    if (state.selectedUnit?.id === unit.id) chip.classList.add('selected');
    if (unit.hidden) chip.classList.add('hidden-unit');
    chip.style.borderLeftColor = unitStateColor(unit.state);

    // The number is only meaningful because heroBarVisible is also what the
    // 1–9 hotkeys index — see heroBarUnits.ts.
    const numberBadge = idx < 9 ? `<span class="chip-kbd">${idx + 1}</span>` : '';
    const pctReadout =
      band === 'ok' ? '' : `<span class="chip-pct" style="color:${color}">${fPct}%</span>`;

    chip.innerHTML = `
      ${roleIcon(unit)}
      <div class="chip-meat">
        <div class="chip-name">${escapeHtml(unit.name)}</div>
        <div class="chip-sub-row">
          <span class="chip-sub">${escapeHtml(chipSubtitle(unit))}</span>
          ${pctReadout}
        </div>
      </div>
      ${numberBadge}
      <div class="chip-ctx"><div class="chip-ctx-fill" style="width:${fPct}%;background:${color}"></div></div>
    `;

    chip.title = `${unit.name} — ${unit.state} | Contexto ${fPct}%${unit.isResting ? ' (descansando)' : ''}${unit.hidden ? ' | Oculto del mapa (clic para mostrar)' : ''}\n${agentTooltip(unit.type)}`;
    chip.addEventListener('click', () => onSelect(unit));
    slots.appendChild(chip);
  });

  // Nobody falls out of the UI silently: the rest sit behind one chip.
  if (overflow > 0) {
    const more = document.createElement('div');
    more.className = 'hero-chip-more';
    more.textContent = `+${overflow}`;
    more.title = `${overflow} agente(s) más — Tab cicla por todos`;
    slots.appendChild(more);
  }
}
