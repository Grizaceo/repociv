import { describe, expect, it } from 'vitest';
import { DirectionalLight } from 'three';

import {
  createHexWorldScene,
  disposeHexWorldScene,
  terrainMeshSignature,
  updateHexWorldScene,
  wonderVisibilityForLayers,
} from './HexWorldScene.ts';
import type { Terrain, Tile } from '../types.ts';

function makeTile(q: number, r: number, terrain: Terrain = 'plains'): Tile {
  return {
    coord: { q, r },
    terrain,
    resources: { gold: 0, science: 0, production: 0 },
    inFog: false,
    revealed: true,
  };
}

describe('terrainMeshSignature', () => {
  it('changes when the terrain of a hex changes (painting keeps the tile keys)', () => {
    const before = [makeTile(0, 0, 'plains'), makeTile(1, 0, 'forest')];
    const after = [makeTile(0, 0, 'mountain'), makeTile(1, 0, 'forest')];
    expect(terrainMeshSignature(before)).not.toBe(terrainMeshSignature(after));
  });

  it('is stable for the same tiles, so colour-only frames keep the fast path', () => {
    expect(terrainMeshSignature([makeTile(0, 0, 'plains')])).toBe(
      terrainMeshSignature([makeTile(0, 0, 'plains')]),
    );
  });
});

describe('HexWorldScene sun stability', () => {
  it('keeps the directional sun position fixed across updates so city walls do not visually swim', () => {
    const scene = createHexWorldScene();
    const sun = scene.children.find((child) => child instanceof DirectionalLight) as
      DirectionalLight | undefined;

    expect(sun).toBeDefined();
    const start = sun!.position.clone();

    updateHexWorldScene(
      scene,
      {} as never,
      {
        animTime: 0,
        dt: 0,
        lod: 'high',
        fogEnabled: true,
        showStructure: true,
        showOps: true,
        showLabels: true,
      } as never,
      {} as never,
      false,
    );
    const afterFirst = sun!.position.clone();

    updateHexWorldScene(
      scene,
      {} as never,
      {
        animTime: 500,
        dt: 0,
        lod: 'high',
        fogEnabled: true,
        showStructure: true,
        showOps: true,
        showLabels: true,
      } as never,
      {} as never,
      false,
    );
    const afterSecond = sun!.position.clone();

    expect(afterFirst.toArray()).toEqual(start.toArray());
    expect(afterSecond.toArray()).toEqual(start.toArray());

    disposeHexWorldScene(scene);
  });
});

describe('HexWorldScene wonder layer visibility', () => {
  it('shows wonder models exactly when the structure layer is visible', () => {
    expect(wonderVisibilityForLayers({ showStructure: true })).toEqual({ generic: true });
    expect(wonderVisibilityForLayers({ showStructure: false })).toEqual({ generic: false });
  });
});
