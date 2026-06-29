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
} from '../index.ts';
import { type RepoCivProfile, type HarnessId, getProfiles } from '../../agentProfile.ts';

export function selectHero(
  unit: Unit,
  renderer: Renderer,
  state: GameState,
  _bridge: BridgeEvents,
): void {
  state.selectUnit(unit);
  renderer.selectUnit(unit);
  showUnitPanel(unit, state);
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

// ─── Spawn from a RepoCivProfile ─────────────────────────────────────────────
export function spawnFromProfile(
  profile: RepoCivProfile,
  state: GameState,
  renderer: Renderer,
  bridge: BridgeEvents,
): void {
  const base = profile.name.toUpperCase();
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

  // Map harness to unit type
  const typeMap: Record<string, Unit['type']> = {
    claude: 'claude',
    codex: 'codex',
    cursor: 'cursor',
    hermes: 'hero',
    openclaw: 'hero',
  };
  const type = typeMap[profile.harness] ?? 'hero';
  const unit = state.spawnUnit(
    unitId,
    profile.display_name ?? unitId,
    type,
    'capital',
    coord,
    'En espera de misión',
  );

  // Persist harness / model config for the chat panel
  try {
    localStorage.setItem(
      `repociv:chatConfig:${unitId}`,
      JSON.stringify({
        harness: profile.harness,
        provider: profile.provider ?? '',
        model: profile.model ?? '',
      }),
    );
  } catch {
    // ignore
  }

  selectHero(unit, renderer, state, bridge);
}

/** Spawn from the registry profile for a harness (O/C/X templates), or fallback to legacy spawn. */
export async function spawnHarnessTemplate(
  harness: HarnessId,
  legacyType: string,
  state: GameState,
  renderer: Renderer,
  bridge: BridgeEvents,
): Promise<void> {
  try {
    const profiles = await getProfiles();
    const match = Object.values(profiles).find((p) => p.harness === harness);
    if (match) {
      spawnFromProfile(match, state, renderer, bridge);
      return;
    }
  } catch {
    // registry unavailable — fall back
  }
  spawnAgent(legacyType, state, renderer, bridge);
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

  const typeMap: Record<string, Unit['type']> = {
    CLAUDE: 'claude',
    CODEX: 'codex',
    CURSOR: 'cursor',
  };
  const type = typeMap[base] ?? 'hero';
  const unit = state.spawnUnit(unitId, unitId, type, 'capital', coord, 'En espera de misión');

  if (base === 'CODEX' || base === 'CURSOR') {
    const harnessKey = base === 'CODEX' ? 'codex' : 'cursor';
    try {
      localStorage.setItem(
        `repociv:chatConfig:${unitId}`,
        JSON.stringify({ harness: harnessKey, provider: '', model: '' }),
      );
    } catch {
      // ignore
    }
  }

  selectHero(unit, renderer, state, bridge);
}
