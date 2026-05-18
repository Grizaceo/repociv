// ─── RepoCiv — Local Pathfinder (A* grid, 4-directional) ─────────────────────
// Used for agents walking inside a LocalWorld grid.

import type { LocalWorld, LocalTile } from './types.ts';

// ─── Cost table per tile type ─────────────────────────────────────────────────
const TILE_COST: Record<string, number> = {
  floor: 1,
  door: 2, // slower through doors
  workbench: 1,
  debris: 5, // very slow
  wall: Infinity, // impassable
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

// ─── Find nearest workbench tile (or nearest floor tile matching predicate) ──────

function findNearestTile(
  world: LocalWorld,
  fromX: number,
  fromY: number,
  predicate: (t: LocalTile) => boolean,
): { x: number; y: number; distance: number } | null {
  // BFS from (fromX, fromY) to find nearest tile matching predicate
  const visited = new Set<string>();
  const queue: Array<{ x: number; y: number; dist: number }> = [{ x: fromX, y: fromY, dist: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const key = `${cur.x},${cur.y}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (cur.y >= 0 && cur.y < world.grid.length && cur.x >= 0 && cur.x < world.grid[0]!.length) {
      const tile = world.grid[cur.y]![cur.x]!;
      if (predicate(tile)) {
        return { x: cur.x, y: cur.y, distance: cur.dist };
      }
    }
    // neighbors
    const W = world.grid[0]?.length ?? 0;
    const H = world.grid.length;
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (const [dx, dy] of dirs) {
      if (dx === undefined || dy === undefined) continue;
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      // Bounds check antes del push — sin esto, la BFS expande hacia
      // coordenadas infinitas cuando el predicado nunca se cumple.
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      queue.push({ x: nx, y: ny, dist: cur.dist + 1 });
    }
  }
  return null;
}

export function findNearestWorkbench(
  world: LocalWorld,
  fromX: number,
  fromY: number,
): { x: number; y: number; workbench: LocalTile['workbench']; distance: number } | null {
  const result = findNearestTile(
    world,
    fromX,
    fromY,
    (t) => t.type === 'workbench' && t.workbench !== null,
  );
  if (!result) return null;
  const tile = world.grid[result.y]![result.x]!;
  return { x: result.x, y: result.y, workbench: tile.workbench, distance: result.distance };
}
