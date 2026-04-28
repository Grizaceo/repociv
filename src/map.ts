// ─── RepoCiv — Map Generator ─────────────────────────────────────────────────
// Fetches real workspace metadata from /api/repos and builds a hex tile world.

import {
  type Axial,
  spiralCoords,
} from './hex.ts';
import {
  type Terrain,
  type Tile,
  type City,
  type District,
  type World,
  tileKey,
} from './types.ts';

// ─── Terrain inference ──────────────────────────────────────────────────────
const EXTENSION_WEIGHT: Record<string, Terrain> = {
  // Web / frontend
  ts: 'plains', tsx: 'plains', js: 'plains', jsx: 'plains',
  vue: 'plains', svelte: 'plains', mjs: 'plains', cjs: 'plains',
  // ML / data
  py: 'forest', ipynb: 'forest', r: 'forest', jl: 'forest',
  // Systems / low-level
  rs: 'mountain', go: 'mountain', cpp: 'mountain', c: 'mountain',
  h: 'mountain', hpp: 'mountain', java: 'mountain', kt: 'mountain',
  // Binary / heavy
  pt: 'mountain', onnx: 'mountain', h5: 'mountain', pkl: 'mountain', db: 'mountain',
  // Docs / config
  md: 'desert', txt: 'desert', json: 'desert', yaml: 'desert',
  yml: 'desert', toml: 'desert', xml: 'desert', html: 'desert',
  css: 'desert', scss: 'desert', sh: 'desert', bash: 'desert',
};

const TERRAIN_WEIGHTS: Record<Terrain, number> = {
  plains: 1, forest: 2, mountain: 3, desert: 1, ocean: 1, ice: 1,
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
    if (score > bestScore) { bestScore = score; best = t; }
  }
  if (totalCounted === 0) return 'desert';
  return best;
}

// ─── Terrain colors (Canvas fill) ──────────────────────────────────────────
export const TERRAIN_COLOR: Record<Terrain, { fill: string; stroke: string; gradient?: [string, string] }> = {
  plains:   { fill: '#7ba05b', stroke: '#5a7a3a', gradient: ['#8db870', '#6a8f4a'] },
  forest:   { fill: '#2d5a27', stroke: '#1e3d18', gradient: ['#3a7032', '#234a1f'] },
  mountain: { fill: '#6b6b6b', stroke: '#4a4a4a', gradient: ['#7d7d7d', '#5a5a5a'] },
  desert:   { fill: '#d4a574', stroke: '#b07a4a', gradient: ['#dfb285', '#c49564'] },
  ocean:    { fill: '#2b6da5', stroke: '#1b5585', gradient: ['#3a8bc8', '#225590'] },
  ice:      { fill: '#c8d8e0', stroke: '#a0b0c0', gradient: ['#ddeaf0', '#b0c0d0'] },
  hills:    { fill: '#8da86b', stroke: '#6a8a4b', gradient: ['#9db87b', '#7a9a5b'] },
};

// ─── Skill & session metadata (from Hermes workspace) ───────────────────────
async function fetchSkillHealth(repoName: string): Promise<'ok' | 'stale' | 'broken' | undefined> {
  try {
    const res = await fetch(`/api/skill-health/${encodeURIComponent(repoName)}`);
    if (!res.ok) return undefined;
    const data = await res.json() as { health: 'ok' | 'stale' | 'broken' };
    return data.health;
  } catch {
    return undefined;
  }
}

async function fetchSessionTint(repoName: string): Promise<'bright' | 'normal' | 'fog' | undefined> {
  try {
    const res = await fetch(`/api/session-tint/${encodeURIComponent(repoName)}`);
    if (!res.ok) return undefined;
    const data = await res.json() as { tint: 'bright' | 'normal' | 'fog' };
    return data.tint;
  } catch {
    return undefined;
  }
}

// ─── ScannedRepo from /api/repos ────────────────────────────────────────────
interface ScannedRepo {
  name: string;
  path: string;
  population: number;
  extensions: Record<string, number>;
  gold: number;
  lastCommitDays: number;
  isLegacy: boolean;
  hasGit: boolean;
}

// ─── Top-level subdirs detection (best-effort from extensions distribution) ─
async function fetchSubdirs(repoName: string): Promise<{ name: string; terrain: Terrain }[]> {
  try {
    const res = await fetch(`/api/files/${repoName}`);
    if (!res.ok) return [];
    const data = await res.json() as { files: string[] };
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

// ─── World generator ─────────────────────────────────────────────────────────
export async function generateWorld(): Promise<World> {
  const tiles = new Map<string, Tile>();
  const cities: City[] = [];

  // Fetch real repos
  let repos: ScannedRepo[] = [];
  try {
    const res = await fetch('/api/repos');
    repos = await res.json() as ScannedRepo[];
  } catch (e) {
    console.error('[map] /api/repos failed', e);
  }

  // Sort: most-populated first → capital
  repos.sort((a, b) => b.population - a.population);

  // Inferred terrain per repo
  const reposWithTerrain = repos.map(r => ({
    ...r,
    terrain: r.isLegacy ? 'ice' as Terrain :
             r.population === 0 ? 'ocean' as Terrain :
             inferTerrain(r.extensions),
    science: Math.min(99, Math.floor(r.gold / 10)),
    production: Math.min(99, Math.floor(r.gold / 50)),
  }));

  const cityRepos = reposWithTerrain.filter(r => r.population > 5);
  const orphanRepos = reposWithTerrain.filter(r => r.population <= 5);
  const cityCoords = spiralCoords({ q: 0, r: 0 }, cityRepos.length);

  // Fetch subdirs + skill health + session tint in parallel
  const [subdirsPerRepo, skillHealthPerRepo, sessionTintPerRepo] = await Promise.all([
    Promise.all(cityRepos.map(r => fetchSubdirs(r.path))),
    Promise.all(cityRepos.map(r => fetchSkillHealth(r.name))),
    Promise.all(cityRepos.map(r => fetchSessionTint(r.name))),
  ]);

  for (let i = 0; i < cityRepos.length; i++) {
    const repo = cityRepos[i]!;
    const coord = cityCoords[i]!;
    const subdirs = subdirsPerRepo[i] ?? [];
    const skillHealth = skillHealthPerRepo[i];
    const sessionTint = sessionTintPerRepo[i];

    const districtCoords = spiralCoords(coord, Math.min(subdirs.length + 1, 7));
    const districts: District[] = subdirs.map((sub, j) => ({
      id: `${repo.name}-${sub.name}`,
      name: sub.name,
      type: sub.terrain === 'forest' ? 'campus' :
            sub.terrain === 'mountain' ? 'industrial' :
            sub.terrain === 'plains' ? 'commercial' : 'encamp',
      coord: districtCoords[j + 1] ?? axialAdd(coord, { q: j, r: 0 }),
    }));

    const territory = [coord, ...axialRange(coord, 2)].filter(
      c => !districts.some(d => d.coord.q === c.q && d.coord.r === c.r)
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

  let minQ = 0, maxQ = 0, minR = 0, maxR = 0;
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

  return {
    tiles,
    cities,
    units: [],
    buildings: [],
    resources: { gold: totalGold, science: totalScience, production: totalProduction },
    generatedAt: Date.now(),
    restAreas: [], // Phase 9: XCOM Context Fatigue
  };
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
