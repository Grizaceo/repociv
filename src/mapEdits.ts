// ─── RepoCiv — Map edits (map editor persistence) ───────────────────────────
//
// The world is regenerated from the workspace scan on every load, so anything
// the user edits by hand has to live outside the world object. This module is
// that outside: a small, versioned localStorage document with the manual
// overrides the map editor produces.
//
// Three kinds of edits:
// - terrain overrides: a hex painted with a different terrain
// - removed hexes: a hex erased from the map
// - removed / placed cities: cities taken out of (or added to) the map
//
// Like `manualLayout.ts`, none of this touches the filesystem: removing a city
// only removes it from the map, the repo stays on disk.

import type { Axial } from './hex.ts';
import { tileKey } from './types.ts';
import type { Terrain } from './types.ts';

export const MAP_EDITS_STORAGE_KEY = 'repociv:map-edits:v1';

/** Terrains the editor can paint. `sacred` is capital-only and not paintable. */
export const PAINTABLE_TERRAINS: Terrain[] = [
  'plains',
  'forest',
  'mountain',
  'hills',
  'desert',
  'ice',
  'ocean',
];

export const TERRAIN_LABELS: Record<string, string> = {
  plains: 'Llanura',
  forest: 'Bosque',
  mountain: 'Montaña',
  hills: 'Colinas',
  desert: 'Desierto',
  ice: 'Hielo',
  ocean: 'Océano',
  sacred: 'Sagrado',
};

export interface PlacedCityEntry {
  repoPath: string;
  repoName: string;
  coord: Axial;
  addedAt: number;
}

export interface MapEditStore {
  version: 1;
  /** hexKey → terrain */
  terrain: Record<string, Terrain>;
  removedHexes: string[];
  /** City keys (repo path) taken out of the map. */
  removedCities: string[];
  placedCities: PlacedCityEntry[];
}

const EMPTY_STORE: MapEditStore = {
  version: 1,
  terrain: {},
  removedHexes: [],
  removedCities: [],
  placedCities: [],
};

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

const PAINTABLE = new Set<string>(PAINTABLE_TERRAINS);

function parseStore(raw: string | null): MapEditStore {
  if (!raw)
    return { ...EMPTY_STORE, terrain: {}, removedHexes: [], removedCities: [], placedCities: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<MapEditStore>;
    if (parsed.version !== 1) {
      return { ...EMPTY_STORE, terrain: {}, removedHexes: [], removedCities: [], placedCities: [] };
    }
    const terrain: Record<string, Terrain> = {};
    if (parsed.terrain && typeof parsed.terrain === 'object') {
      for (const [key, value] of Object.entries(parsed.terrain)) {
        if (typeof value === 'string' && PAINTABLE.has(value)) terrain[key] = value as Terrain;
      }
    }
    const removedHexes = Array.isArray(parsed.removedHexes)
      ? parsed.removedHexes.filter((k): k is string => typeof k === 'string')
      : [];
    const removedCities = Array.isArray(parsed.removedCities)
      ? parsed.removedCities.filter((k): k is string => typeof k === 'string')
      : [];
    const placedCities = Array.isArray(parsed.placedCities)
      ? parsed.placedCities.filter(
          (c): c is PlacedCityEntry =>
            typeof c?.repoPath === 'string' &&
            typeof c?.repoName === 'string' &&
            typeof c?.coord?.q === 'number' &&
            typeof c?.coord?.r === 'number',
        )
      : [];
    return { version: 1, terrain, removedHexes, removedCities, placedCities };
  } catch {
    return { ...EMPTY_STORE, terrain: {}, removedHexes: [], removedCities: [], placedCities: [] };
  }
}

let _cache: MapEditStore | null = null;

export function getMapEdits(): MapEditStore {
  if (_cache) return _cache;
  if (!canUseLocalStorage()) {
    _cache = { ...EMPTY_STORE, terrain: {}, removedHexes: [], removedCities: [], placedCities: [] };
    return _cache;
  }
  _cache = parseStore(window.localStorage.getItem(MAP_EDITS_STORAGE_KEY));
  return _cache;
}

export function loadMapEdits(): MapEditStore {
  return getMapEdits();
}

export function saveMapEdits(store: MapEditStore): void {
  _cache = store;
  if (!canUseLocalStorage()) return;
  window.localStorage.setItem(MAP_EDITS_STORAGE_KEY, JSON.stringify(store));
}

export function resetMapEditsCache(): void {
  _cache = null;
}

function persist(): MapEditStore {
  const store = getMapEdits();
  saveMapEdits(store);
  return store;
}

/** Paint a terrain on a hex. Painting the current terrain clears the override. */
export function setHexTerrain(coord: Axial, terrain: Terrain): void {
  const store = getMapEdits();
  const key = tileKey(coord);
  if (!PAINTABLE.has(terrain)) return;
  store.terrain[key] = terrain;
  persist();
}

export function clearHexTerrain(coord: Axial): void {
  const store = getMapEdits();
  delete store.terrain[tileKey(coord)];
  persist();
}

export function terrainOverrideFor(coord: Axial): Terrain | null {
  return getMapEdits().terrain[tileKey(coord)] ?? null;
}

export function removeHex(coord: Axial): void {
  const store = getMapEdits();
  const key = tileKey(coord);
  if (!store.removedHexes.includes(key)) {
    store.removedHexes.push(key);
    persist();
  }
}

export function restoreHex(coord: Axial): void {
  const store = getMapEdits();
  const key = tileKey(coord);
  const idx = store.removedHexes.indexOf(key);
  if (idx !== -1) {
    store.removedHexes.splice(idx, 1);
    persist();
  }
}

export function isHexRemoved(coord: Axial): boolean {
  return getMapEdits().removedHexes.includes(tileKey(coord));
}

/** Take a city off the map. The repo itself is untouched. */
export function removeCityFromMap(cityKey: string): void {
  const store = getMapEdits();
  if (!store.removedCities.includes(cityKey)) {
    store.removedCities.push(cityKey);
    persist();
  }
}

export function restoreCityToMap(cityKey: string): void {
  const store = getMapEdits();
  const idx = store.removedCities.indexOf(cityKey);
  if (idx !== -1) {
    store.removedCities.splice(idx, 1);
    persist();
  }
}

export function isCityRemoved(cityKey: string): boolean {
  return getMapEdits().removedCities.includes(cityKey);
}

/** Remember a city the user placed by hand, so it survives the next world gen. */
export function placeCity(entry: Omit<PlacedCityEntry, 'addedAt'>): void {
  const store = getMapEdits();
  const existing = store.placedCities.find((c) => c.repoPath === entry.repoPath);
  if (existing) {
    existing.coord = entry.coord;
    existing.repoName = entry.repoName;
  } else {
    store.placedCities.push({ ...entry, addedAt: Date.now() });
  }
  // A hand-placed city is by definition on the map.
  const removedIdx = store.removedCities.indexOf(entry.repoPath);
  if (removedIdx !== -1) store.removedCities.splice(removedIdx, 1);
  persist();
}

export function removePlacedCity(repoPath: string): void {
  const store = getMapEdits();
  const idx = store.placedCities.findIndex((c) => c.repoPath === repoPath);
  if (idx !== -1) {
    store.placedCities.splice(idx, 1);
    persist();
  }
}

/** Wipe every manual edit (terrain, hexes, cities). Nations are kept. */
export function clearMapEdits(): void {
  saveMapEdits({
    ...EMPTY_STORE,
    terrain: {},
    removedHexes: [],
    removedCities: [],
    placedCities: [],
  });
}
