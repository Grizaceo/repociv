import { describe, expect, it } from 'vitest';
import { DirectionalLight } from 'three';

import { createHexWorldScene, disposeHexWorldScene, updateHexWorldScene } from './HexWorldScene.ts';

describe('HexWorldScene sun stability', () => {
  it('keeps the directional sun position fixed across updates so city walls do not visually swim', () => {
    const scene = createHexWorldScene();
    const sun = scene.children.find((child) => child instanceof DirectionalLight) as DirectionalLight | undefined;

    expect(sun).toBeDefined();
    const start = sun!.position.clone();

    updateHexWorldScene(
      scene,
      {} as never,
      { animTime: 0, dt: 0, lod: 'high', fogEnabled: true, showStructure: true, showOps: true, showLabels: true } as never,
      {} as never,
      false,
    );
    const afterFirst = sun!.position.clone();

    updateHexWorldScene(
      scene,
      {} as never,
      { animTime: 500, dt: 0, lod: 'high', fogEnabled: true, showStructure: true, showOps: true, showLabels: true } as never,
      {} as never,
      false,
    );
    const afterSecond = sun!.position.clone();

    expect(afterFirst.toArray()).toEqual(start.toArray());
    expect(afterSecond.toArray()).toEqual(start.toArray());

    disposeHexWorldScene(scene);
  });
});
