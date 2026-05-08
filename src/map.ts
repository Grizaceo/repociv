// ─── RepoCiv — Map Generator ─────────────────────────────────────────────────
// Fetches real workspace metadata from /api/repos and builds a hex tile world.

import { logger } from './logger.ts';
import { type Axial, spiralCoords, axialDistance, axialNeighbours } from './hex.ts';
import { type Terrain, type Tile, type City, type District, type World, tileKey } from './types.ts';
import { loadManualLayout } from './manualLayout.ts';
import { aStarPath, invalidatePathCache } from './pathfinding.ts';

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

// ─── Terrain colors (Canvas fill) ──────────────────────────────────────────
export const TERRAIN_COLOR: Record<
  Terrain,
  { fill: string; stroke: string; gradient?: [string, string] }
> = {
  plains: { fill: '#7ba05b', stroke: '#5a7a3a', gradient: ['#8db870', '#6a8f4a'] },
  forest: { fill: '#2d5a27', stroke: '#1e3d18', gradient: ['#3a7032', '#234a1f'] },
  mountain: { fill: '#6b6b6b', stroke: '#4a4a4a', gradient: ['#7d7d7d', '#5a5a5a'] },
  desert: { fill: '#d4a574', stroke: '#b07a4a', gradient: ['#dfb285', '#c49564'] },
  ocean: { fill: '#2b6da5', stroke: '#1b5585', gradient: ['#3a8bc8', '#225590'] },
  ice: { fill: '#c8d8e0', stroke: '#a0b0c0', gradient: ['#ddeaf0', '#b0c0d0'] },
  hills: { fill: '#8da86b', stroke: '#6a8a4b', gradient: ['#9db87b', '#7a9a5b'] },
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
  path: string;
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

export async function fetchScannedRepos(): Promise<ScannedRepo[]> {
  const res = await fetch('/api/repos');
  if (!res.ok) throw new Error(`/api/repos HTTP ${res.status}`);
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

// ─── Reconnect disconnected cities (dynamic + initial generation) ────────────
export async function reconnectCities(world: World): Promise<void> {
  const { tiles, cities } = world;
  const capitalCity = cities.find(c => c.isCapital) ?? cities[0];
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
      const isConnectedTile = cities.some(c => 
        (c.coord.q === nb.q && c.coord.r === nb.r) || // city itself
        c.territory.some(t => t.q === nb.q && t.r === nb.r) // territory tile
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
        const data = await res.json() as { files: string[] };
        // Extract unique top-level folders
        const folders = new Set<string>();
        for (const f of data.files) {
          const slash = f.indexOf('/');
          if (slash > 0) folders.add(f.slice(0, slash));
        }
        folderStructure = Array.from(folders);
      }
    } catch { /* ignore */ }

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

// ─── Dynamic city add/remove helpers ────────────────────────────────
export function addCityToWorld(world: World, repo: ScannedRepo & { terrain?: Terrain; science?: number; production?: number }, coord: Axial): City {
  const city: City = {
    id: repo.name,
    name: repo.name,
    coord,
    population: repo.population,
    territory: [coord, ...axialRange(coord, 2)],
    districts: [],
    buildings: [],
    isCapital: false,
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
  return city;
}

export function removeCityFromWorld(world: World, cityName: string): boolean {
  const idx = world.cities.findIndex(c => c.name === cityName);
  if (idx === -1) return false;
  const [city] = world.cities.splice(idx, 1);
  // Remove city tile from world.tiles
  world.tiles.delete(tileKey(city!.coord));
  // Remove any units on this city
  world.units = world.units.filter(u => tileKey(u.coord) !== tileKey(city!.coord));
  return true;
}

// ─── World generator ─────────────────────────────────────────────────
export async function generateWorld(): Promise<World> {
  const tiles = new Map<string, Tile>();
  const cities: City[] = [];

  // Fetch real repos
  let repos: ScannedRepo[] = [];
  try {
    repos = await fetchScannedRepos();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('[map] /api/repos failed', e);
    showMapLoadError(`No pude cargar repos reales: ${message}`);
  }

  const selectedRepoPaths = loadSelectedRepoPaths();
  if (selectedRepoPaths !== null) {
    repos = repos.filter((repo) => selectedRepoPaths.has(repo.path));
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
      const found = repos.find((r) => r.path === path);
      if (found) orderedRepos.push(found);
    }
    // Add any remaining repos that weren't in selectedRepoPaths (e.g., manual entries)
    for (const repo of repos) {
      if (!selectedOrder.includes(repo.path)) orderedRepos.push(repo);
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

  // Find the "gris" repo and make it the capital (first in array, at 0,0)
  const grisIndex = cityRepos.findIndex((r) => r.path.endsWith('gris') || r.name === 'gris');
  if (grisIndex > 0) {
    // Move to front
    const [grisRepo] = cityRepos.splice(grisIndex, 1);
    if (grisRepo) {
      // Force capital to be at (0,0)
      grisRepo.manualCoord = { q: 0, r: 0 };
      cityRepos.unshift(grisRepo);
    }
  } else if (grisIndex === 0) {
    // Already first, just force to (0,0)
    if (cityRepos[0]) {
      cityRepos[0].manualCoord = { q: 0, r: 0 };
    }
  }

  const maxAutoCoords = Math.max(cityRepos.length * 4, cityRepos.length + 16);
  const cityCoords = spiralCoords({ q: 0, r: 0 }, maxAutoCoords);
  const occupiedCoords = new Set<string>();
  const cityCoordLookup = new Map<string, Axial>();
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

    const territory = [coord, ...axialRange(coord, 2)].filter(
      (c) => !districts.some((d) => d.coord.q === c.q && d.coord.r === c.r),
    );

    const city: City = {
      id: repo.name,
      name: repo.name,
      coord,
      population: repo.population,
      territory,
      districts,
      buildings: [],
      isCapital: i === 0,
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
  const padding = 3;
  for (let q = minQ - padding; q <= maxQ + padding; q++) {
    for (let r = minR - padding; r <= maxR + padding; r++) {
      const key = tileKey({ q, r });
      if (!existingKeys.has(key)) {
        tiles.set(key, {
          coord: { q, r },
          terrain: 'ocean',
          resources: { gold: 0, science: 0, production: 0 },
          inFog: true,
          revealed: false,
        });
      }
    }
  }

  const totalGold = reposWithTerrain.reduce((acc, r) => acc + r.gold, 0);
  const totalScience = reposWithTerrain.reduce((acc, r) => acc + r.science, 0);
  const totalProduction = reposWithTerrain.reduce((acc, r) => acc + r.production, 0);

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

function axialAdd(a: Axial, b: Axial): Axial {
  return { q: a.q + b.q, r: a.r + b.r };
}
