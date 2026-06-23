import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { axialToPixel, pixelToAxial, pixelToAxialFraction, axialRound } from '../hex.ts';
import { HEX_SIZE } from '../constants.ts';
import { terrainElevation } from '../isoHex.ts';
import { axialToWorld3D, world3DToAxialFraction, TILE_HEIGHT } from './axialToWorld3D.ts';

describe('axialToWorld3D', () => {
  it('maps 2D pixel coords to XZ with Y from elevation', () => {
    const coord = { q: 2, r: -1 };
    const elev = terrainElevation('mountain');
    const v = axialToWorld3D(coord.q, coord.r, elev);
    const flat = axialToPixel(coord, HEX_SIZE);
    expect(v.x).toBeCloseTo(flat.x, 5);
    expect(v.z).toBeCloseTo(flat.y, 5);
    expect(v.y).toBeCloseTo(elev * TILE_HEIGHT, 5);
  });

  it('roundtrips world XZ back to the same axial coord', () => {
    const samples = [
      { q: 0, r: 0 },
      { q: 3, r: -2 },
      { q: -4, r: 5 },
    ];
    for (const coord of samples) {
      const elev = terrainElevation('hills');
      const v = axialToWorld3D(coord.q, coord.r, elev);
      const frac = world3DToAxialFraction(v.x, v.z);
      const rounded = axialRound(frac);
      expect(rounded).toEqual(coord);
    }
  });

  it('matches pixelToAxial at zero elevation', () => {
    const coord = { q: 1, r: 2 };
    const v = axialToWorld3D(coord.q, coord.r, 0);
    const fromPixel = pixelToAxial(v.x, v.z, HEX_SIZE);
    expect(fromPixel).toEqual(coord);
  });

  it('returns a Vector3 instance', () => {
    const v = axialToWorld3D(0, 0, 0);
    expect(v).toBeInstanceOf(Vector3);
  });

  it('world3DToAxialFraction delegates to the shared 2D fraction at HEX_SIZE', () => {
    for (const [x, z] of [
      [0, 0],
      [50.5, -22.25],
      [-300, 175],
    ] as const) {
      expect(world3DToAxialFraction(x, z)).toEqual(pixelToAxialFraction(x, z, HEX_SIZE));
    }
  });
});
