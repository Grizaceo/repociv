// ─── RepoCiv — A* Pathfinding ─────────────────────────────────────────────────

import type { Axial } from './hex.ts';
import type { World } from './types.ts';
import { axialDistance, axialNeighbours } from './hex.ts';
import { tileKey } from './types.ts';

// ─── Terrain movement costs by unit type ─────────────────────────────────────
const TERRAIN_COSTS: Record<string, Record<string, number>> = {
  hero: { plains: 1, forest: 1, mountain: 1, desert: 1, ocean: Infinity, ice: 3 },
  worker: { plains: 1, forest: 2, mountain: Infinity, desert: 1, ocean: Infinity, ice: 2 },
  scout: { plains: 1, forest: 1.5, mountain: 4, desert: 1, ocean: Infinity, ice: 2 },
  lexo: { plains: 1, forest: 1, mountain: 1, desert: 1, ocean: Infinity, ice: 3 },
  army: { plains: 1, forest: 2, mountain: 2, desert: 1, ocean: Infinity, ice: 2 },
  caravan: { plains: 1, forest: 2, mountain: Infinity, desert: 1, ocean: Infinity, ice: Infinity },
  openclaw: { plains: 1, forest: 1, mountain: 1, desert: 1, ocean: Infinity, ice: 3 },
  claude: { plains: 1, forest: 1, mountain: 1, desert: 1, ocean: Infinity, ice: 3 },
  codex: { plains: 1, forest: 1, mountain: 1, desert: 1, ocean: Infinity, ice: 3 },
};

const DEFAULT_COSTS = TERRAIN_COSTS['hero']!;

function getCost(unitType: string, terrain: string): number {
  const costs = TERRAIN_COSTS[unitType] ?? DEFAULT_COSTS;
  return costs[terrain] ?? 1;
}

// ─── Path cache (cleared when world mutates) ─────────────────────────────────
const _cache = new Map<string, Axial[]>();

export function invalidatePathCache(): void {
  _cache.clear();
}

// ─── A* ──────────────────────────────────────────────────────────────────────
export function aStarPath(start: Axial, goal: Axial, world: World, unitType: string): Axial[] {
  if (start.q === goal.q && start.r === goal.r) return [start];

  const cacheKey = `${start.q},${start.r}→${goal.q},${goal.r}:${unitType}`;
  const cached = _cache.get(cacheKey);
  if (cached !== undefined) return cached;

  type Node = { coord: Axial; f: number; g: number };

  const open: Node[] = [{ coord: start, f: axialDistance(start, goal), g: 0 }];
  const gScore = new Map<string, number>([[tileKey(start), 0]]);
  const parent = new Map<string, Axial | null>([[tileKey(start), null]]);
  const closed = new Set<string>();

  while (open.length > 0) {
    // Pop node with lowest f (simple sort — fine for <300-hex maps)
    open.sort((a, b) => a.f - b.f);
    const current = open.shift()!;
    const ck = tileKey(current.coord);

    if (current.coord.q === goal.q && current.coord.r === goal.r) {
      const path = _reconstruct(parent, goal);
      _cache.set(cacheKey, path);
      return path;
    }

    if (closed.has(ck)) continue;
    closed.add(ck);

    for (const nb of axialNeighbours(current.coord)) {
      const nk = tileKey(nb);
      if (closed.has(nk)) continue;

      const tile = world.tiles.get(nk);
      if (!tile) continue;

      const cost = getCost(unitType, tile.terrain);
      if (cost === Infinity) continue;

      const tentG = current.g + cost;
      const bestG = gScore.get(nk) ?? Infinity;
      if (tentG < bestG) {
        gScore.set(nk, tentG);
        parent.set(nk, current.coord);
        open.push({ coord: nb, f: tentG + axialDistance(nb, goal), g: tentG });
      }
    }
  }

  _cache.set(cacheKey, []);
  return [];
}

function _reconstruct(parent: Map<string, Axial | null>, goal: Axial): Axial[] {
  const path: Axial[] = [];
  let node: Axial | null = goal;
  while (node !== null) {
    path.unshift(node);
    node = parent.get(tileKey(node)) ?? null;
  }
  return path;
}
