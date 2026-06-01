// ─── Hero selection + agent spawning ────────────────────────────────────────
import { type Unit } from '../../types.ts';
import { type Renderer } from '../../renderer.ts';
import { type GameState } from '../../game.ts';
import { type BridgeEvents } from '../../bridge.ts';
import {
  showUnitPanel,
  renderHeroBar,
  openSidePanel,
  isSidePanelOpen,
  loadGitInfo,
  loadFilesInfo,
  getSelectedConfig,
  persistSelection,
} from '../index.ts';

export function selectHero(
  unit: Unit,
  renderer: Renderer,
  state: GameState,
  _bridge: BridgeEvents,
): void {
  state.selectUnit(unit);
  renderer.selectUnit(unit);
  showUnitPanel(unit);
  renderHeroBar(state, (u) => selectHero(u, renderer, state, _bridge));

  // Auto-open side panel & load city context if hero is on a city
  if (isSidePanelOpen()) {
    openSidePanel(unit);
    const cityHere = state.world.cities.find(
      (c) => c.coord.q === unit.coord.q && c.coord.r === unit.coord.r,
    );
    if (cityHere) {
      loadGitInfo(cityHere.id);
      loadFilesInfo(cityHere.id);
    }
  }
}

// ─── Multi-spawn counter ─────────────────────────────────────────────────────
const spawnCounters: Record<string, number> = {};

function getNextUnitId(base: string): string {
  spawnCounters[base] = (spawnCounters[base] ?? 0) + 1;
  return spawnCounters[base] === 1 ? base : `${base}-${spawnCounters[base]}`;
}

// ─── Spawn an agent at the capital (or near existing units) ─────────────────
export function spawnAgent(
  base: string,
  state: GameState,
  renderer: Renderer,
  bridge: BridgeEvents,
): void {
  // If base unit (no suffix) exists and is idle, just select it instead of spawning another
  const baseUnit = state.getUnit(base);
  if (baseUnit && baseUnit.state === 'idle' && !state.getUnit(`${base}-2`)) {
    selectHero(baseUnit, renderer, state, bridge);
    return;
  }

  const unitId = getNextUnitId(base);
  const capital = state.world.cities.find((c) => c.isCapital) ?? state.world.cities[0];
  const existingCount = state.getAllUnits().filter((u) => u.id.startsWith(base)).length;
  const offset = existingCount % 6;
  const coord = capital
    ? { q: capital.coord.q + 1 + (offset % 3), r: capital.coord.r - Math.floor(offset / 3) }
    : { q: 1 + offset, r: 0 };

  const typeMap: Record<string, 'hero' | 'worker' | 'scout' | 'lexo' | 'claude' | 'codex'> = {
    DAVI: 'hero',
    WORKER: 'worker',
    SCOUT: 'scout',
    LEXO: 'lexo',
    OPENCLAW: 'hero',
    CLAUDE: 'claude',
    CODEX: 'codex',
  };
  const type = typeMap[base] ?? 'hero';
  const unit = state.spawnUnit(unitId, unitId, type, 'gris', coord, 'En espera de misión');

  // Seed harness default for units that map 1:1 to a harness selector
  if (base === 'CODEX') {
    try {
      localStorage.setItem(`repociv:chatConfig:${unitId}`, JSON.stringify({ harness: 'codex', provider: '', model: '' }));
    } catch {
      // ignore
    }
  }

  selectHero(unit, renderer, state, bridge);
}
