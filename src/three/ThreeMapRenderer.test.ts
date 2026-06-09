import { describe, it, expect } from 'vitest';
import { computeWorldSignature } from './ThreeMapRenderer.ts';
import { type GameState } from '../game.ts';
import { type City, type Unit, type Tile } from '../types.ts';
import { type Axial } from '../hex.ts';

// Minimal GameState factory that satisfies the contract used by
// computeWorldSignature. We only need world.tiles / world.cities /
// world.units; the rest of GameState is irrelevant.
function makeState(opts: {
  tiles?: Array<[Axial, Tile]>;
  cities?: City[];
  units?: Unit[];
} = {}): GameState {
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

  it('signature has the expected layout: counts then id lists', () => {
    const s = makeState({
      cities: [mkCity('c1', 0, 0), mkCity('c2', 1, 1)],
      units: [mkUnit('u1', 2, 2)],
    });
    const sig = computeWorldSignature(s);
    // 0 tiles, 2 cities, 1 unit, joined id lists separated by '#'.
    expect(sig).toMatch(/^0#2#1#c1\|c2#u1$/);
  });
});
