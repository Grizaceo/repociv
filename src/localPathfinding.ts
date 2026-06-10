// ─── RepoCiv — Local Pathfinder (A* grid, 4-directional) ─────────────────────
// Used for agents walking inside a LocalWorld grid.

import type { LocalWorld, LocalTile } from './types.ts';

// ─── Cost table per tile type ─────────────────────────────────────────────────
const TILE_COST: Record<string, number> = {
  floor: 1,
  path: 0.6, // agents prefer corridors
  aisle: 1, // interior office aisle (preferred routing)
  door: 2, // slower through doors
  workbench: 1,
  chair: 1.2,
  debris: 5, // very slow
  wall: Infinity, // impassable
  cubicle_partition: Infinity, // low partition — impassable
  // Office furniture (Phase 6)
  standing_desk: 1,
  whiteboard: 1,
  window: 1,
  planter: 1.5,
  watercooler: 1,
  sofa: 1.5,
  stairs: 1.5,
  // Impassable office fixtures
  phone_booth: Infinity,
  break_area: Infinity,
  meeting_room: Infinity,
  server_rack: Infinity,
  reception: Infinity,
};

export interface PathResult {
  path: Array<{ x: number; y: number }>;
  cost: number; // total path cost
}

// ─── A* on 2D grid ─────────────────────────────────────────────────────────────
export function findPath(
  world: LocalWorld,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): PathResult | null {
  const { grid } = world;
  const H = grid.length;
  const W = grid[0]?.length ?? 0;

  // Bounds check
  if (fromX < 0 || fromY < 0 || fromX >= W || fromY >= H) return null;
  if (toX < 0 || toY < 0 || toX >= W || toY >= H) return null;

  const fromTile = grid[fromY]![fromX]!;
  const toTile = grid[toY]![toX]!;
  if (!fromTile || !toTile) return null;

  const startCost = TILE_COST[fromTile.type] ?? 1;
  const endCost = TILE_COST[toTile.type] ?? 1;
  if (!isFinite(startCost) || !isFinite(endCost)) return null;

  // A* with binary heap (min-heap by f = g + h)
  const key = (x: number, y: number) => y * W + x;

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>(); // key → parent key
  const inOpen = new Set<number>();
  const closed = new Set<number>();

  // Simple priority queue via sorted array (fine for small grids)
  // For larger grids we'd use a real heap
  const openList: Array<{ key: number; f: number; g: number }> = [];

  const startKey = key(fromX, fromY);
  gScore.set(startKey, 0);
  openList.push({ key: startKey, f: heuristic(fromX, fromY, toX, toY), g: 0 });
  inOpen.add(startKey);

  const DIRS = [
    { dx: 0, dy: -1 }, // N
    { dx: 1, dy: 0 }, // E
    { dx: 0, dy: 1 }, // S
    { dx: -1, dy: 0 }, // W
  ];

  while (openList.length > 0) {
    // Pop node with lowest f
    openList.sort((a, b) => a.f - b.f);
    const current = openList.shift()!;
    const ck = current.key;
    inOpen.delete(ck);

    if (ck === key(toX, toY)) {
      // Reconstruct path
      return {
        path: reconstructPath(cameFrom, fromX, fromY, toX, toY, W),
        cost: current.g,
      };
    }

    if (closed.has(ck)) continue;
    closed.add(ck);

    const cx = ck % W;
    const cy = Math.floor(ck / W);

    for (const { dx, dy } of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;

      const nk = key(nx, ny);
      if (closed.has(nk)) continue;

      const tile = grid[ny]![nx]!;
      const moveCost = TILE_COST[tile.type] ?? 1;
      if (!isFinite(moveCost)) continue;

      const tentativeG = current.g + moveCost;
      const prevG = gScore.get(nk) ?? Infinity;

      if (tentativeG < prevG) {
        cameFrom.set(nk, ck);
        gScore.set(nk, tentativeG);
        const f = tentativeG + heuristic(nx, ny, toX, toY);
        if (!inOpen.has(nk)) {
          openList.push({ key: nk, f, g: tentativeG });
          inOpen.add(nk);
        }
      }
    }
  }

  return null; // no path found
}

// ─── Chebyshev distance (admissible heuristic for 4-dir) ───────────────────────
function heuristic(x1: number, y1: number, x2: number, y2: number): number {
  // 4-dir: Manhattan distance
  return Math.abs(x2 - x1) + Math.abs(y2 - y1);
}

// ─── Reconstruct path from cameFrom map ─────────────────────────────────────────
function reconstructPath(
  cameFrom: Map<number, number>,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  W: number,
): Array<{ x: number; y: number }> {
  const path: Array<{ x: number; y: number }> = [];
  const key = (x: number, y: number) => y * W + x;

  let current = key(toX, toY);
  while (current !== key(fromX, fromY)) {
    const x = current % W;
    const y = Math.floor(current / W);
    path.unshift({ x, y });
    const prev = cameFrom.get(current);
    if (prev === undefined) break;
    current = prev;
  }
  path.unshift({ x: fromX, y: fromY });
  return path;
}

// ─── Reachability check ─────────────────────────────────────────────────────────

// ─── Find nearest workbench by walking, not by Manhattan ───────────────────────
//
// Phase 3 fix: the previous version used a Manhattan BFS through
// impassable tiles (walls, partitions), so a unit behind a wall
// could be told to "walk" to a workbench that was actually
// unreachable. We now use Dijkstra with the same cost table as
// findPath, so the result respects aisles and walls and reports
// the true walking distance.

export function findNearestWorkbench(
  world: LocalWorld,
  fromX: number,
  fromY: number,
  forUnitId?: string,
): { x: number; y: number; workbench: LocalTile['workbench']; distance: number } | null {
  const { grid } = world;
  const H = grid.length;
  const W = grid[0]?.length ?? 0;
  if (fromX < 0 || fromY < 0 || fromX >= W || fromY >= H) return null;

  // Desks assigned to OTHER units are taken — skip them while anything
  // free (or our own) remains reachable; fall back to them only when the
  // preferred sweep finds nothing.
  const isTakenByOther = (x: number, y: number): boolean => {
    if (!forUnitId) return false;
    const owner = world.deskAssignments.get(`${x},${y}`);
    return owner !== undefined && owner !== forUnitId;
  };
  let fallback: { x: number; y: number; workbench: LocalTile['workbench']; distance: number } | null =
    null;

  const cost = (x: number, y: number): number => {
    const t = grid[y]?.[x];
    if (!t) return Infinity;
    // Use the same TILE_COST default (1) that findPath uses, so
    // unknown tile types don't accidentally become impassable
    // here. Walls, partitions, and the office fixtures listed in
    // TILE_COST are still impassable; everything else walks at
    // cost 1. This keeps findNearestWorkbench in lockstep with
    // findPath — they should agree on what is walkable.
    return TILE_COST[t.type] ?? 1;
  };

  // Dijkstra with a binary heap. We stop as soon as we pop a
  // workbench-bearing tile — first pop is the nearest walkable
  // workbench, not the nearest by air-distance.
  const dist = new Map<number, number>();
  const heap: Array<{ x: number; y: number; d: number }> = [
    { x: fromX, y: fromY, d: 0 },
  ];
  const k = (x: number, y: number) => y * W + x;
  dist.set(k(fromX, fromY), 0);

  const dirs: Array<[number, number]> = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];

  while (heap.length > 0) {
    // Pop the cheapest.
    let bestIdx = 0;
    for (let i = 1; i < heap.length; i++) {
      if (heap[i]!.d < heap[bestIdx]!.d) bestIdx = i;
    }
    const cur = heap.splice(bestIdx, 1)[0]!;

    // Stale entry (we may have already settled this tile cheaper).
    const known = dist.get(k(cur.x, cur.y));
    if (known !== undefined && cur.d > known) continue;

    // First time we settle a workbench tile, we have the
    // nearest-by-walk.
    if (cur.x !== fromX || cur.y !== fromY) {
      const tile = grid[cur.y]![cur.x]!;
      if (tile.workbench) {
        const found = {
          x: cur.x,
          y: cur.y,
          workbench: tile.workbench,
          distance: cur.d,
        };
        if (!isTakenByOther(cur.x, cur.y)) return found;
        fallback = fallback ?? found; // nearest taken desk, last resort
      }
    }

    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const step = cost(nx, ny);
      if (!Number.isFinite(step)) continue; // impassable
      const nd = cur.d + step;
      const key = k(nx, ny);
      const prev = dist.get(key);
      if (prev !== undefined && nd >= prev) continue;
      dist.set(key, nd);
      heap.push({ x: nx, y: ny, d: nd });
    }
  }
  return fallback;
}
