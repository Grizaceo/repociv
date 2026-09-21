// ─── Hero selection + agent spawning ────────────────────────────────────────
import { type Unit, type City } from '../../types.ts';
import { type Renderer } from '../../renderer.ts';
import { type GameState } from '../../game.ts';
import { type BridgeEvents } from '../../bridge.ts';
import {
  showUnitPanel,
  openSidePanel,
  isSidePanelOpen,
  loadGitInfo,
  loadFilesInfo,
} from '../index.ts';
import {
  type RepoCivProfile,
  type HarnessId,
  getProfiles,
  nativeProfileFor,
} from '../../agentProfile.ts';

export function selectHero(
  unit: Unit,
  renderer: Renderer,
  state: GameState,
  _bridge: BridgeEvents,
): void {
  // Selecting a hidden unit from the hero bar restores it on the map.
  if (unit.hidden) state.unhideUnit(unit.id);
  state.selectUnit(unit);
  renderer.selectUnit(unit);
  showUnitPanel(unit, state);

  // Only sync chat when the side panel is already open. Map-only clicks must
  // not overwrite the active chat tab (that sent SCOUT replies into MAIN).
  if (isSidePanelOpen()) {
    void openSidePanel(unit);
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
    praetorian: 'praetorian',
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

  // Persist harness / model / native profile for the chat panel. Without the
  // profile, a "➕ Bot" unit (e.g. cobalt) chatted through the main Hermes
  // profile instead of its own.
  try {
    localStorage.setItem(
      `repociv:chatConfig:${unitId}`,
      JSON.stringify({
        harness: profile.harness,
        provider: profile.provider ?? '',
        model: profile.model ?? '',
        profile: nativeProfileFor(profile),
      }),
    );
  } catch {
    // ignore
  }

  selectHero(unit, renderer, state, bridge);
}

/** Stable id allocation for a confirmed session; never reuses an existing unit. */
export function nextSessionUnitId(profile: RepoCivProfile, state: GameState): string {
  const base = profile.name.trim().toUpperCase();
  if (!state.getUnit(base)) return base;
  let suffix = 2;
  while (state.getUnit(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * Materialize the map representation only after `/commands` accepted the
 * session. The bridge receives just the city id; this local helper uses the
 * already-loaded city coordinate for the visual placement.
 */
export function spawnAcceptedSession(
  profile: RepoCivProfile,
  city: City,
  mission: string,
  unitId: string,
  state: GameState,
  renderer: Renderer,
  bridge: BridgeEvents,
): Unit {
  const existingCount = state.getAllUnits().filter((u) => u.id.startsWith(profile.name.toUpperCase())).length;
  const offset = existingCount % 6;
  const coord = {
    q: city.coord.q + 1 + (offset % 3),
    r: city.coord.r - Math.floor(offset / 3),
  };
  const typeMap: Record<string, Unit['type']> = {
    claude: 'claude',
    codex: 'codex',
    cursor: 'cursor',
    hermes: 'hero',
    openclaw: 'hero',
    praetorian: 'praetorian',
  };
  const unit = state.spawnUnit(
    unitId,
    profile.display_name ?? profile.name,
    typeMap[profile.harness] ?? 'hero',
    'capital',
    coord,
    mission,
  );
  try {
    localStorage.setItem(
      `repociv:chatConfig:${unitId}`,
      JSON.stringify({
        harness: profile.harness,
        provider: profile.provider ?? '',
        model: profile.model ?? '',
        profile: nativeProfileFor(profile),
      }),
    );
  } catch {
    // The session still exists when browser storage is unavailable.
  }
  selectHero(unit, renderer, state, bridge);
  return unit;
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
    PRAETORIAN: 'praetorian',
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
