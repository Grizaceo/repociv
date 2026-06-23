import { describe, it, expect } from 'vitest';
import { computeWorldSignature } from './ThreeMapRenderer.ts';
import { type GameState } from '../game.ts';
import { type City, type Unit, type Tile } from '../types.ts';
import { type Axial } from '../hex.ts';

// Minimal GameState factory that satisfies the contract used by
// computeWorldSignature. We only need world.tiles / world.cities /
// world.units; the rest of GameState is irrelevant.
function makeState(
  opts: {
    tiles?: Array<[Axial, Tile]>;
    cities?: City[];
    units?: Unit[];
  } = {},
): GameState {
  const tiles = new Map<Axial, Tile>();
  for (const [k, v] of opts.tiles ?? []) tiles.set(k, v);
  return {
    world: {
      tiles,
      cities: opts.cities ?? [],
      units: opts.units ?? [],
    },
  } as unknown as GameState;
}

const mkCity = (id: string, q: number, r: number): City => ({
  id,
  name: id,
  coord: { q, r },
  population: 0,
  territory: [],
  districts: [],
  buildings: [],
  isCapital: false,
});

const mkUnit = (id: string, q: number, r: number): Unit => ({
  id,
  name: id,
  type: 'worker',
  civ: 'gris',
  coord: { q, r },
  path: [],
  pathIndex: 0,
  pathProgress: 0,
  state: 'idle',
  speed: 1,
  color: '#fff',
  movesLeft: 1,
  maxMoves: 1,
  fatigue: 0,
  maxFatigue: 100,
  isResting: false,
  effectiveSpeed: 1,
});

const mkTile = (q: number, r: number): Tile => ({
  coord: { q, r },
  terrain: 'plains',
  resources: { gold: 0, science: 0, production: 0 },
  inFog: false,
  revealed: true,
});

describe('computeWorldSignature', () => {
  it('is stable for the same world state', () => {
    const a = makeState({
      cities: [mkCity('c1', 0, 0)],
      units: [mkUnit('u1', 1, 0)],
    });
    const b = makeState({
      cities: [mkCity('c1', 0, 0)],
      units: [mkUnit('u1', 1, 0)],
    });
    expect(computeWorldSignature(a)).toBe(computeWorldSignature(b));
  });

  it('changes when a city is added', () => {
    const a = makeState({ cities: [] });
    const b = makeState({ cities: [mkCity('c1', 0, 0)] });
    expect(computeWorldSignature(a)).not.toBe(computeWorldSignature(b));
  });

  it('changes when a unit is added', () => {
    const a = makeState({ units: [] });
    const b = makeState({ units: [mkUnit('u1', 0, 0)] });
    expect(computeWorldSignature(a)).not.toBe(computeWorldSignature(b));
  });

  it('changes when a city id changes (different id -> different)', () => {
    const a = makeState({ cities: [mkCity('c1', 0, 0)] });
    const b = makeState({ cities: [mkCity('c2', 0, 0)] });
    expect(computeWorldSignature(a)).not.toBe(computeWorldSignature(b));
  });

  it('changes when tile count changes', () => {
    const a = makeState();
    const tile = mkTile(0, 0);
    const b = makeState({ tiles: [[{ q: 0, r: 0 }, tile]] });
    expect(computeWorldSignature(a)).not.toBe(computeWorldSignature(b));
  });

  // Units move (and change state) without changing id — the signature
  // must catch that, or unit meshes freeze mid-path in WebGL mode.
  it('changes when a unit moves to another hex', () => {
    const a = makeState({ units: [mkUnit('u1', 0, 0)] });
    const b = makeState({ units: [{ ...mkUnit('u1', 0, 0), coord: { q: 1, r: 0 } }] });
    expect(computeWorldSignature(a)).not.toBe(computeWorldSignature(b));
  });

  it('changes when a unit changes state (idle → working)', () => {
    const a = makeState({ units: [mkUnit('u1', 0, 0)] });
    const b = makeState({ units: [{ ...mkUnit('u1', 0, 0), state: 'working' as const }] });
    expect(computeWorldSignature(a)).not.toBe(computeWorldSignature(b));
  });

  // Fog reveals flip tile.revealed/inFog without changing tile count —
  // the terrain mesh tints by fog, so the signature must catch it.
  it('changes when a tile is revealed', () => {
    const hidden = { ...mkTile(0, 0), revealed: false };
    const shown = { ...mkTile(0, 0), revealed: true };
    const a = makeState({ tiles: [[{ q: 0, r: 0 }, hidden]] });
    const b = makeState({ tiles: [[{ q: 0, r: 0 }, shown]] });
    expect(computeWorldSignature(a)).not.toBe(computeWorldSignature(b));
  });

  it('stays cheap on large maps (runs at 60fps in the render loop)', () => {
    // 1200 tiles + 60 units ≈ a worst-case workspace. The signature runs
    // every frame; at 60fps it has ~16ms of TOTAL budget, so it must cost
    // a small fraction of a millisecond. 2ms bound: the 0.5ms version
    // flaked whenever the dev box ran Blender bakes / Playwright audits
    // alongside the suite (observed 0.88ms under load, ~0.1ms idle).
    // 2ms still catches accidental quadratic work by an order of
    // magnitude while surviving a loaded machine.
    const tiles: Array<[Axial, Tile]> = [];
    for (let q = 0; q < 40; q++) {
      for (let r = 0; r < 30; r++) {
        tiles.push([
          { q, r },
          { ...mkTile(q, r), revealed: (q + r) % 3 !== 0 },
        ]);
      }
    }
    const units = Array.from({ length: 60 }, (_, i) => mkUnit(`u${i}`, i % 40, i % 30));
    const cities = Array.from({ length: 12 }, (_, i) => mkCity(`c${i}`, i, i));
    const s = makeState({ tiles, units, cities });

    computeWorldSignature(s); // warm up
    const N = 200;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) computeWorldSignature(s);
    const avgMs = (performance.now() - t0) / N;
    expect(avgMs).toBeLessThan(2);
  });

  it('changes when city territory grows', () => {
    const small = mkCity('c1', 0, 0);
    const grown = { ...mkCity('c1', 0, 0), territory: [{ q: 1, r: 0 }] };
    const a = makeState({ cities: [small] });
    const b = makeState({ cities: [grown] });
    expect(computeWorldSignature(a)).not.toBe(computeWorldSignature(b));
  });
});
