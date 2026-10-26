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
  type Unit,
  type World,
  tileKey,
} from './types.ts';
import { loadManualLayout, updateManualRepoCoord } from './manualLayout.ts';
import { aStarPath, invalidatePathCache } from './pathfinding.ts';
import { listIframeWonders } from './wonders/manifest.ts';
import type { WonderManifest } from './wonders/types.ts';
import {
  clearHexTerrain,
  findPlacedCityEntry,
  getMapEdits,
  isCityRemoved,
  isFilesystemPath,
  PAINTABLE_TERRAINS,
  placeCity,
  removeCityFromMap,
  removeHex,
  removePlacedCity,
  restoreCityToMap,
  restoreHex,
  setHexTerrain,
  terrainOverrideFor,
  type PlacedCityEntry,
} from './mapEdits.ts';
import { applyNationsToWorld, cityKey } from './nations.ts';

// ─── Wonder placement ───────────────────────────────────────────────────────
export interface WonderPlacement {
  manifest: WonderManifest;
  coord: Axial;
}

/** Assign a hex coordinate to each connected iframe wonder around the capital
 *  (0,0). Deterministic: wonders take successive tiles of an outward spiral in
 *  registry order, so the same set of connected wonders always lands the same
 *  way and goldens stay stable. */
export function assignWonderCoords(wonders: WonderManifest[]): WonderPlacement[] {
  const ring = spiralCoords({ q: 0, r: 0 }, 19).slice(1); // outward, skip center
  const out: WonderPlacement[] = [];
  let cursor = 0;
  for (const manifest of wonders) {
    if (cursor >= ring.length) break;
    out.push({ manifest, coord: ring[cursor++]! });
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

function inferTerrain(extensions: Record<string, number>): Terrain {
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

interface RepoSelectionRootState {
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

function repoMatchesSelection(
  repo: Pick<ScannedRepo, 'path' | 'repoPath'>,
  selection: Set<string>,
): boolean {
  return selectionKeysForRepo(repo).some((key) => selection.has(key));
}

function repoMatchesDisk(
  repo: Pick<ScannedRepo, 'path' | 'repoPath' | 'name'>,
  disk: Pick<ScannedRepo, 'path' | 'repoPath' | 'name'>,
): boolean {
  if (repo.name === disk.name) return true;
  return selectionKeysForRepo(repo).some((key) => selectionKeysForRepo(disk).includes(key));
}

function findRepoOnDisk(
  repo: Pick<ScannedRepo, 'path' | 'repoPath' | 'name'>,
  diskRepos: ScannedRepo[],
): ScannedRepo | undefined {
  return diskRepos.find((disk) => repoMatchesDisk(repo, disk));
}

function reconcileRepoWithDisk(repo: ScannedRepo, diskRepos: ScannedRepo[]): ScannedRepo | null {
  const disk = findRepoOnDisk(repo, diskRepos);
  if (!disk) return null;
  return {
    ...disk,
    manualCoord: repo.manualCoord ?? disk.manualCoord,
  };
}

function filterReposToDisk(repos: ScannedRepo[], diskRepos: ScannedRepo[]): ScannedRepo[] {
  return repos
    .map((repo) => reconcileRepoWithDisk(repo, diskRepos) ?? repo)
    .filter((repo) => findRepoOnDisk(repo, diskRepos));
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

export async function persistRootSelection(
  rootPath: string,
  repoIds: string[],
): Promise<Set<string>> {
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

async function fetchSelectedRepos(): Promise<ScannedRepo[]> {
  const res = await fetch('/api/repos/selected');
  if (!res.ok) throw new Error(`/api/repos/selected HTTP ${res.status}`);
  return (await res.json()) as ScannedRepo[];
}

// ─── Multi-root API ──────────────────────────────────────────────────────────

export interface MapRootInfo {
  path: string;
  label?: string;
  isActive: boolean;
  repoCount: number;
  selectedCount: number;
  addedAt: string;
  lastSeen: string;
}

export interface MapRootsResponse {
  activeRoot: string;
  roots: MapRootInfo[];
}

export async function fetchMapRoots(): Promise<MapRootsResponse> {
  const res = await fetch('/api/map-roots');
  if (!res.ok) throw new Error(`/api/map-roots HTTP ${res.status}`);
  return (await res.json()) as MapRootsResponse;
}

export async function addMapRoot(
  rootPath: string,
  label?: string,
): Promise<{ ok: boolean; totalRepos: number }> {
  const res = await fetch('/api/map-roots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: rootPath, label }),
  });
  if (!res.ok) throw new Error(`/api/map-roots HTTP ${res.status}`);
  return (await res.json()) as { ok: boolean; totalRepos: number };
}

export async function activateMapRoot(rootPath: string): Promise<{ ok: boolean }> {
  const res = await fetch('/api/map-roots/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: rootPath }),
  });
  if (!res.ok) throw new Error(`/api/map-roots/activate HTTP ${res.status}`);
  return (await res.json()) as { ok: boolean };
}

export async function removeMapRoot(
  rootPath: string,
): Promise<{ ok: boolean; totalRepos: number }> {
  const res = await fetch('/api/map-roots/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: rootPath }),
  });
  if (!res.ok) throw new Error(`/api/map-roots/remove HTTP ${res.status}`);
  return (await res.json()) as { ok: boolean; totalRepos: number };
}

export async function pickMapRootFolder(): Promise<{
  ok: boolean;
  root: string;
  totalRepos: number;
}> {
  const res = await fetch('/api/map-roots/pick', { method: 'POST' });
  if (!res.ok) throw new Error(`/api/map-roots/pick HTTP ${res.status}`);
  return (await res.json()) as { ok: boolean; root: string; totalRepos: number };
}

// ─── Top-level subdirs detection (best-effort from extensions distribution) ─
async function fetchSubdirs(repoId: string): Promise<{ name: string; terrain: Terrain }[]> {
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(repoId)}`);
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
      // A hex erased with the editor is not on the map: it must not come back
      // into a territory (the border would be drawn around the hole).
      if (!world.tiles.has(key)) continue;
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
      const repoId = city.repoPath ?? city.id;
      const res = await fetch(`/api/files/${encodeURIComponent(repoId)}`);
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
// Heraldic, not screen-primary. These drive the culture-border ribbons and the
// city flags, both of which render UNLIT and with `toneMapped: false` — they
// bypass the tone curve every other surface goes through, so a saturated value
// here lands on the map at full strength and reads as a debug quad rather than
// a banner. Pulled ~30% off saturation and into the warm-earth value range of
// the terrain, keeping ten separable hues so cities stay tellable apart.
const CITY_PALETTE: [number, number, number][] = [
  [0.29, 0.44, 0.72], // azul heráldico
  [0.78, 0.3, 0.28], // rojo óxido
  [0.24, 0.58, 0.55], // verdemar
  [0.51, 0.36, 0.63], // púrpura apagado
  [0.85, 0.53, 0.24], // ámbar quemado
  [0.36, 0.6, 0.34], // verde bandera
  [0.79, 0.44, 0.55], // rosa palo
  [0.87, 0.72, 0.33], // oro viejo
  [0.33, 0.63, 0.76], // celeste
  [0.6, 0.66, 0.32], // oliva
];

/** Deterministic per-city color from a hash of the city id. FNV-1a + an
 *  avalanche step distributes near-identical ids (repos that share a long
 *  path prefix) across the palette far better than the old djb2 `% n`,
 *  which collided three sibling repos onto one color. */
function cityColorFromId(id: string): [number, number, number] {
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
  const removed = city!;
  // The hex stays on the map with its terrain: deleting it left a permanent
  // hole, live and after a reload.
  const cityTile = world.tiles.get(tileKey(removed.coord));
  if (cityTile?.city === removed) cityTile.city = undefined;
  // The districts belong to the city: free their tiles so their labels stop
  // drawing and the editor can erase or reuse them.
  for (const district of removed.districts) {
    const tile = world.tiles.get(tileKey(district.coord));
    if (tile?.district?.id === district.id) tile.district = undefined;
  }
  // The vacated hexes pass to the neighbouring cities.
  recalculateAllTerritories(world);
  // Remove any units on this city
  world.units = world.units.filter((u) => tileKey(u.coord) !== tileKey(removed.coord));
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
 * Synchronous core of `relocateCity`: moves the center, districts, units and
 * territory inside the world, with no persistence and no reconnection.
 * `applyMapEdits` needs it to reposition hand-moved cities on a reload.
 */
export function moveCityInWorld(world: World, city: City, targetCoord: Axial): boolean {
  if (!canRelocateCityTo(world, city, targetCoord)) return false;

  const tiles = world.tiles;
  const delta = axialSub(targetCoord, city.coord);
  const oldCoord = city.coord;
  const oldCityTile = tiles.get(tileKey(oldCoord));
  const destKey = tileKey(targetCoord);

  // 1) Resolve every destination before touching anything. A district can land
  //    on the hex another district is leaving, so all the sources have to be
  //    copied first; a missing tile aborts without mutating the world.
  const districtMoves = city.districts.map((district) => ({
    district,
    to: axialAdd(district.coord, delta),
    src: tiles.get(tileKey(district.coord)),
  }));
  if (!oldCityTile || !tiles.has(destKey)) return false;
  if (districtMoves.some((m) => !tiles.has(tileKey(m.to)))) return false;

  // 2) Release the sources: no tile is deleted — the hexes stay on the map with
  //    their terrain, they just stop belonging to the city.
  oldCityTile.city = undefined;
  for (const m of districtMoves) {
    if (m.src?.district?.id === m.district.id) m.src.district = undefined;
  }

  // 3) Place the districts, carrying the terrain, resources and metadata of
  //    their own origin.
  for (const m of districtMoves) {
    const key = tileKey(m.to);
    const base = tiles.get(key)!;
    m.district.coord = m.to;
    tiles.set(key, {
      ...(m.src ?? base),
      coord: m.to,
      district: m.district,
    });
  }

  // 4) Place the city center on its destination (preserve metadata from the old
  //    city tile).
  city.coord = targetCoord;
  const destBase = tiles.get(destKey)!;
  const merged: Tile = {
    ...destBase,
    coord: targetCoord,
    terrain: oldCityTile.terrain,
    resources: oldCityTile.resources,
    city,
    district: undefined,
    skillHealth: oldCityTile.skillHealth ?? destBase.skillHealth,
    sessionTint: oldCityTile.sessionTint ?? destBase.sessionTint,
  };
  tiles.set(destKey, merged);

  // 5) Move units standing on the city center hex with the city
  for (const u of world.units) {
    if (axialEquals(u.coord, oldCoord)) u.coord = targetCoord;
  }

  recalculateAllTerritories(world);
  return true;
}

/** Origin → destination of every hex in the city's footprint for a move. */
function cityFootprintMoves(city: City, targetCoord: Axial): Array<{ from: Axial; to: Axial }> {
  const delta = axialSub(targetCoord, city.coord);
  return [
    { from: city.coord, to: targetCoord },
    ...city.districts.map((d) => ({ from: d.coord, to: axialAdd(d.coord, delta) })),
  ];
}

/**
 * Remember the new coordinate of a moved city, whatever it came from:
 * a manual layout entry (keyed by the stable repo id), a `placedCities` entry
 * (keyed by the path `placeCity` used) or the automatic world generation.
 * Auto-generated cities get a `placedCities` entry too, which survives the
 * reload without adding a fake row to the construction panel (that panel lists
 * `manualLayout` entries only).
 *
 * The painted terrain travels with the footprint too: the live move carries each
 * origin's terrain to its destination, so the saved overrides have to follow or
 * a reload would paint the old terrain over the moved city.
 */
function persistCityCoord(
  city: City,
  coord: Axial,
  footprint: Array<{ from: Axial; to: Axial }>,
): MovedCityPersist {
  const prev: MovedCityPersist = { manual: null, placed: null, placedExisted: false, terrain: [] };

  // Read every origin before writing any: a short move makes one origin the
  // destination of another hex of the same city.
  const saved = footprint.map((m) => ({ to: m.to, terrain: terrainOverrideFor(m.from) }));
  for (const m of saved) prev.terrain.push({ coord: m.to, terrain: terrainOverrideFor(m.to) });
  for (const m of saved) {
    if (m.terrain) setHexTerrain(m.to, m.terrain);
    else clearHexTerrain(m.to);
  }

  const manual = loadManualLayout().entries.find(
    (e) =>
      e.repoPath === city.id ||
      e.repoPath === city.repoPath ||
      e.repoFsPath === city.id ||
      (!!city.repoPath && e.repoFsPath === city.repoPath),
  );
  if (manual) {
    prev.manual = { repoPath: manual.repoPath, coord: { ...manual.coord } };
    updateManualRepoCoord(manual.repoPath, coord);
    return prev;
  }

  const placed = findPlacedCityEntry(city);
  if (placed) {
    prev.placed = {
      repoPath: placed.repoPath,
      repoName: placed.repoName,
      coord: { ...placed.coord },
    };
    prev.placedExisted = true;
    placeCity({ repoPath: placed.repoPath, repoName: placed.repoName, coord });
    return prev;
  }

  const created = { repoPath: city.repoPath ?? city.id, repoName: city.name, coord: { ...coord } };
  prev.placed = created;
  placeCity(created);
  return prev;
}

/**
 * Synchronous half of `relocateCity`: resolves the city key, moves the city in
 * the world and records the new coordinate, returning what the move took. The
 * editor's drag and its redo need the result without waiting for
 * `reconnectCities`, so that part lives in `relocateCity`.
 */
export function moveCitySync(
  world: World,
  cityId: string,
  targetCoord: Axial,
  repoPathFallback: string | null,
): MovedCity | null {
  const city = world.cities.find((c) => c.id === cityId);
  if (!city) return null;
  // `city.repoPath` is the city key across reloads: only a real path may land
  // there. The stable id lives in `city.id`. Resolve it before the move so the
  // persisted key is the absolute path.
  const prevRepoPath = city.repoPath;
  const path = resolveRepoPathForCity(city, repoPathFallback);
  if (path && isFilesystemPath(path)) city.repoPath = path;
  const moved = moveCityOp(world, city, targetCoord, { record: true });
  if (!moved) {
    city.repoPath = prevRepoPath;
    return null;
  }
  // Undo has to put the original value back, not the one this call resolved.
  moved.prevRepoPath = prevRepoPath;
  return moved;
}

export async function relocateCity(
  world: World,
  cityId: string,
  targetCoord: Axial,
  repoPathFallback: string | null,
): Promise<MovedCity | null> {
  const moved = moveCitySync(world, cityId, targetCoord, repoPathFallback);
  if (!moved) return null;
  invalidatePathCache();
  await reconnectCities(world);
  return moved;
}

// ─── World generator ─────────────────────────────────────────────────
/**
 * Hexes taken by a city center or a district. Those are never free to paint
 * over, erase or place a city on.
 */
function occupiedCityCoords(world: World): Set<string> {
  const occupied = new Set<string>();
  for (const city of world.cities) {
    occupied.add(tileKey(city.coord));
    for (const district of city.districts) occupied.add(tileKey(district.coord));
  }
  return occupied;
}

/**
 * The disk repo a placement entry points to: exact keys first (`repoPath` /
 * `path`), and the repo name only when exactly one repo carries it. Two repos
 * called `api` in different folders must not be guessed.
 */
function findDiskRepoForEntry(
  diskRepos: ScannedRepo[],
  entry: PlacedCityEntry,
): ScannedRepo | undefined {
  const exact = diskRepos.find(
    (r) =>
      r.repoPath === entry.repoPath || r.path === entry.repoPath || r.repoPath === entry.repoName,
  );
  if (exact) return exact;
  const byName = diskRepos.filter((r) => r.name === entry.repoName);
  return byName.length === 1 ? byName[0] : undefined;
}

// ─── Map edit operations ────────────────────────────────────────────────────
//
// One version of every edit rule, shared by the live editor (renderer.ts) and
// the reload (applyMapEdits). They never touch GameState, the path cache or the
// UI — that is the caller's business. With `record: true` they also persist the
// edit in localStorage and return what an undo would need to put it back.

export interface MapEditOpts {
  /** Persist the edit (the live editor does; a reload replays without saving). */
  record: boolean;
}

/** What taking a city off the map removed, for undo. */
export interface RemovedCity {
  city: City;
  /** Position in world.cities before the removal. */
  index: number;
  /** Units that leave with the city: its workers and the ones on its hex. */
  units: Unit[];
  /** placedCities entry the city owned, if any. */
  placedEntry: PlacedCityEntry | null;
  /** Whether removedCities already carried the city key. */
  wasRemovedKey: boolean;
}

/** Saved state a move overwrote, for undo. */
export interface MovedCityPersist {
  /** Manual layout entry the move updated (its stable key) and its old coord. */
  manual: { repoPath: string; coord: Axial } | null;
  /** placedCities entry the move updated or created, with its old coord. */
  placed: { repoPath: string; repoName: string; coord: Axial } | null;
  /** False when the move created the entry (undo removes it). */
  placedExisted: boolean;
  /** Saved terrain override per destination hex, before the move. */
  terrain: Array<{ coord: Axial; terrain: Terrain | null }>;
}

export interface MovedCity {
  city: City;
  from: Axial;
  to: Axial;
  /** `city.repoPath` before the move (relocateCity may have set it). */
  prevRepoPath: string | undefined;
  /** Copies of every footprint tile (origins and destinations) before the move. */
  prevTiles: Array<{ coord: Axial; tile: Tile }>;
  /** District coordinates before the move. */
  prevDistrictCoords: Array<{ district: District; coord: Axial }>;
  /** Units that travelled with the city (they stood on the old centre hex). */
  units: Unit[];
  /** Null when the move was replayed with `record: false`. */
  prevPersist: MovedCityPersist | null;
}

/** What founding a city replaced, for undo. */
export interface FoundedCity {
  city: City;
  /** The tile addCityToWorld replaced on that hex. */
  prevTile: Tile;
  /** Whether removedCities already carried the key before founding. */
  wasRemovedKey: boolean;
  /** placedCities entry the repo already had, if any. */
  prevPlaced: PlacedCityEntry | null;
}

const NO_RECORD: MapEditOpts = { record: false };
const PAINTABLE = new Set<string>(PAINTABLE_TERRAINS);

/** A hex can be painted unless it is missing or the capital's sacred ground. */
export function canPaintHex(world: World, coord: Axial): boolean {
  const tile = world.tiles.get(tileKey(coord));
  return !!tile && !tile.city?.isCapital;
}

export function paintHexOp(
  world: World,
  coord: Axial,
  terrain: Terrain,
  opts: MapEditOpts,
): { prevTerrain: Terrain; prevOverride: Terrain | null } | null {
  if (!canPaintHex(world, coord) || !PAINTABLE.has(terrain)) return null;
  const tile = world.tiles.get(tileKey(coord))!;
  const prevTerrain = tile.terrain;
  const prevOverride = terrainOverrideFor(coord);
  // Brush early exit: the hex already shows this terrain and is saved that way,
  // so there is nothing to write or redraw.
  if (opts.record && prevTerrain === terrain && prevOverride === terrain) return null;
  if (opts.record) setHexTerrain(coord, terrain);
  tile.terrain = terrain;
  return { prevTerrain, prevOverride };
}

/** A hex can be erased unless it holds a city, a district or belongs to one. */
export function canEraseHex(world: World, coord: Axial): boolean {
  const tile = world.tiles.get(tileKey(coord));
  if (!tile) return false;
  if (tile.city || tile.district) return false;
  return !occupiedCityCoords(world).has(tileKey(coord));
}

export function eraseHexOp(world: World, coord: Axial, opts: MapEditOpts): Tile | null {
  if (!canEraseHex(world, coord)) return null;
  const key = tileKey(coord);
  const tile = world.tiles.get(key)!;
  if (opts.record) removeHex(coord);
  world.tiles.delete(key);
  for (const city of world.cities) {
    city.territory = city.territory.filter((c) => world.tiles.has(tileKey(c)));
  }
  return tile;
}

/** A city can be taken off the map unless it is the capital. */
export function canRemoveCity(world: World, city: City): boolean {
  return !city.isCapital && world.cities.includes(city);
}

export function removeCityOp(world: World, city: City, opts: MapEditOpts): RemovedCity | null {
  if (!canRemoveCity(world, city)) return null;
  const index = world.cities.indexOf(city);
  // Units leave with the city: collect them before it disappears (the live
  // editor removes them through GameState, a reload filters world.units).
  const units = world.units.filter(
    (u) => u.cityId === city.id || tileKey(u.coord) === tileKey(city.coord),
  );
  const placedEntry = findPlacedCityEntry(city);
  const key = cityKey(city);
  const wasRemovedKey = isCityRemoved(key);
  if (opts.record) {
    if (placedEntry) removePlacedCity(placedEntry.repoPath);
    removeCityFromMap(key);
  }
  removeCityFromWorld(world, city.id);
  return { city, index, units, placedEntry, wasRemovedKey };
}

/** A repo can be founded on a free hex that is not the ocean. */
export function canFoundCity(world: World, repo: ScannedRepo, coord: Axial): boolean {
  const tile = world.tiles.get(tileKey(coord));
  if (!tile || tile.city || tile.district) return false;
  if (tile.terrain === 'ocean') return false;
  if (occupiedCityCoords(world).has(tileKey(coord))) return false;
  // One city per repo: compare every key the city may be stored under.
  const key = repo.repoPath ?? repo.path;
  return !world.cities.some(
    (c) => c.id === key || c.repoPath === key || c.id === repo.path || c.repoPath === repo.path,
  );
}

export function foundCityOp(
  world: World,
  repo: ScannedRepo,
  coord: Axial,
  opts: MapEditOpts,
): FoundedCity | null {
  if (!canFoundCity(world, repo, coord)) return null;
  const prevTile = world.tiles.get(tileKey(coord))!;
  const key = repo.repoPath ?? repo.path;
  const wasRemovedKey = isCityRemoved(key);
  const prevPlaced = getMapEdits().placedCities.find((p) => p.repoPath === key) ?? null;
  // A painted hex keeps its painted terrain; an unpainted one is plains, like
  // after a reload (the fill terrain is randomized per load).
  const city = addCityToWorld(
    world,
    { ...repo, terrain: terrainOverrideFor(coord) ?? undefined },
    coord,
  );
  if (opts.record) placeCity({ repoPath: key, repoName: repo.name, coord });
  return { city, prevTile, wasRemovedKey, prevPlaced };
}

export function moveCityOp(
  world: World,
  city: City,
  coord: Axial,
  opts: MapEditOpts,
): MovedCity | null {
  if (!world.cities.includes(city)) return null;
  const from = city.coord;
  const prevRepoPath = city.repoPath;
  // Footprint before the move: it drives both the terrain that travels with the
  // city and the saved overrides.
  const footprint = cityFootprintMoves(city, coord);
  const prevTiles = footprintTileCopies(world, footprint);
  const prevDistrictCoords = city.districts.map((district) => ({
    district,
    coord: { ...district.coord },
  }));
  const units = world.units.filter((u) => axialEquals(u.coord, from));
  if (!moveCityInWorld(world, city, coord)) return null;
  const prevPersist = opts.record ? persistCityCoord(city, coord, footprint) : null;
  return { city, from, to: coord, prevRepoPath, prevTiles, prevDistrictCoords, units, prevPersist };
}

/** Shallow copies of every footprint tile (origins + destinations), deduped. */
function footprintTileCopies(
  world: World,
  footprint: Array<{ from: Axial; to: Axial }>,
): Array<{ coord: Axial; tile: Tile }> {
  const seen = new Set<string>();
  const copies: Array<{ coord: Axial; tile: Tile }> = [];
  for (const move of footprint) {
    for (const coord of [move.from, move.to]) {
      const key = tileKey(coord);
      if (seen.has(key)) continue;
      const tile = world.tiles.get(key);
      if (!tile) continue;
      seen.add(key);
      copies.push({ coord, tile: { ...tile } });
    }
  }
  return copies;
}

// ─── Inverses ───────────────────────────────────────────────────────────────
//
// Each one puts back exactly what its operation changed, in the world and in
// the saved store — never the whole store: a nation or a city created between
// the edit and its undo must survive. Redo is the operation itself.

export function undoPaintHex(
  world: World,
  coord: Axial,
  result: { prevTerrain: Terrain; prevOverride: Terrain | null },
): void {
  const tile = world.tiles.get(tileKey(coord));
  if (tile) tile.terrain = result.prevTerrain;
  if (result.prevOverride) setHexTerrain(coord, result.prevOverride);
  else clearHexTerrain(coord);
}

export function undoEraseHex(world: World, tile: Tile): void {
  world.tiles.set(tileKey(tile.coord), tile);
  restoreHex(tile.coord);
  recalculateAllTerritories(world);
}

export function undoRemoveCity(world: World, removed: RemovedCity): void {
  const { city } = removed;
  const index =
    removed.index >= 0 && removed.index <= world.cities.length
      ? removed.index
      : world.cities.length;
  world.cities.splice(index, 0, city);
  const cityTile = world.tiles.get(tileKey(city.coord));
  if (cityTile) cityTile.city = city;
  for (const district of city.districts) {
    const tile = world.tiles.get(tileKey(district.coord));
    if (tile) tile.district = district;
  }
  if (removed.placedEntry) {
    placeCity({
      repoPath: removed.placedEntry.repoPath,
      repoName: removed.placedEntry.repoName,
      coord: removed.placedEntry.coord,
    });
  }
  if (!removed.wasRemovedKey) restoreCityToMap(cityKey(city));
  recalculateAllTerritories(world);
}

export function undoFoundCity(world: World, found: FoundedCity): void {
  const { city } = found;
  const key = city.repoPath ?? city.id;
  removeCityFromWorld(world, city.id);
  world.tiles.set(tileKey(found.prevTile.coord), found.prevTile);
  if (found.prevPlaced) {
    placeCity({
      repoPath: found.prevPlaced.repoPath,
      repoName: found.prevPlaced.repoName,
      coord: found.prevPlaced.coord,
    });
  } else {
    removePlacedCity(key);
  }
  if (found.wasRemovedKey) removeCityFromMap(cityKey(city));
  recalculateAllTerritories(world);
}

export function undoMoveCity(world: World, moved: MovedCity): void {
  const { city } = moved;
  // The copies point at the same city/district objects, so the links come back
  // with them (origins keep their terrain, destinations lose what the move put
  // there).
  for (const { coord, tile } of moved.prevTiles) world.tiles.set(tileKey(coord), tile);
  city.coord = { ...moved.from };
  city.repoPath = moved.prevRepoPath;
  for (const { district, coord } of moved.prevDistrictCoords) district.coord = coord;
  for (const unit of moved.units) unit.coord = { ...moved.from };
  restorePersist(moved.prevPersist);
  recalculateAllTerritories(world);
}

/** Put the saved state a move overwrote back (coordinates and terrain). */
function restorePersist(prev: MovedCityPersist | null): void {
  if (!prev) return;
  if (prev.manual) updateManualRepoCoord(prev.manual.repoPath, prev.manual.coord);
  if (prev.placed) {
    if (prev.placedExisted) {
      placeCity({
        repoPath: prev.placed.repoPath,
        repoName: prev.placed.repoName,
        coord: prev.placed.coord,
      });
    } else {
      removePlacedCity(prev.placed.repoPath);
    }
  }
  for (const saved of prev.terrain) {
    if (saved.terrain) setHexTerrain(saved.coord, saved.terrain);
    else clearHexTerrain(saved.coord);
  }
}

/**
 * Applies the manual map edits (painted terrain, erased hexes, cities taken
 * off the map and cities placed by hand) onto a freshly generated world.
 *
 * Runs before the territory recalculation so the edited map is the one that
 * gets Voronoi'd, and never touches the filesystem: a removed city is only
 * removed from the map, the repo stays on disk.
 */
export function applyMapEdits(world: World, diskRepos: ScannedRepo[] = []): void {
  const edits = getMapEdits();
  const hasEdits =
    edits.removedCities.length > 0 ||
    edits.removedHexes.length > 0 ||
    edits.placedCities.length > 0 ||
    Object.keys(edits.terrain).length > 0;
  if (!hasEdits) {
    applyNationsToWorld(world);
    return;
  }

  // 1) Cities the user took off the map.
  for (const key of edits.removedCities) {
    const city = world.cities.find((c) => cityKey(c) === key || c.id === key);
    if (!city) continue;
    if (!removeCityOp(world, city, NO_RECORD)) continue;
    // Units working in that city leave with it.
    world.units = world.units.filter((u) => u.cityId !== city.id);
  }

  // 2) Cities the user placed (or repositioned) by hand. Two passes: first
  //    move the cities already in the world, then (after the painted terrain)
  //    place the new ones. Moving frees the hex the city came from, and the
  //    order of the entries must not decide whether a placement fits.
  const placedEntries = edits.placedCities.filter((e) => !edits.removedCities.includes(e.repoPath));
  // (a) Move the cities already in the world. Repeat until a full round moves
  // nothing: a city may be waiting for the hex another one is about to leave,
  // so the entry order must not decide the outcome. A pure swap (A↔B) stays
  // unsolved and is reported below.
  let pendingMoves = placedEntries.flatMap((entry) => {
    const city = world.cities.find((c) => cityKey(c) === entry.repoPath || c.id === entry.repoPath);
    return city && !axialEquals(city.coord, entry.coord) ? [{ entry, city }] : [];
  });
  while (pendingMoves.length > 0) {
    const moved = pendingMoves.filter((p) => moveCityOp(world, p.city, p.entry.coord, NO_RECORD));
    if (moved.length === 0) break;
    pendingMoves = pendingMoves.filter((p) => !moved.includes(p));
  }
  for (const pending of pendingMoves) {
    logger.warn(
      `[map] no pude devolver ${pending.city.name} a (${pending.entry.coord.q}, ${pending.entry.coord.r})`,
    );
  }

  // 3) Painted terrain, before founding a city: a hex painted to land is city
  //    ground, and the ocean rule is then the same live and on reload.
  for (const [key, terrain] of Object.entries(edits.terrain)) {
    const tile = world.tiles.get(key);
    if (!tile) continue;
    paintHexOp(world, tile.coord, terrain, NO_RECORD);
  }

  // 4) Cities the user placed by hand (on the map as it looks after step 3).
  for (const entry of placedEntries) {
    const repo = findDiskRepoForEntry(diskRepos, entry);
    if (!repo) continue;
    const repoKey = repo.repoPath ?? repo.path;
    // The entry may describe a city that is already on the map (the editor
    // moved it) or one the user removed — also after the repo folder moved.
    const alreadyThere = world.cities.some(
      (c) => cityKey(c) === repoKey || c.id === repo.path || c.repoPath === repo.path,
    );
    if (alreadyThere) continue;
    if (edits.removedCities.includes(repoKey) || edits.removedCities.includes(repo.path)) {
      continue;
    }
    if (!foundCityOp(world, repo, entry.coord, NO_RECORD)) {
      logger.warn(
        `[map] no pude colocar ${repo.name} en (${entry.coord.q}, ${entry.coord.r}): el hex no está libre`,
      );
    }
  }

  // 5) Erased hexes. City and district hexes are protected by the shared rule —
  //    erase the city itself instead of punching a hole under it.
  for (const key of edits.removedHexes) {
    const tile = world.tiles.get(key);
    if (!tile) continue;
    eraseHexOp(world, tile.coord, NO_RECORD);
  }
  // 6) Territories follow the tiles that are left, then the nation layer.
  for (const city of world.cities) {
    city.territory = city.territory.filter((c) => world.tiles.has(tileKey(c)));
  }

  applyNationsToWorld(world);
  invalidatePathCache();
}

export async function generateWorld(): Promise<World> {
  const MIN_CITY_DISTANCE = 3;
  const tiles = new Map<string, Tile>();
  const cities: City[] = [];
  // Shared selection (state.json, served by /api/repo-selections) is the source
  // of truth; the client-side cache is only a mirror and offline fallback.
  let selectedRepoPaths = loadSelectedRepoPaths();

  // Workspace scan is the source of truth for which repos exist on this machine.
  let diskRepos: ScannedRepo[] | null = null;
  try {
    diskRepos = await fetchScannedRepos();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('[map] /api/repos failed', e);
    showMapLoadError(`No pude cargar repos reales: ${message}`);
  }

  // Fetch real repos — shared selection wins; the cache only fills in when the
  // shared state has no selections at all (e.g. bridge down on a stale browser).
  let repos: ScannedRepo[] = [];
  let selectionFromShared = false;
  try {
    const shared = await fetchRepoSelectionState();
    if (shared.selectedRepoPaths.length > 0) {
      selectionFromShared = true;
      const sharedPaths = new Set(shared.selectedRepoPaths);
      selectedRepoPaths = sharedPaths;
      saveSelectedRepoPaths(shared.selectedRepoPaths); // re-mirror the cache
      repos = (diskRepos ?? []).filter((repo) => repoMatchesSelection(repo, sharedPaths));
    }
  } catch (e) {
    logger.error('[map] /api/repo-selections failed', e);
  }

  if (!selectionFromShared) {
    try {
      if (selectedRepoPaths !== null && selectedRepoPaths.size > 0) {
        repos = (diskRepos ?? []).filter((repo) => repoMatchesSelection(repo, selectedRepoPaths));
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
  }

  if (selectedRepoPaths !== null && selectedRepoPaths.size > 0) {
    repos = repos.filter((repo) => repoMatchesSelection(repo, selectedRepoPaths));
  }

  const manualLayout = loadManualLayout();
  const manualRepoMap = new Map<string, Axial>();
  for (const entry of manualLayout.entries) {
    manualRepoMap.set(entry.repoPath, { q: entry.coord.q, r: entry.coord.r });
    const coord = { q: entry.coord.q, r: entry.coord.r };
    const exact = repos.find(
      (repo) =>
        repo.path === entry.repoPath ||
        repo.repoPath === entry.repoPath ||
        (entry.repoFsPath && repo.repoPath === entry.repoFsPath),
    );
    // Only when no key matches: two repos can share a name.
    const existing = exact ?? repos.find((repo) => repo.name === entry.repoName);
    if (existing) {
      existing.manualCoord = coord;
      continue;
    }
    const ghost: ScannedRepo = {
      name: entry.repoName,
      path: entry.repoPath,
      repoPath: entry.repoFsPath,
      population: 0,
      extensions: {},
      gold: 0,
      lastCommitDays: 999,
      isLegacy: false,
      hasGit: false,
      manualCoord: coord,
    };
    const onDisk = diskRepos ? findRepoOnDisk(ghost, diskRepos) : undefined;
    if (onDisk) {
      repos.push({ ...onDisk, manualCoord: coord });
    }
  }

  if (diskRepos) {
    repos = filterReposToDisk(repos, diskRepos);
  }
  // Sort: preserve selection order if available, otherwise most-populated first → capital
  if (selectedRepoPaths !== null) {
    // Preserve selection order: selectedRepoPaths is a Set, convert to Array to iterate in insertion order
    const selectedOrder = Array.from(selectedRepoPaths);
    const orderedRepos: ScannedRepo[] = [];
    for (const path of selectedOrder) {
      const found = repos.find(
        (r) =>
          selectionIncludesValue(selectedRepoPaths, path) && selectionKeysForRepo(r).includes(path),
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
    // Keep the coord the manual loop resolved: an old entry keyed by the
    // absolute path is not in manualRepoMap (keyed by the stable id).
    manualCoord: r.manualCoord ?? manualRepoMap.get(r.path),
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
  // Hexes the user already chose for a city in the editor, keyed by the entry
  // that owns them: the automatic layout leaves each one free for its own city
  // (a city moved back to its generated hex keeps it) and out of the way for
  // the rest, so applyMapEdits can put the city back there.
  const placedHexOwners = new Map<string, string>();
  const mapEdits = getMapEdits();
  for (const entry of mapEdits.placedCities) {
    if (mapEdits.removedCities.includes(entry.repoPath)) continue;
    placedHexOwners.set(tileKey(entry.coord), entry.repoPath);
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
      // A hex saved by the editor is skipped only when it belongs to another
      // city. persistCityCoord saves `city.repoPath ?? city.id`.
      const owner = placedHexOwners.get(key);
      const ownsHex = owner === (repo.repoPath ?? repo.path) || owner === repo.path;
      if (owner !== undefined && !ownsHex) continue;

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
      repoPath: repo.repoPath ?? repo.path,
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

  // Manual map edits (terrain paint, erased hexes, hand-placed cities) are
  // applied before the territory pass so the edited map is the one Voronoi'd.
  applyMapEdits(world, diskRepos ?? repos);

  // Recalculate territories dynamically to prevent overlaps (Civilization Voronoi)
  recalculateAllTerritories(world);

  // Reconnect cities dynamically (BFS + A* + intermediate tiles)
  await reconnectCities(world);

  // The nation layer is editorial: re-apply it last so a hand-picked flag
  // color survives every world regeneration.
  applyNationsToWorld(world);

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
