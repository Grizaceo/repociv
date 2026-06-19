// ─── RepoCiv — Map Generator ─────────────────────────────────────────────────
// Fetches real workspace metadata from /api/repos and builds a hex tile world.

const CAPITAL_ID = 'capital';
const CAPITAL_NAME: string = import.meta.env.VITE_CAPITAL_NAME || 'Capital';

import { logger } from './logger.ts';
import {
  type Axial,
  spiralCoords,
  axialDistance,
  axialNeighbours,
  axialAdd,
  axialEquals,
  axialSub,
} from './hex.ts';
import {
  type Terrain,
  type Tile,
  type City,
  type District,
  type Building,
  type World,
  tileKey,
} from './types.ts';
import { loadManualLayout, updateManualRepoCoord } from './manualLayout.ts';
import { aStarPath, invalidatePathCache } from './pathfinding.ts';
import { listIframeWonders } from './wonders/manifest.ts';
import type { WonderManifest } from './wonders/types.ts';

// ─── Wonder placement ───────────────────────────────────────────────────────
/** Canonical home tiles for the two example wonders so connecting/disconnecting
 *  one never shuffles the other (and goldens stay stable). Any other connected
 *  wonder takes the next free ring tile around the capital. */
const WONDER_PREFERRED_COORDS: Record<string, Axial> = {
  bibliotheca: { q: -1, r: 0 },
  institutum: { q: 1, r: 0 },
};

export interface WonderPlacement {
  manifest: WonderManifest;
  coord: Axial;
}

/** Assign a hex coordinate to each connected iframe wonder around the capital
 *  (0,0). Deterministic: preferred slots first, then a spiral ring (skipping
 *  the reserved preferred slots) for everything else. */
export function assignWonderCoords(wonders: WonderManifest[]): WonderPlacement[] {
  const ring = spiralCoords({ q: 0, r: 0 }, 19).slice(1); // outward, skip center
  const reservedPref = new Set(Object.values(WONDER_PREFERRED_COORDS).map(tileKey));
  const used = new Set<string>();
  const out: WonderPlacement[] = [];

  for (const manifest of wonders) {
    const pref = WONDER_PREFERRED_COORDS[manifest.id];
    if (pref) {
      out.push({ manifest, coord: pref });
      used.add(tileKey(pref));
    }
  }
  let cursor = 0;
  for (const manifest of wonders) {
    if (WONDER_PREFERRED_COORDS[manifest.id]) continue;
    while (cursor < ring.length) {
      const coord = ring[cursor++]!;
      const key = tileKey(coord);
      if (used.has(key) || reservedPref.has(key)) continue;
      out.push({ manifest, coord });
      used.add(key);
      break;
    }
  }
  return out;
}

/** Build the capital's wonder building + district for one placement. Shared by
 *  world-gen and the runtime sync so both stay in lockstep. */
function makeWonderEntities(
  manifest: WonderManifest,
  coord: Axial,
): { building: Building; district: District } {
  return {
    building: {
      id: `wonder-${manifest.id}`,
      name: manifest.title,
      type: 'wonder',
      wonderType: manifest.id,
      cityId: CAPITAL_ID,
      progress: 100,
      durationSeconds: 0,
      elapsedSeconds: 0,
      state: 'complete',
    },
    district: {
      id: `district-${manifest.id}`,
      name: manifest.title,
      type: 'wonder',
      coord,
      wonderType: manifest.id,
    },
  };
}

/** Reconcile the live world's capital wonders with the currently-connected
 *  iframe wonders (listIframeWonders). Adds tiles/districts/buildings for newly
 *  connected wonders and reverts tiles for disconnected ones — so a Maravilla
 *  shows up on the map the moment it's connected, without a full reload.
 *  Returns true if anything changed. */
export function syncWorldWonders(world: World): boolean {
  const capital = world.cities.find((c) => c.isCapital);
  if (!capital) return false;

  const placements = assignWonderCoords(listIframeWonders());
  const desired = new Map(placements.map((p) => [p.manifest.id, p]));
  const present = new Set(
    (capital.districts ?? []).filter((d) => d.type === 'wonder').map((d) => d.wonderType),
  );
  let changed = false;

  // Remove wonders no longer connected → revert their tile to plains territory.
  for (const d of (capital.districts ?? []).filter((dd) => dd.type === 'wonder')) {
    if (d.wonderType && !desired.has(d.wonderType)) {
      const t = world.tiles.get(tileKey(d.coord));
      if (t) {
        t.district = undefined;
        t.terrain = 'plains';
      }
      changed = true;
    }
  }
  capital.districts = (capital.districts ?? []).filter(
    (d) => d.type !== 'wonder' || (d.wonderType !== undefined && desired.has(d.wonderType)),
  );
  capital.buildings = (capital.buildings ?? []).filter(
    (b) => b.type !== 'wonder' || (b.wonderType !== undefined && desired.has(b.wonderType)),
  );

  // Add newly connected wonders.
  for (const { manifest, coord } of placements) {
    if (present.has(manifest.id)) continue;
    const { building, district } = makeWonderEntities(manifest, coord);
    capital.districts.push(district);
    capital.buildings.push(building);
    world.tiles.set(tileKey(coord), {
      coord,
      terrain: 'sacred',
      district,
      resources: { gold: 0, science: 3, production: 3 },
      inFog: false,
      revealed: true,
    });
    changed = true;
  }

  capital.wonders = (capital.buildings ?? []).filter((b) => b.type === 'wonder');
  return changed;
}

// ─── Terrain inference ──────────────────────────────────────────────────────
const EXTENSION_WEIGHT: Record<string, Terrain> = {
  // Web / frontend
  ts: 'plains',
  tsx: 'plains',
  js: 'plains',
  jsx: 'plains',
  vue: 'plains',
  svelte: 'plains',
  mjs: 'plains',
  cjs: 'plains',
  // ML / data
  py: 'forest',
  ipynb: 'forest',
  r: 'forest',
  jl: 'forest',
  // Systems / low-level
  rs: 'mountain',
  go: 'mountain',
  cpp: 'mountain',
  c: 'mountain',
  h: 'mountain',
  hpp: 'mountain',
  java: 'mountain',
  kt: 'mountain',
  // Binary / heavy
  pt: 'mountain',
  onnx: 'mountain',
  h5: 'mountain',
  pkl: 'mountain',
  db: 'mountain',
  // Docs / config
  md: 'desert',
  txt: 'desert',
  json: 'desert',
  yaml: 'desert',
  yml: 'desert',
  toml: 'desert',
  xml: 'desert',
  html: 'desert',
  css: 'desert',
  scss: 'desert',
  sh: 'desert',
  bash: 'desert',
};

const TERRAIN_WEIGHTS: Record<Terrain, number> = {
  plains: 1,
  forest: 2,
  mountain: 3,
  desert: 1,
  ocean: 1,
  ice: 1,
  hills: 1,
  sacred: 1,
};

export function inferTerrain(extensions: Record<string, number>): Terrain {
  let best: Terrain = 'plains';
  let bestScore = 0;
  let totalCounted = 0;
  for (const [ext, count] of Object.entries(extensions)) {
    const t = EXTENSION_WEIGHT[ext];
    if (!t) continue;
    totalCounted += count;
    const score = count * TERRAIN_WEIGHTS[t];
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (totalCounted === 0) return 'desert';
  return best;
}

// ─── Terrain colors (Canvas fill + iso side faces) ───────────────────────────
export const TERRAIN_COLOR: Record<
  Terrain,
  { fill: string; stroke: string; side: string; gradient?: [string, string] }
> = {
  plains: {
    fill: '#7ba05b',
    stroke: '#5a7a3a',
    side: '#688f4a',
    gradient: ['#8db870', '#6a8f4a'],
  },
  forest: {
    fill: '#2d5a27',
    stroke: '#1e3d18',
    side: '#264a22',
    gradient: ['#3a7032', '#234a1f'],
  },
  mountain: {
    fill: '#6b6b6b',
    stroke: '#4a4a4a',
    side: '#5a5a5a',
    gradient: ['#7d7d7d', '#5a5a5a'],
  },
  desert: {
    fill: '#d4a574',
    stroke: '#b07a4a',
    side: '#b89062',
    gradient: ['#dfb285', '#c49564'],
  },
  ocean: {
    fill: '#2b6da5',
    stroke: '#1b5585',
    side: '#245a88',
    gradient: ['#3a8bc8', '#225590'],
  },
  ice: {
    fill: '#c8d8e0',
    stroke: '#a0b0c0',
    side: '#aab8be',
    gradient: ['#ddeaf0', '#b0c0d0'],
  },
  hills: {
    fill: '#8da86b',
    stroke: '#6a8a4b',
    side: '#78925b',
    gradient: ['#9db87b', '#7a9a5b'],
  },
  sacred: {
    fill: '#1e1530',
    stroke: '#c8a84b',
    side: '#181028',
    gradient: ['#2a1d40', '#140e22'],
  },
};

// ─── Skill & session metadata (from Hermes workspace) ───────────────────────
async function fetchSkillHealth(repoName: string): Promise<'ok' | 'stale' | 'broken' | undefined> {
  try {
    const res = await fetch(`/api/skill-health/${encodeURIComponent(repoName)}`);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { health: 'ok' | 'stale' | 'broken' };
    return data.health;
  } catch {
    return undefined;
  }
}

async function fetchSessionTint(
  repoName: string,
): Promise<'bright' | 'normal' | 'fog' | undefined> {
  try {
    const res = await fetch(`/api/session-tint/${encodeURIComponent(repoName)}`);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { tint: 'bright' | 'normal' | 'fog' };
    return data.tint;
  } catch {
    return undefined;
  }
}

// ─── ScannedRepo from /api/repos ────────────────────────────────────────────
export interface ScannedRepo {
  name: string;
  path: string; // stable city/repo id used by the UI and bridge
  repoPath?: string; // absolute filesystem path
  rootPath?: string; // absolute parent root selected in onboarding
  population: number;
  extensions: Record<string, number>;
  gold: number;
  lastCommitDays: number;
  isLegacy: boolean;
  hasGit: boolean;
  manualCoord?: Axial;
}

const REPO_SELECTION_STORAGE_KEY = 'repociv:selected-repos:v1';

interface RepoSelectionSettings {
  version: 1;
  selectedRepoPaths: string[];
  filters: {
    owners: string[];
    topics: string[];
    languages: string[];
  };
}

export interface RepoSelectionRootState {
  path: string;
  label?: string;
  selectedRepoIds: string[];
  selectedRepoPaths: string[];
}

export interface RepoSelectionState {
  activeRoot: string;
  roots: RepoSelectionRootState[];
  selectedRepoIds: string[];
  selectedRepoPaths: string[];
  hasSelections: boolean;
}

function selectionKeysForRepo(repo: Pick<ScannedRepo, 'path' | 'repoPath'>): string[] {
  const keys = [repo.path];
  if (repo.repoPath && repo.repoPath.length > 0) keys.push(repo.repoPath);
  return keys;
}

function repoMatchesSelection(repo: Pick<ScannedRepo, 'path' | 'repoPath'>, selection: Set<string>): boolean {
  return selectionKeysForRepo(repo).some((key) => selection.has(key));
}

function selectionIncludesValue(selection: Set<string>, value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && selection.has(value);
}

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function loadSelectedRepoPaths(): Set<string> | null {
  if (!canUseLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(REPO_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const legacyPaths = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : null;
    const settings =
      typeof parsed === 'object' &&
      parsed !== null &&
      parsed['version'] === 1 &&
      Array.isArray(parsed['selectedRepoPaths'])
        ? (parsed as RepoSelectionSettings)
        : null;
    const paths = legacyPaths ?? settings?.selectedRepoPaths ?? null;
    if (!paths) return null;
    return paths.length > 0 ? new Set(paths) : new Set();
  } catch {
    return null;
  }
}

export function saveSelectedRepoPaths(paths: string[]): void {
  if (!canUseLocalStorage()) return;
  const dedupedPaths = Array.from(new Set(paths.filter((path) => path.length > 0)));
  const payload: RepoSelectionSettings = {
    version: 1,
    selectedRepoPaths: dedupedPaths,
    filters: {
      owners: [],
      topics: [],
      languages: [],
    },
  };
  window.localStorage.setItem(REPO_SELECTION_STORAGE_KEY, JSON.stringify(payload));
}

function normalizeSelectionState(payload: RepoSelectionState): RepoSelectionState {
  const ids = Array.from(new Set(payload.selectedRepoIds.filter((item) => item.length > 0)));
  const paths = Array.from(new Set(payload.selectedRepoPaths.filter((item) => item.length > 0)));
  return {
    activeRoot: payload.activeRoot,
    roots: payload.roots,
    selectedRepoIds: ids,
    selectedRepoPaths: paths,
    hasSelections: ids.length > 0,
  };
}

export async function fetchRepoSelectionState(): Promise<RepoSelectionState> {
  const res = await fetch('/api/repo-selections');
  if (!res.ok) throw new Error(`/api/repo-selections HTTP ${res.status}`);
  return normalizeSelectionState((await res.json()) as RepoSelectionState);
}

export async function fetchSelectionForRoot(rootPath: string): Promise<Set<string>> {
  const state = await fetchRepoSelectionState();
  const root = state.roots.find((item) => item.path === rootPath);
  return new Set(root?.selectedRepoPaths ?? []);
}

export async function persistRootSelection(rootPath: string, repoIds: string[]): Promise<Set<string>> {
  const res = await fetch('/api/repo-selections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath, selectedRepoIds: repoIds }),
  });
  if (!res.ok) throw new Error(`/api/repo-selections HTTP ${res.status}`);
  const data = normalizeSelectionState((await res.json()) as RepoSelectionState);
  saveSelectedRepoPaths(data.selectedRepoPaths);
  return new Set(data.selectedRepoPaths);
}

export async function addSelectedRepoPath(repoId: string): Promise<Set<string>> {
  const res = await fetch('/api/repo-selections/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId }),
  });
  if (!res.ok) throw new Error(`/api/repo-selections/add HTTP ${res.status}`);
  const data = normalizeSelectionState((await res.json()) as RepoSelectionState);
  saveSelectedRepoPaths(data.selectedRepoPaths);
  return new Set(data.selectedRepoPaths);
}

export async function removeSelectedRepoPath(repoId: string): Promise<Set<string>> {
  const res = await fetch('/api/repo-selections/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId }),
  });
  if (!res.ok) throw new Error(`/api/repo-selections/remove HTTP ${res.status}`);
  const data = normalizeSelectionState((await res.json()) as RepoSelectionState);
  saveSelectedRepoPaths(data.selectedRepoPaths);
  return new Set(data.selectedRepoPaths);
}

export async function fetchScannedRepos(): Promise<ScannedRepo[]> {
  const res = await fetch('/api/repos');
  if (!res.ok) throw new Error(`/api/repos HTTP ${res.status}`);
  return (await res.json()) as ScannedRepo[];
}

export async function fetchSelectedRepos(): Promise<ScannedRepo[]> {
  const res = await fetch('/api/repos/selected');
  if (!res.ok) throw new Error(`/api/repos/selected HTTP ${res.status}`);
  return (await res.json()) as ScannedRepo[];
}

// ─── Top-level subdirs detection (best-effort from extensions distribution) ─
async function fetchSubdirs(repoName: string): Promise<{ name: string; terrain: Terrain }[]> {
  try {
    const res = await fetch(`/api/files/${repoName}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { files: string[] };
    // Group files by top-level directory
    const groups = new Map<string, Record<string, number>>();
    for (const f of data.files) {
      const slash = f.indexOf('/');
      if (slash < 0) continue;
      const top = f.slice(0, slash);
      const dot = f.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = f.slice(dot + 1).toLowerCase();
      if (!groups.has(top)) groups.set(top, {});
      const g = groups.get(top)!;
      g[ext] = (g[ext] ?? 0) + 1;
    }
    return Array.from(groups.entries())
      .filter(([_, exts]) => Object.values(exts).reduce((a, b) => a + b, 0) >= 3)
      .slice(0, 4)
      .map(([name, exts]) => ({ name, terrain: inferTerrain(exts) }));
  } catch {
    return [];
  }
}

// ─── Voronoi Territory Partitioning (Civilization-style) ─────────────────────
export function recalculateAllTerritories(world: World): void {
  const { cities } = world;
  if (cities.length === 0) return;

  const coordToCities = new Map<string, { coord: Axial; cityIndices: number[] }>();

  // Collect all unique coordinates in range 2 of any city
  for (let i = 0; i < cities.length; i++) {
    const city = cities[i]!;
    const rangeCoords = axialRange(city.coord, 2);
    for (const c of rangeCoords) {
      const key = tileKey(c);
      if (!coordToCities.has(key)) {
        coordToCities.set(key, { coord: c, cityIndices: [] });
      }
      coordToCities.get(key)!.cityIndices.push(i);
    }
  }

  const newTerritories = Array.from({ length: cities.length }, () => [] as Axial[]);

  // Assign each coordinate to the nearest city center (Voronoi partition)
  for (const { coord, cityIndices } of coordToCities.values()) {
    let bestIndex = -1;
    let minDist = Infinity;

    for (const idx of cityIndices) {
      const city = cities[idx]!;
      const dist = axialDistance(coord, city.coord);
      if (dist < minDist) {
        minDist = dist;
        bestIndex = idx;
      } else if (dist === minDist) {
        // Consistent tie-breaker: capital first, then by ID
        if (city.isCapital) {
          bestIndex = idx;
          minDist = dist;
        } else if (bestIndex === -1 || cities[bestIndex]!.isCapital) {
          // keep previous or let capital override if it just matched
        } else if (city.id < cities[bestIndex]!.id) {
          bestIndex = idx;
        }
      }
    }

    if (bestIndex !== -1) {
      newTerritories[bestIndex]!.push(coord);
    }
  }

  // Update city territories, filtering out their districts
  for (let i = 0; i < cities.length; i++) {
    const city = cities[i]!;
    city.territory = newTerritories[i]!.filter(
      (c) => !city.districts.some((d) => d.coord.q === c.q && d.coord.r === c.r),
    );
  }
}

// ─── Reconnect disconnected cities (dynamic + initial generation) ────────────
export async function reconnectCities(world: World): Promise<void> {
  const { tiles, cities } = world;
  const capitalCity = cities.find((c) => c.isCapital) ?? cities[0];
  if (!capitalCity) return;

  const connectedKeys = new Set<string>();
  const queue: Axial[] = [capitalCity.coord];
  connectedKeys.add(tileKey(capitalCity.coord));

  // BFS to find all tiles connected to the capital
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const nb of axialNeighbours(current)) {
      const key = tileKey(nb);
      if (connectedKeys.has(key)) continue;
      const tile = tiles.get(key);
      if (!tile) continue;
      // Check if tile is part of any city's territory or is a city itself
      const isConnectedTile = cities.some(
        (c) =>
          (c.coord.q === nb.q && c.coord.r === nb.r) || // city itself
          c.territory.some((t) => t.q === nb.q && t.r === nb.r), // territory tile
      );
      if (isConnectedTile) {
        connectedKeys.add(key);
        queue.push(nb);
      }
    }
  }

  // Find disconnected cities and process them
  for (const city of cities) {
    if (city.isCapital) continue;
    if (connectedKeys.has(tileKey(city.coord))) continue;

    // Disconnected city: find nearest connected city
    let nearestConnectedCity: City | null = null;
    let minDist = Infinity;
    for (const connectedCity of cities) {
      if (connectedCity === city) continue;
      if (!connectedKeys.has(tileKey(connectedCity.coord))) continue;
      const dist = axialDistance(city.coord, connectedCity.coord);
      if (dist < minDist) {
        minDist = dist;
        nearestConnectedCity = connectedCity;
      }
    }

    if (!nearestConnectedCity) continue;

    // Compute A* path from disconnected city to nearest connected city
    const path = aStarPath(city.coord, nearestConnectedCity.coord, world, 'hero');
    if (path.length === 0) continue;

    // Fetch folder structure for the disconnected city's repo
    let folderStructure: string[] = [];
    try {
      const repoName = city.name;
      const res = await fetch(`/api/files/${encodeURIComponent(repoName)}`);
      if (res.ok) {
        const data = (await res.json()) as { files: string[] };
        // Extract unique top-level folders
        const folders = new Set<string>();
        for (const f of data.files) {
          const slash = f.indexOf('/');
          if (slash > 0) folders.add(f.slice(0, slash));
        }
        folderStructure = Array.from(folders);
      }
    } catch {
      /* ignore */
    }

    // Set intermediate tiles: terrain = 'plains', add folder structure
    for (const coord of path) {
      const key = tileKey(coord);
      let tile = tiles.get(key);
      if (!tile) {
        // Create new tile if it doesn't exist
        tile = {
          coord,
          terrain: 'plains',
          resources: { gold: 0, science: 0, production: 0 },
          inFog: false,
          revealed: true,
          folderStructure: folderStructure.length > 0 ? folderStructure : undefined,
        };
        tiles.set(key, tile);
      } else {
        tile.terrain = 'plains';
        tile.inFog = false;
        tile.revealed = true;
        if (folderStructure.length > 0) tile.folderStructure = folderStructure;
      }
    }
  }

  // Clear path cache since tiles changed
  invalidatePathCache();
}

// ─── Per-city territory color palette ─────────────────────────────────
/** Vivid, evenly-hued Civ V player colors — saturated enough that the
 *  culture-border ribbons read as distinct empires against golden-hour
 *  terrain, not as roads. RGB 0-1. The old palette clustered three warm
 *  tones (orange/amber/gold) that were hard to tell apart and blended
 *  into tan terrain. */
const CITY_PALETTE: [number, number, number][] = [
  [0.20, 0.45, 0.95], // royal blue
  [0.93, 0.23, 0.25], // red
  [0.10, 0.72, 0.68], // teal
  [0.62, 0.30, 0.86], // violet
  [0.98, 0.55, 0.12], // orange
  [0.28, 0.78, 0.32], // green
  [0.96, 0.36, 0.70], // pink
  [0.96, 0.82, 0.22], // gold
  [0.18, 0.72, 0.96], // cyan
  [0.62, 0.82, 0.20], // lime
];

/** Deterministic per-city color from a hash of the city id. FNV-1a + an
 *  avalanche step distributes near-identical ids (repos that share a long
 *  path prefix) across the palette far better than the old djb2 `% n`,
 *  which collided three sibling repos onto one color. */
export function cityColorFromId(id: string): [number, number, number] {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash = (hash ^ (hash >>> 13)) >>> 0;
  return CITY_PALETTE[hash % CITY_PALETTE.length]!;
}

// ─── Dynamic city add/remove helpers ────────────────────────────────
export function addCityToWorld(
  world: World,
  repo: ScannedRepo & { terrain?: Terrain; science?: number; production?: number },
  coord: Axial,
): City {
  const city: City = {
    id: repo.path,
    name: repo.name,
    coord,
    repoPath: repo.repoPath ?? repo.path,
    population: repo.population,
    territory: [], // recalculated below
    districts: [],
    buildings: [],
    isCapital: false,
    color: cityColorFromId(repo.path),
  };
  world.cities.push(city);
  // Add city tile to world.tiles
  world.tiles.set(tileKey(coord), {
    coord,
    terrain: repo.terrain ?? 'plains',
    city,
    resources: { gold: repo.gold, science: repo.science ?? 0, production: repo.production ?? 0 },
    inFog: false,
    revealed: true,
  });
  recalculateAllTerritories(world);
  return city;
}

export function removeCityFromWorld(world: World, cityRef: string): boolean {
  const idx = world.cities.findIndex(
    (c) => c.name === cityRef || c.id === cityRef || c.repoPath === cityRef,
  );
  if (idx === -1) return false;
  const [city] = world.cities.splice(idx, 1);
  // Remove city tile from world.tiles
  world.tiles.delete(tileKey(city!.coord));
  // Remove any units on this city
  world.units = world.units.filter((u) => tileKey(u.coord) !== tileKey(city!.coord));
  return true;
}

/** Hex keys this city currently occupies (center + district tiles). */
function cityOccupiedKeys(city: City): Set<string> {
  const keys = new Set<string>([tileKey(city.coord)]);
  for (const d of city.districts) keys.add(tileKey(d.coord));
  return keys;
}

/** Destination hexes after moving `city` so its center lands on `targetCoord`. */
function relocateTargetHexes(city: City, targetCoord: Axial): Axial[] {
  const delta = axialSub(targetCoord, city.coord);
  const out: Axial[] = [targetCoord];
  for (const d of city.districts) out.push(axialAdd(d.coord, delta));
  return out;
}

function resolveRepoPathForCity(city: City, fallback: string | null): string | null {
  if (fallback) return fallback;
  if (city.repoPath) return city.repoPath;
  const store = loadManualLayout();
  const hit = store.entries.find((e) => e.repoPath === city.id || e.repoName === city.name);
  return hit?.repoFsPath ?? hit?.repoPath ?? null;
}

/**
 * Whether the city can move its footprint (center + shifted districts) onto the map.
 * Vacating hexes are allowed; foreign cities, foreign districts, ocean, or blocking units fail.
 */
export function canRelocateCityTo(world: World, city: City, targetCoord: Axial): boolean {
  if (axialEquals(city.coord, targetCoord)) return false;

  const delta = axialSub(targetCoord, city.coord);
  for (const d of city.districts) {
    const nd = axialAdd(d.coord, delta);
    // District cannot land on the city center hex (still occupied until relocate runs).
    if (axialEquals(nd, city.coord)) return false;
    // District cannot share the destination hex with the city tile.
    if (axialEquals(nd, targetCoord)) return false;
  }

  const sources = cityOccupiedKeys(city);
  const targets = relocateTargetHexes(city, targetCoord);
  const seen = new Set<string>();
  for (const t of targets) {
    const k = tileKey(t);
    if (seen.has(k)) return false;
    seen.add(k);

    const tile = world.tiles.get(k);
    if (!tile) return false;
    if (tile.terrain === 'ocean') return false;

    if (!sources.has(k)) {
      if (tile.city) return false;
      if (tile.district) return false;
      for (const u of world.units) {
        if (tileKey(u.coord) === k && !axialEquals(u.coord, city.coord)) return false;
      }
    } else {
      for (const u of world.units) {
        if (tileKey(u.coord) !== k) continue;
        if (axialEquals(u.coord, city.coord)) continue;
        return false;
      }
    }
  }
  return true;
}

/**
 * Moves a city (center, districts, territory) and persists manual layout when `repoPath` resolves.
 * Calls `reconnectCities` after mutation (same as dynamic add/remove).
 */
export async function relocateCity(
  world: World,
  cityId: string,
  targetCoord: Axial,
  repoPathFallback: string | null,
): Promise<boolean> {
  const city = world.cities.find((c) => c.id === cityId);
  if (!city) return false;
  if (!canRelocateCityTo(world, city, targetCoord)) return false;

  const delta = axialSub(targetCoord, city.coord);
  const oldCoord = city.coord;
  const tiles = world.tiles;
  const oldCityTile = tiles.get(tileKey(oldCoord));

  // 1) Shift district tiles
  for (const d of city.districts) {
    const oldDc = d.coord;
    const newDc = axialAdd(oldDc, delta);
    const oldK = tileKey(oldDc);
    const newK = tileKey(newDc);
    const src = tiles.get(oldK);
    if (!src?.district || src.district.id !== d.id) continue;
    tiles.delete(oldK);
    d.coord = newDc;
    tiles.set(newK, { ...src, coord: newDc, district: d });
  }

  // 2) Move units standing on the city center hex with the city
  for (const u of world.units) {
    if (axialEquals(u.coord, oldCoord)) u.coord = targetCoord;
  }

  // 3) Detach city from old tile (keep terrain tile)
  if (oldCityTile) {
    oldCityTile.city = undefined;
  }

  // 4) Place city on destination tile (preserve metadata from old city tile)
  const destKey = tileKey(targetCoord);
  const destBase = tiles.get(destKey);
  if (!destBase) return false;

  city.coord = targetCoord;
  const merged: Tile = {
    ...destBase,
    coord: targetCoord,
    terrain: oldCityTile?.terrain ?? destBase.terrain,
    resources: oldCityTile?.resources ?? destBase.resources,
    city,
    district: undefined,
    skillHealth: oldCityTile?.skillHealth ?? destBase.skillHealth,
    sessionTint: oldCityTile?.sessionTint ?? destBase.sessionTint,
  };
  tiles.set(destKey, merged);

  recalculateAllTerritories(world);

  const path = resolveRepoPathForCity(city, repoPathFallback);
  if (path) {
    city.repoPath = path;
    updateManualRepoCoord(path, targetCoord);
  }

  invalidatePathCache();
  await reconnectCities(world);
  return true;
}

// ─── World generator ─────────────────────────────────────────────────
export async function generateWorld(): Promise<World> {
  const MIN_CITY_DISTANCE = 3;
  const tiles = new Map<string, Tile>();
  const cities: City[] = [];
  const selectedRepoPaths = loadSelectedRepoPaths();

  // Non-blocking full scan: surfaces workspace errors without preventing the
  // selected-repos flow from rendering the map.
  void fetchScannedRepos().catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('[map] /api/repos failed', e);
    showMapLoadError(`No pude cargar repos reales: ${message}`);
  });

  // Fetch real repos
  let repos: ScannedRepo[] = [];
  try {
    if (selectedRepoPaths !== null && selectedRepoPaths.size > 0) {
      repos = (await fetchScannedRepos()).filter((repo) => repoMatchesSelection(repo, selectedRepoPaths));
    } else {
      repos = await fetchSelectedRepos();
      saveSelectedRepoPaths(repos.map((repo) => repo.path));
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('[map] /api/repos/selected failed', e);
    showMapLoadError(
      selectedRepoPaths !== null && selectedRepoPaths.size > 0
        ? `No pude cargar repos reales: ${message}`
        : `No pude cargar repos seleccionados: ${message}`,
    );
    if (selectedRepoPaths !== null && selectedRepoPaths.size > 0) {
      try {
        repos = await fetchSelectedRepos();
      } catch {
        repos = [];
      }
    }
  }

  if (selectedRepoPaths !== null && selectedRepoPaths.size > 0) {
    repos = repos.filter((repo) => repoMatchesSelection(repo, selectedRepoPaths));
  }

  const manualLayout = loadManualLayout();
  const manualRepoMap = new Map<string, Axial>();
  for (const entry of manualLayout.entries) {
    manualRepoMap.set(entry.repoPath, { q: entry.coord.q, r: entry.coord.r });
    if (!repos.some((repo) => repo.path === entry.repoPath)) {
      repos.push({
        name: entry.repoName,
        path: entry.repoPath,
        population: 0,
        extensions: {},
        gold: 0,
        lastCommitDays: 999,
        isLegacy: false,
        hasGit: false,
      });
    }
  }
  // Sort: preserve selection order if available, otherwise most-populated first → capital
  if (selectedRepoPaths !== null) {
    // Preserve selection order: selectedRepoPaths is a Set, convert to Array to iterate in insertion order
    const selectedOrder = Array.from(selectedRepoPaths);
    const orderedRepos: ScannedRepo[] = [];
    for (const path of selectedOrder) {
      const found = repos.find(
        (r) => selectionIncludesValue(selectedRepoPaths, path) && selectionKeysForRepo(r).includes(path),
      );
      if (found && !orderedRepos.some((repo) => repo.path === found.path)) orderedRepos.push(found);
    }
    // Add any remaining repos that weren't in selectedRepoPaths (e.g., manual entries)
    for (const repo of repos) {
      if (!orderedRepos.some((item) => item.path === repo.path)) orderedRepos.push(repo);
    }
    repos = orderedRepos;
  } else {
    repos.sort((a, b) => b.population - a.population);
  }
  // Inferred terrain per repo
  const reposWithTerrain = repos.map((r) => ({
    ...r,
    terrain: r.isLegacy
      ? ('ice' as Terrain)
      : r.population === 0
        ? ('ocean' as Terrain)
        : inferTerrain(r.extensions),
    science: Math.min(99, Math.floor(r.gold / 10)),
    production: Math.min(99, Math.floor(r.gold / 50)),
    manualCoord: manualRepoMap.get(r.path),
  }));
  // All selected repos are cities (regardless of population)
  // Orphans only exist when there's no selection and population <= 5
  let cityRepos: typeof reposWithTerrain;
  let orphanRepos: typeof reposWithTerrain;
  if (selectedRepoPaths !== null) {
    // With selection: all selected repos are cities
    cityRepos = reposWithTerrain;
    orphanRepos = [];
  } else {
    // Without selection: original behavior
    cityRepos = reposWithTerrain.filter((r) => r.population > 5 || !!r.manualCoord);
    orphanRepos = reposWithTerrain.filter((r) => r.population <= 5 && !r.manualCoord);
  }

  // ─── Exclude the capital repo folder from regular cities ─────────────────────
  const _capSlug = CAPITAL_NAME.toLowerCase();
  cityRepos = cityRepos.filter((r) => !(r.path.endsWith(_capSlug) || r.name === _capSlug));
  orphanRepos = orphanRepos.filter((r) => !(r.path.endsWith(_capSlug) || r.name === _capSlug));

  const maxAutoCoords = Math.max(
    cityRepos.length * MIN_CITY_DISTANCE * MIN_CITY_DISTANCE * 3,
    cityRepos.length + 32,
  );
  const cityCoords = spiralCoords({ q: 0, r: 0 }, maxAutoCoords);
  const occupiedCoords = new Set<string>();
  const cityCoordLookup = new Map<string, Axial>();
  // Reserve capital + connected-wonder district hexes so repos don't land on
  // them. Wonders are whatever the user connected (hydrated before world-gen);
  // out-of-the-box this is empty (nothing pre-installed).
  const wonderPlacements = assignWonderCoords(listIframeWonders());
  occupiedCoords.add(tileKey({ q: 0, r: 0 })); // capital
  for (const wp of wonderPlacements) {
    occupiedCoords.add(tileKey(wp.coord));
  }
  let autoCoordCursor = 0;
  for (const repo of cityRepos) {
    if (repo.manualCoord) {
      const key = tileKey(repo.manualCoord);
      occupiedCoords.add(key);
      cityCoordLookup.set(repo.path, repo.manualCoord);
      continue;
    }
    while (autoCoordCursor < cityCoords.length) {
      const coord = cityCoords[autoCoordCursor]!;
      autoCoordCursor++;
      const key = tileKey(coord);
      if (occupiedCoords.has(key)) continue;

      // Enforce minimum distance from all previously assigned city coordinates
      let tooClose = false;
      for (const assignedCoord of cityCoordLookup.values()) {
        if (axialDistance(coord, assignedCoord) < MIN_CITY_DISTANCE) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      occupiedCoords.add(key);
      cityCoordLookup.set(repo.path, coord);
      break;
    }
  }

  // Fetch subdirs + skill health + session tint in parallel
  const [subdirsPerRepo, skillHealthPerRepo, sessionTintPerRepo] = await Promise.all([
    Promise.all(cityRepos.map((r) => fetchSubdirs(r.path))),
    Promise.all(cityRepos.map((r) => fetchSkillHealth(r.name))),
    Promise.all(cityRepos.map((r) => fetchSessionTint(r.name))),
  ]);

  for (let i = 0; i < cityRepos.length; i++) {
    const repo = cityRepos[i]!;
    const coord = cityCoordLookup.get(repo.path) ?? cityCoords[i]!;
    const subdirs = subdirsPerRepo[i] ?? [];
    const skillHealth = skillHealthPerRepo[i];
    const sessionTint = sessionTintPerRepo[i];

    const districtCoords = spiralCoords(coord, Math.min(subdirs.length + 1, 7));
    const districts: District[] = subdirs.map((sub, j) => ({
      id: `${repo.name}-${sub.name}`,
      name: sub.name,
      type:
        sub.terrain === 'forest'
          ? 'campus'
          : sub.terrain === 'mountain'
            ? 'industrial'
            : sub.terrain === 'plains'
              ? 'commercial'
              : 'encamp',
      coord: districtCoords[j + 1] ?? axialAdd(coord, { q: j, r: 0 }),
    }));

    const city: City = {
      id: repo.name,
      name: repo.name,
      coord,
      repoPath: repo.path,
      population: repo.population,
      territory: [], // recalculated below
      districts,
      buildings: [],
      isCapital: false,
      color: cityColorFromId(repo.name),
    };
    cities.push(city);

    // City tile
    tiles.set(tileKey(coord), {
      coord,
      terrain: repo.terrain,
      city,
      resources: { gold: repo.gold, science: repo.science, production: repo.production },
      inFog: false,
      revealed: true,
      skillHealth,
      sessionTint,
    });

    // District tiles
    for (let j = 0; j < districts.length; j++) {
      const d = districts[j]!;
      const sub = subdirs[j]!;
      tiles.set(tileKey(d.coord), {
        coord: d.coord,
        terrain: sub.terrain,
        district: d,
        resources: { gold: 0, science: 0, production: 0 },
        inFog: false,
        revealed: true,
      });
    }
  }

  // Place orphan repos as small terrain dots in outer ring
  if (orphanRepos.length > 0) {
    const outerStart = cityRepos.length;
    const outerCoords = spiralCoords({ q: 0, r: 0 }, outerStart + orphanRepos.length + 5);
    for (let i = 0; i < orphanRepos.length; i++) {
      const repo = orphanRepos[i]!;
      const coord = outerCoords[outerStart + i + 5];
      if (!coord) break;
      if (tiles.has(tileKey(coord))) continue;
      tiles.set(tileKey(coord), {
        coord,
        terrain: repo.terrain,
        resources: { gold: repo.gold, science: 0, production: 0 },
        inFog: false,
        revealed: true,
      });
    }
  }

  // Fill gaps with ocean
  const existingKeys = new Set<string>();
  for (const tile of tiles.values()) existingKeys.add(tileKey(tile.coord));

  let minQ = 0,
    maxQ = 0,
    minR = 0,
    maxR = 0;
  for (const tile of tiles.values()) {
    if (tile.coord.q < minQ) minQ = tile.coord.q;
    if (tile.coord.q > maxQ) maxQ = tile.coord.q;
    if (tile.coord.r < minR) minR = tile.coord.r;
    if (tile.coord.r > maxR) maxR = tile.coord.r;
  }
  const padding = 5;
  for (let q = minQ - padding; q <= maxQ + padding; q++) {
    for (let r = minR - padding; r <= maxR + padding; r++) {
      const key = tileKey({ q, r });
      if (!existingKeys.has(key)) {
        const isWithinBounds = q >= minQ && q <= maxQ && r >= minR && r <= maxR;
        let terrain: Terrain = 'ocean';
        if (isWithinBounds) {
          // Generate a beautiful, natural continental landscape inside bounding box
          const rand = Math.random();
          if (rand < 0.15) terrain = 'forest';
          else if (rand < 0.3) terrain = 'hills';
          else terrain = 'plains';
        }
        tiles.set(key, {
          coord: { q, r },
          terrain,
          resources: { gold: 0, science: 0, production: 0 },
          inFog: !isWithinBounds,
          revealed: isWithinBounds,
        });
      }
    }
  }

  const totalGold = reposWithTerrain.reduce((acc, r) => acc + r.gold, 0);
  const totalScience = reposWithTerrain.reduce((acc, r) => acc + r.science, 0);
  const totalProduction = reposWithTerrain.reduce((acc, r) => acc + r.production, 0);

  // ─── Spawn Capital + Wonder Districts ────────────────────────────────────────
  const capCoord: Axial = { q: 0, r: 0 };

  // One district/building/tile per connected iframe wonder (dynamic — see
  // assignWonderCoords). Empty out-of-the-box; the user connects wonders from
  // the Maravillas guide and they appear here on the next world-gen.
  const wonderBuildings: Building[] = [];
  const wonderDistricts: District[] = [];
  for (const { manifest, coord } of wonderPlacements) {
    const { building, district } = makeWonderEntities(manifest, coord);
    wonderBuildings.push(building);
    wonderDistricts.push(district);
  }

  const territory = spiralCoords(capCoord, 7).slice(1, 7); // 6 neighbours at radius 1

  const capitalCity: City = {
    id: CAPITAL_ID,
    name: CAPITAL_NAME,
    coord: capCoord,
    population: 1,
    territory,
    districts: wonderDistricts,
    buildings: wonderBuildings,
    wonders: wonderBuildings,
    isCapital: true,
    color: cityColorFromId(CAPITAL_ID),
  };
  cities.push(capitalCity);

  // Capital tile (sacred terrain)
  tiles.set(tileKey(capCoord), {
    coord: capCoord,
    terrain: 'sacred',
    city: capitalCity,
    resources: { gold: 10, science: 10, production: 10 },
    inFog: false,
    revealed: true,
  });

  // Wonder district tiles (sacred terrain)
  for (const district of wonderDistricts) {
    tiles.set(tileKey(district.coord), {
      coord: district.coord,
      terrain: 'sacred',
      district,
      resources: { gold: 0, science: 3, production: 3 },
      inFog: false,
      revealed: true,
    });
  }

  // Claim remaining territory tiles for the capital
  for (const t of territory) {
    const k = tileKey(t);
    if (tiles.has(k)) continue; // don't overwrite wonder district tiles
    tiles.set(k, {
      coord: t,
      terrain: 'plains',
      resources: { gold: 0, science: 0, production: 0 },
      inFog: false,
      revealed: true,
    });
  }

  // Detect disconnected cities and generate intermediate tiles with folder structures
  const world: World = {
    tiles,
    cities,
    units: [],
    buildings: [],
    resources: { gold: totalGold, science: totalScience, production: totalProduction },
    generatedAt: Date.now(),
    restAreas: [],
  };

  // Recalculate territories dynamically to prevent overlaps (Civilization Voronoi)
  recalculateAllTerritories(world);

  // Reconnect cities dynamically (BFS + A* + intermediate tiles)
  await reconnectCities(world);

  return world;
}

export function showMapLoadError(message: string) {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('map-load-error');
  const el = existing ?? document.createElement('div');
  el.id = 'map-load-error';
  el.textContent = message;
  el.setAttribute('role', 'alert');
  el.style.position = 'fixed';
  el.style.left = '16px';
  el.style.bottom = '16px';
  el.style.zIndex = '9999';
  el.style.maxWidth = '560px';
  el.style.padding = '10px 12px';
  el.style.border = '1px solid #b45309';
  el.style.background = 'rgba(30, 20, 10, 0.92)';
  el.style.color = '#fbbf24';
  el.style.fontFamily = 'monospace';
  if (!existing) document.body.appendChild(el);
}

// ─── Utility: range around a point ──────────────────────────────────────────
function axialRange(center: Axial, radius: number): Axial[] {
  const results: Axial[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      results.push(axialAdd(center, { q, r }));
    }
  }
  return results;
}
