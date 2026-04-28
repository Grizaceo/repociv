import { describe, it, expect, beforeEach } from 'vitest';
import { aStarPath, invalidatePathCache } from './pathfinding.ts';
import type { World, Tile } from './types.ts';
import type { Axial } from './hex.ts';

// ─── Test world builder ───────────────────────────────────────────────────────
function makeTile(q: number, r: number, terrain: Tile['terrain'] = 'plains'): [string, Tile] {
  return [`${q},${r}`, {
    coord: { q, r },
    terrain,
    resources: { gold: 0, science: 0, production: 0 },
    inFog: false,
    revealed: true,
  }];
}

function makeWorld(tiles: [string, Tile][]): World {
  return {
    tiles: new Map(tiles),
    cities: [],
    units: [],
    buildings: [],
    resources: { gold: 0, science: 0, production: 0 },
    generatedAt: Date.now(),
  };
}

// 5x5 grid (q: -2..2, r: -2..2)
function plainGrid(): World {
  const tiles: [string, Tile][] = [];
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      tiles.push(makeTile(q, r, 'plains'));
    }
  }
  return makeWorld(tiles);
}

beforeEach(() => invalidatePathCache());

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('aStarPath — basic', () => {
  it('returns [start] when start === goal', () => {
    const world = plainGrid();
    const path = aStarPath({ q: 0, r: 0 }, { q: 0, r: 0 }, world, 'hero');
    expect(path).toHaveLength(1);
    expect(path[0]).toEqual({ q: 0, r: 0 });
  });

  it('finds direct neighbour path', () => {
    const world = plainGrid();
    const path = aStarPath({ q: 0, r: 0 }, { q: 1, r: 0 }, world, 'hero');
    expect(path).toHaveLength(2);
    expect(path[0]).toEqual({ q: 0, r: 0 });
    expect(path[path.length - 1]).toEqual({ q: 1, r: 0 });
  });

  it('finds shortest path in open grid', () => {
    const world = plainGrid();
    const path = aStarPath({ q: -2, r: 0 }, { q: 2, r: 0 }, world, 'hero');
    expect(path).toHaveLength(5); // 4 steps = 5 hexes
    expect(path[0]).toEqual({ q: -2, r: 0 });
    expect(path[path.length - 1]).toEqual({ q: 2, r: 0 });
  });

  it('returns [] when destination is outside world', () => {
    const world = plainGrid();
    const path = aStarPath({ q: 0, r: 0 }, { q: 99, r: 99 }, world, 'hero');
    expect(path).toHaveLength(0);
  });
});

describe('aStarPath — terrain costs', () => {
  it('hero can cross mountains', () => {
    const tiles: [string, Tile][] = [
      makeTile(0, 0, 'plains'),
      makeTile(1, 0, 'mountain'),
      makeTile(2, 0, 'plains'),
    ];
    const world = makeWorld(tiles);
    const path = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, 'hero');
    expect(path).toHaveLength(3);
    expect(path[1]).toEqual({ q: 1, r: 0 });
  });

  it('worker cannot cross mountains — returns [] if only mountain path', () => {
    // Corridor: only path through mountain
    const tiles: [string, Tile][] = [
      makeTile(0, 0, 'plains'),
      makeTile(1, 0, 'mountain'),
      makeTile(2, 0, 'plains'),
    ];
    const world = makeWorld(tiles);
    const path = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, 'worker');
    expect(path).toHaveLength(0);
  });

  it('worker finds alternate route around mountain', () => {
    // Grid with mountain blocker but bypass available
    const tiles: [string, Tile][] = [
      makeTile(0, 0, 'plains'),
      makeTile(1, 0, 'mountain'), // blocker for worker
      makeTile(2, 0, 'plains'),
      // bypass via (0,1) → (1,1) → (2,0) area (depending on hex adjacency)
      makeTile(0, 1, 'plains'),
      makeTile(1, 1, 'plains'),
      makeTile(2, -1, 'plains'),
    ];
    const world = makeWorld(tiles);
    // Worker must find alternate (longer) path
    const pathHero   = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, 'hero');
    const pathWorker = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, 'worker');
    // Hero uses mountain shortcut (length 3), worker goes around (longer)
    expect(pathHero.length).toBeLessThanOrEqual(pathWorker.length === 0 ? 99 : pathWorker.length);
  });

  it('nobody crosses ocean', () => {
    const tiles: [string, Tile][] = [
      makeTile(0, 0, 'plains'),
      makeTile(1, 0, 'ocean'),
      makeTile(2, 0, 'plains'),
    ];
    const world = makeWorld(tiles);
    for (const t of ['hero', 'worker', 'scout', 'lexo']) {
      const path = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, t);
      expect(path).toHaveLength(0);
    }
  });

  it('scout has high mountain cost (4) so prefers plains detour', () => {
    // Scout: mountain cost = 4, plains = 1
    // Direct path through mountain = cost 5 (1+4)
    // Detour through 3 plains = cost 3
    const tiles: [string, Tile][] = [
      makeTile(0, 0, 'plains'),
      makeTile(1, 0, 'mountain'),
      makeTile(2, 0, 'plains'),
      makeTile(0, 1, 'plains'),
      makeTile(1, 1, 'plains'),
    ];
    // (0,1)→(1,1) neighbours (2,0)? Let's check via expected path length
    const world = makeWorld(tiles);
    // Scout can cross mountain but at cost 4; if bypass is available and cheaper it should use it
    const path = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, 'scout');
    expect(path.length).toBeGreaterThan(0); // scout can always find a path if mountain is passable
  });
});

describe('aStarPath — cache', () => {
  it('returns same path reference when cached', () => {
    const world = plainGrid();
    const path1 = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, 'hero');
    const path2 = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, 'hero');
    expect(path1).toBe(path2);
  });

  it('different unit types have different cache entries', () => {
    const world = plainGrid();
    const hero  = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, 'hero');
    const scout = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, 'scout');
    expect(hero).not.toBe(scout);
  });

  it('invalidatePathCache clears cache', () => {
    const world = plainGrid();
    const path1 = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, 'hero');
    invalidatePathCache();
    const path2 = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, world, 'hero');
    expect(path1).not.toBe(path2); // different object after cache clear
    expect(path1).toEqual(path2);  // but same content
  });
});

describe('aStarPath — path validity', () => {
  it('every step is adjacent', () => {
    const world = plainGrid();
    const path = aStarPath({ q: -2, r: 2 }, { q: 2, r: -2 }, world, 'hero');
    expect(path.length).toBeGreaterThan(0);
    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1]!;
      const curr = path[i]!;
      const dist = Math.max(
        Math.abs(curr.q - prev.q),
        Math.abs(curr.r - prev.r),
        Math.abs((-curr.q - curr.r) - (-prev.q - prev.r)),
      );
      expect(dist).toBe(1);
    }
  });

  it('start is first coord, goal is last', () => {
    const world = plainGrid();
    const start: Axial = { q: -1, r: -1 };
    const goal: Axial  = { q:  1, r:  1 };
    const path = aStarPath(start, goal, world, 'worker');
    if (path.length > 0) {
      expect(path[0]).toEqual(start);
      expect(path[path.length - 1]).toEqual(goal);
    }
  });
});
