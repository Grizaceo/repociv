import { describe, it, expect } from 'vitest';
import { createHexPrismGeometry, sharedFlatHexGeometry, sharedHexGeometry } from './hexGeometry.ts';

describe('createHexPrismGeometry', () => {
  it('top-facing triangles have normals pointing +Y', () => {
    const geom = createHexPrismGeometry(50, 8);
    const positions = geom.getAttribute('position').array as Float32Array;
    const normals = geom.getAttribute('normal').array as Float32Array;

    let upwardCount = 0;
    for (let i = 0; i < positions.length; i += 9) {
      const ny = normals[i + 4]!;
      if (ny > 0.85) {
        upwardCount++;
      }
    }
    // Bevel geometry: inner top (4) + top bevel ring (12) = 16 upward-facing tris
    // Full-radius top: 4 upward-facing tris only
    expect(upwardCount).toBeGreaterThanOrEqual(4);
  });

  it('provides UVs for every vertex in 0..1 range', () => {
    const geom = createHexPrismGeometry(50, 8);
    const positions = geom.getAttribute('position');
    const uv = geom.getAttribute('uv');
    expect(uv).toBeDefined();
    expect(uv.count).toBe(positions.count);
    const arr = uv.array as Float32Array;
    for (const value of arr) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('uses a subdivided full-radius top face with an inner plateau for seamless flat-top tiling', () => {
    const geom = createHexPrismGeometry(50, 8);
    const posAttr = geom.getAttribute('position');
    const count = posAttr.count;
    // Subdivided prism: 96 top + 4 bottom + 48 side = 148 triangles = 444 vertices
    expect(count).toBe(444);

    // Verify interior plateau vertices exist within r <= 0.55 * circumradius so
    // neighbor elevation ramps at the outer rim never tent across tile centres.
    const arr = posAttr.array as Float32Array;
    let innerPlateauVerts = 0;
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i]!;
      const y = arr[i + 1]!;
      const z = arr[i + 2]!;
      if (y === 0 && Math.hypot(x, z) <= 50 * 0.56) {
        innerPlateauVerts++;
      }
    }
    expect(innerPlateauVerts).toBeGreaterThan(30);
  });

  it('exports shared geometry with default size', () => {
    expect(sharedHexGeometry).toBeDefined();
    expect(sharedHexGeometry.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('builds an unsubdivided 20-triangle prism with the same footprint for fog meshes', () => {
    // 4 top + 4 bottom + 6 sides × 2 = 20 triangles = 60 vertices.
    expect(sharedFlatHexGeometry.getAttribute('position').count).toBe(60);
    sharedFlatHexGeometry.computeBoundingBox();
    sharedHexGeometry.computeBoundingBox();
    expect(sharedFlatHexGeometry.boundingBox).toEqual(sharedHexGeometry.boundingBox);
  });
});
